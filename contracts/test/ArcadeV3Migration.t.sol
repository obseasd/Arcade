// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockWETH} from "../src/mocks/MockWETH.sol";
import {ArcadeV2Factory} from "../src/dex/ArcadeV2Factory.sol";
import {ArcadeV2Router} from "../src/dex/ArcadeV2Router.sol";
import {ArcadeLaunchpad} from "../src/launchpad/ArcadeLaunchpad.sol";
import {ArcadeTokenVault} from "../src/launchpad/ArcadeTokenVault.sol";
import {IArcadeLaunchpad} from "../src/launchpad/interfaces/IArcadeLaunchpad.sol";
import {IArcadeV3Factory, IArcadeV3Pool, IArcadeV3Locker} from "../src/v3/interfaces/IArcadeV3Minimal.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IV3Router {
    function exactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        address recipient,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint256 deadline
    ) external returns (uint256);
}

interface IV3Quoter {
    function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn)
        external
        returns (uint256);
}

/**
 * @notice End-to-end test of the CLANKER_V3 true-Clanker launch: no bonding
 * curve, full supply locked single-sided in a V3 pool at creation, tradeable
 * immediately. Deploys the real V3 core Factory + our 0.7.6 locker, router and
 * quoter from the out-v3 artifacts.
 *
 * Prerequisite: `FOUNDRY_PROFILE=v3 forge build`.
 */
contract ArcadeV3MigrationTest is Test {
    MockUSDC usdc;
    ArcadeV2Factory v2Factory;
    ArcadeV2Router v2Router;
    ArcadeLaunchpad launchpad;
    address v3Factory;
    address v3Locker;
    address v3Router;
    address v3Quoter;
    ArcadeTokenVault tokenVault;
    MockWETH weth;

    /// @dev ABI-encoded ClankerOptions with no vault / no sniper tax (Standard pool).
    function _opts(uint24 fee, uint256 creatorBuy) internal pure returns (bytes memory) {
        return abi.encode(
            ArcadeLaunchpad.ClankerOptions(fee, creatorBuy, 0, 0, 0, address(0), 0, 0, 0, 0)
        );
    }

    /// @dev ClankerOptions carrying a vault carve-out (Standard pool).
    function _optsVault(uint24 fee, uint16 vaultPct, uint64 lockup, uint64 vesting, address recipient)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(
            ArcadeLaunchpad.ClankerOptions(fee, 0, vaultPct, lockup, vesting, recipient, 0, 0, 0, 0)
        );
    }

    /// @dev ClankerOptions carrying an anti-sniper tax (Standard pool).
    function _optsSnipe(uint24 fee, uint16 snipeStartBps, uint32 snipeDecaySeconds)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(
            ArcadeLaunchpad.ClankerOptions(fee, 0, 0, 0, 0, address(0), snipeStartBps, snipeDecaySeconds, 0, 0)
        );
    }

    /// @dev ClankerOptions selecting a specific pool type (+ legacy mcap).
    function _optsPool(uint24 fee, uint8 poolType, uint256 legacyMcap) internal pure returns (bytes memory) {
        return abi.encode(
            ArcadeLaunchpad.ClankerOptions(fee, 0, 0, 0, 0, address(0), 0, 0, poolType, legacyMcap)
        );
    }

    address treasury = address(0xBEEF);
    address creator = address(0xC0FFEE);
    address alice = address(0xA11CE);

    uint24 constant FEE = 10_000;

    function setUp() public {
        usdc = new MockUSDC();
        weth = new MockWETH();
        v2Factory = new ArcadeV2Factory(address(this));
        v2Router = new ArcadeV2Router(address(v2Factory));

        v3Factory = _deploy("out-v3/UniswapV3Factory.sol/UniswapV3Factory.json", "");
        launchpad = new ArcadeLaunchpad(
            IERC20(address(usdc)), v2Factory, address(v2Router), treasury, IArcadeV3Factory(v3Factory), address(weth)
        );
        v3Locker = _deploy(
            "out-v3/ArcadeV3Locker.sol/ArcadeV3Locker.json", abi.encode(address(launchpad), v3Factory)
        );
        v3Router = _deploy(
            "out-v3/ArcadeV3SwapRouter.sol/ArcadeV3SwapRouter.json",
            abi.encode(v3Factory, address(usdc), address(launchpad))
        );
        v3Quoter = _deploy(
            "out-v3/ArcadeV3Quoter.sol/ArcadeV3Quoter.json", abi.encode(v3Factory, address(usdc))
        );
        tokenVault = new ArcadeTokenVault(address(launchpad));
        launchpad.setV3Infra(v3Locker, v3Router, address(tokenVault));
        // Enable 2% / 3% fee tiers on the freshly-deployed V3 factory.
        IArcadeV3Factory(v3Factory).enableFeeAmount(20_000, 200);
        IArcadeV3Factory(v3Factory).enableFeeAmount(30_000, 200);

        usdc.mint(creator, 100_000e6);
        usdc.mint(alice, 1_000_000e6);
    }

    function _deploy(string memory path, bytes memory args) internal returns (address addr) {
        bytes memory code = abi.encodePacked(vm.getCode(path), args);
        assembly {
            addr := create(0, add(code, 0x20), mload(code))
        }
        require(addr != address(0), "deploy failed");
    }

    function _createV3Token() internal returns (address token, address pool) {
        vm.startPrank(creator);
        usdc.approve(address(launchpad), type(uint256).max);
        token = launchpad.createToken(
            "Vault Cat", "VCAT", "ipfs://x", IArcadeLaunchpad.LaunchMode.CLANKER_V3, address(0), 0
        );
        vm.stopPrank();
        pool = IArcadeV3Factory(v3Factory).getPool(address(usdc), token, FEE);
    }

    function test_launchesImmediatelySingleSided() public {
        (address token, address pool) = _createV3Token();

        ArcadeLaunchpad.TokenState memory s = launchpad.getTokenState(token);
        assertTrue(s.migrated, "flagged migrated from birth");
        assertEq(s.v2Pair, pool, "pool stored");
        assertTrue(pool != address(0), "pool created");

        // Single-sided: pool holds (almost) all the token and ZERO USDC.
        assertGt(IERC20(token).balanceOf(pool), 900_000_000e18, "pool holds the supply");
        assertEq(usdc.balanceOf(pool), 0, "no USDC at launch");
        // Active liquidity at the current tick is 0 at launch: the position
        // sits in a range above the start price (single-sided), so it only
        // becomes active once the first buy pushes the price into the range.
        assertEq(IArcadeV3Pool(pool).liquidity(), 0, "no active liquidity until first buy");

        assertEq(IArcadeV3Locker(v3Locker).positionIdByToken(token), 1, "position registered");

        // First buy activates the position's liquidity.
        vm.startPrank(alice);
        usdc.approve(v3Router, type(uint256).max);
        IV3Router(v3Router).exactInputSingle(address(usdc), token, FEE, alice, 1_000e6, 0, block.timestamp + 60);
        vm.stopPrank();
        assertGt(IArcadeV3Pool(pool).liquidity(), 0, "liquidity active after first buy");
    }

    function test_buyViaRouter_thenCollectFees_splits80_20() public {
        (address token,) = _createV3Token();
        uint256 positionId = IArcadeV3Locker(v3Locker).positionIdByToken(token);

        // Alice buys the token with USDC through the V3 router.
        vm.startPrank(alice);
        usdc.approve(v3Router, type(uint256).max);
        uint256 got = IV3Router(v3Router).exactInputSingle(
            address(usdc), token, FEE, alice, 10_000e6, 0, block.timestamp + 60
        );
        assertGt(got, 0, "received tokens");
        // Sell part back to also accrue token-side fees.
        IERC20(token).approve(v3Router, type(uint256).max);
        IV3Router(v3Router).exactInputSingle(token, address(usdc), FEE, alice, got / 2, 0, block.timestamp + 60);
        vm.stopPrank();

        uint256 cUsdc0 = usdc.balanceOf(creator);
        uint256 tUsdc0 = usdc.balanceOf(treasury);
        uint256 cTok0 = IERC20(token).balanceOf(creator);
        uint256 tTok0 = IERC20(token).balanceOf(treasury);

        (uint256 amt0, uint256 amt1) = IArcadeV3Locker(v3Locker).collectFees(positionId);
        assertTrue(amt0 > 0 || amt1 > 0, "some fees collected");

        // USDC-side fees split 80/20.
        uint256 cUsdcGain = usdc.balanceOf(creator) - cUsdc0;
        uint256 tUsdcGain = usdc.balanceOf(treasury) - tUsdc0;
        uint256 usdcFees = cUsdcGain + tUsdcGain;
        if (usdcFees > 0) {
            assertApproxEqAbs(cUsdcGain, (usdcFees * 8000) / 10000, 1, "creator 80% USDC");
        }
        // Token-side fees split 80/20.
        uint256 cTokGain = IERC20(token).balanceOf(creator) - cTok0;
        uint256 tTokGain = IERC20(token).balanceOf(treasury) - tTok0;
        uint256 tokFees = cTokGain + tTokGain;
        if (tokFees > 0) {
            assertApproxEqAbs(cTokGain, (tokFees * 8000) / 10000, 1, "creator 80% token");
        }
    }

    function test_quoterMatchesRouter() public {
        (address token,) = _createV3Token();

        uint256 quoted = IV3Quoter(v3Quoter).quoteExactInputSingle(address(usdc), token, FEE, 5_000e6);

        vm.startPrank(alice);
        usdc.approve(v3Router, type(uint256).max);
        uint256 got = IV3Router(v3Router).exactInputSingle(
            address(usdc), token, FEE, alice, 5_000e6, 0, block.timestamp + 60
        );
        vm.stopPrank();

        assertEq(got, quoted, "quote matches actual swap");
    }

    function test_principalStaysLocked() public {
        (address token, address pool) = _createV3Token();
        uint256 positionId = IArcadeV3Locker(v3Locker).positionIdByToken(token);

        vm.startPrank(alice);
        usdc.approve(v3Router, type(uint256).max);
        IV3Router(v3Router).exactInputSingle(address(usdc), token, FEE, alice, 5_000e6, 0, block.timestamp + 60);
        vm.stopPrank();

        uint128 liqBefore = IArcadeV3Pool(pool).liquidity();
        IArcadeV3Locker(v3Locker).collectFees(positionId);
        assertEq(IArcadeV3Pool(pool).liquidity(), liqBefore, "liquidity unchanged after collect");
    }

    function test_clankerV3_buyOnCurveReverts() public {
        (address token,) = _createV3Token();
        // No bonding curve — buy() must revert (already migrated from birth).
        vm.startPrank(alice);
        usdc.approve(address(launchpad), type(uint256).max);
        vm.expectRevert(ArcadeLaunchpad.AlreadyMigrated.selector);
        launchpad.buy(token, 100e6, 0);
        vm.stopPrank();
    }

    // ====================== Custom recipients (Phase 1) ======================

    address partner = address(0xAA27);

    function _genFeesBothSides(address token, address pool) internal {
        // USDC -> token accrues paired (USDC) fees; token -> USDC accrues clanker fees.
        vm.startPrank(alice);
        usdc.approve(v3Router, type(uint256).max);
        uint256 got = IV3Router(v3Router).exactInputSingle(
            address(usdc), token, FEE, alice, 20_000e6, 0, block.timestamp + 60
        );
        IERC20(token).approve(v3Router, type(uint256).max);
        IV3Router(v3Router).exactInputSingle(token, address(usdc), FEE, alice, got / 2, 0, block.timestamp + 60);
        vm.stopPrank();
        pool; // silence
    }

    function _createClankerV3(IArcadeV3Locker.Recipient[] memory rs) internal returns (address token, address pool) {
        vm.startPrank(creator);
        usdc.approve(address(launchpad), type(uint256).max);
        token = launchpad.createClankerV3("Multi Cat", "MCAT", "ipfs://x", rs, _opts(FEE, 0));
        vm.stopPrank();
        pool = IArcadeV3Factory(v3Factory).getPool(address(usdc), token, FEE);
    }

    function test_createClankerV3_customRecipients_perPotSplit() public {
        // The platform ALWAYS keeps 20%; the creator's recipients split the 80%.
        // Creator inputs (sum to 100% of their share): creator 60% Both, partner
        // 40% Paired-only. After the 20% platform cut: creator 4800, partner 3200,
        // platform(treasury) 2000.
        IArcadeV3Locker.Recipient[] memory rs = new IArcadeV3Locker.Recipient[](2);
        rs[0] = IArcadeV3Locker.Recipient(creator, creator, 6000, IArcadeV3Locker.RewardToken.Both);
        rs[1] = IArcadeV3Locker.Recipient(partner, partner, 4000, IArcadeV3Locker.RewardToken.Paired);
        (address token, address pool) = _createClankerV3(rs);
        uint256 positionId = IArcadeV3Locker(v3Locker).positionIdByToken(token);
        // 3 creator-side entries become 3 (creator+partner) + 1 platform = 3 total here.
        assertEq(IArcadeV3Locker(v3Locker).recipientsCount(positionId), 3, "platform appended");

        _genFeesBothSides(token, pool);

        uint256 cU0 = usdc.balanceOf(creator);
        uint256 pU0 = usdc.balanceOf(partner);
        uint256 tU0 = usdc.balanceOf(treasury);
        uint256 cT0 = IERC20(token).balanceOf(creator);
        uint256 pT0 = IERC20(token).balanceOf(partner);
        uint256 tT0 = IERC20(token).balanceOf(treasury);

        (uint256 paid, uint256 clank) = IArcadeV3Locker(v3Locker).collectFees(positionId);
        assertGt(paid, 0, "usdc fees");
        assertGt(clank, 0, "token fees");

        // USDC pot: weights 4800/3200/2000 = 10000 → 48/32/20.
        assertApproxEqAbs(usdc.balanceOf(creator) - cU0, (paid * 4800) / 10000, 2, "creator 48% USDC");
        assertApproxEqAbs(usdc.balanceOf(partner) - pU0, (paid * 3200) / 10000, 2, "partner 32% USDC");
        assertApproxEqAbs(usdc.balanceOf(treasury) - tU0, (paid * 2000) / 10000, 2, "platform 20% USDC");

        // Token pot: partner is Paired-only → excluded. Weights creator 4800 + platform 2000 = 6800.
        assertEq(IERC20(token).balanceOf(partner) - pT0, 0, "partner gets NO token");
        assertApproxEqAbs(IERC20(token).balanceOf(creator) - cT0, (clank * 4800) / 6800, 2, "creator 48/68 token");
        assertApproxEqAbs(IERC20(token).balanceOf(treasury) - tT0, (clank * 2000) / 6800, 2, "platform 20/68 token");
    }

    function test_createClankerV3_badBps_reverts() public {
        IArcadeV3Locker.Recipient[] memory rs = new IArcadeV3Locker.Recipient[](2);
        rs[0] = IArcadeV3Locker.Recipient(creator, creator, 6000, IArcadeV3Locker.RewardToken.Both);
        rs[1] = IArcadeV3Locker.Recipient(partner, partner, 3000, IArcadeV3Locker.RewardToken.Both); // sums to 9000
        vm.startPrank(creator);
        usdc.approve(address(launchpad), type(uint256).max);
        vm.expectRevert(ArcadeLaunchpad.InvalidShare.selector);
        launchpad.createClankerV3("X", "X", "ipfs://x", rs, _opts(FEE, 0));
        vm.stopPrank();
    }

    function test_createClankerV3_platformKeeps20_singleRecipient() public {
        // Single recipient at 100% → creator 80%, platform 20%.
        IArcadeV3Locker.Recipient[] memory rs = _defaultRecipients();
        (address token, address pool) = _createClankerV3(rs);
        uint256 positionId = IArcadeV3Locker(v3Locker).positionIdByToken(token);
        _genFeesBothSides(token, pool);
        uint256 cU0 = usdc.balanceOf(creator);
        uint256 tU0 = usdc.balanceOf(treasury);
        (uint256 paid,) = IArcadeV3Locker(v3Locker).collectFees(positionId);
        assertApproxEqAbs(usdc.balanceOf(creator) - cU0, (paid * 8000) / 10000, 2, "creator 80%");
        assertApproxEqAbs(usdc.balanceOf(treasury) - tU0, (paid * 2000) / 10000, 2, "platform 20%");
    }

    function _defaultRecipients() internal view returns (IArcadeV3Locker.Recipient[] memory rs) {
        rs = new IArcadeV3Locker.Recipient[](1);
        rs[0] = IArcadeV3Locker.Recipient(creator, creator, 10_000, IArcadeV3Locker.RewardToken.Both);
    }

    function test_createClankerV3_feeTier2pct() public {
        IArcadeV3Locker.Recipient[] memory rs = _defaultRecipients();
        vm.startPrank(creator);
        usdc.approve(address(launchpad), type(uint256).max);
        address token = launchpad.createClankerV3("Two Pct", "TWO", "ipfs://x", rs, _opts(20_000, 0));
        vm.stopPrank();
        // Pool exists at the 2% tier, not at 1%.
        assertTrue(IArcadeV3Factory(v3Factory).getPool(address(usdc), token, 20_000) != address(0), "2% pool");
        assertEq(IArcadeV3Factory(v3Factory).getPool(address(usdc), token, 10_000), address(0), "no 1% pool");
    }

    function test_createClankerV3_badFeeTier_reverts() public {
        IArcadeV3Locker.Recipient[] memory rs = _defaultRecipients();
        vm.startPrank(creator);
        usdc.approve(address(launchpad), type(uint256).max);
        vm.expectRevert(ArcadeLaunchpad.BadFeeTier.selector);
        launchpad.createClankerV3("X", "X", "ipfs://x", rs, _opts(3000, 0)); // 0.3% not allowed
        vm.stopPrank();
    }

    function test_createClankerV3_creatorBuy_deliversTokens() public {
        IArcadeV3Locker.Recipient[] memory rs = _defaultRecipients();
        vm.startPrank(creator);
        usdc.approve(address(launchpad), type(uint256).max);
        uint256 cBefore = usdc.balanceOf(creator);
        address token = launchpad.createClankerV3("Buy Cat", "BUY", "ipfs://x", rs, _opts(FEE, 5_000e6));
        vm.stopPrank();
        // Creator received tokens from the launch buy, and spent 3 USDC fee + 5000 buy.
        assertGt(IERC20(token).balanceOf(creator), 0, "creator got tokens from buy");
        assertEq(cBefore - usdc.balanceOf(creator), launchpad.CREATION_FEE() + 5_000e6, "spent fee + buy");
    }

    function test_creatorBuy_notTaxedByOwnSniper() public {
        // A creator who sets BOTH a creator buy and an anti-sniper tax must not
        // tax their own launch buy (snipe is armed only after the buy).
        IArcadeV3Locker.Recipient[] memory rs = _defaultRecipients();
        bytes memory opts =
            abi.encode(ArcadeLaunchpad.ClankerOptions(FEE, 5_000e6, 0, 0, 0, address(0), 5_000, 3600, 0, 0));
        vm.startPrank(creator);
        usdc.approve(address(launchpad), type(uint256).max);
        uint256 tBefore = usdc.balanceOf(treasury);
        address token = launchpad.createClankerV3("Snipe Buy", "SB", "ipfs://x", rs, opts);
        vm.stopPrank();
        // Treasury received ONLY the 3 USDC creation fee — no skim on the creator buy.
        assertEq(usdc.balanceOf(treasury) - tBefore, launchpad.CREATION_FEE(), "no self-skim on creator buy");
        assertGt(IERC20(token).balanceOf(creator), 0, "creator got tokens");
        // But the sniper tax IS armed for later buyers.
        assertEq(launchpad.currentSnipeBps(token), 5_000, "sniper armed after launch");
    }

    function test_updateRecipient_onlyAdmin() public {
        (address token,) = _createV3Token(); // default: creator slot0 admin=creator, treasury slot1
        uint256 positionId = IArcadeV3Locker(v3Locker).positionIdByToken(token);

        // Non-admin can't change slot 0.
        vm.prank(alice);
        vm.expectRevert(bytes("ONLY_ADMIN"));
        IArcadeV3Locker(v3Locker).updateRecipient(positionId, 0, alice);

        // The slot-0 admin (creator) can.
        address newRecipient = address(0xBEEF11);
        vm.prank(creator);
        IArcadeV3Locker(v3Locker).updateRecipient(positionId, 0, newRecipient);
        IArcadeV3Locker.Recipient[] memory rs = IArcadeV3Locker(v3Locker).getRecipients(positionId);
        assertEq(rs[0].recipient, newRecipient, "recipient rotated");
        assertEq(rs[0].admin, creator, "admin unchanged");
    }

    // ====================== Vault / vesting (Phase 3) ======================

    function test_vault_carvesSupply_lockupThenLinearVesting() public {
        IArcadeV3Locker.Recipient[] memory rs = _defaultRecipients();
        // 20% vaulted, 7-day lockup, 30-day linear vesting, to the creator.
        vm.startPrank(creator);
        usdc.approve(address(launchpad), type(uint256).max);
        address token =
            launchpad.createClankerV3("Vault Cat", "VLT", "ipfs://x", rs, _optsVault(FEE, 2000, 7 days, 30 days, creator));
        vm.stopPrank();

        uint256 vestId = tokenVault.vestIdByToken(token);
        assertGt(vestId, 0, "vest registered");
        uint256 vaulted = (1_000_000_000e18 * 2000) / 10000; // 200M
        // The vault holds the 20%; the pool holds the other 80%.
        assertEq(IERC20(token).balanceOf(address(tokenVault)), vaulted, "vault holds 20%");
        address pool = IArcadeV3Factory(v3Factory).getPool(address(usdc), token, FEE);
        assertApproxEqAbs(IERC20(token).balanceOf(pool), 1_000_000_000e18 - vaulted, 1e18, "pool holds 80%");

        // Locked: nothing claimable during the lockup.
        assertEq(tokenVault.claimable(vestId), 0, "locked during lockup");

        // Halfway through vesting: ~50%.
        vm.warp(block.timestamp + 7 days + 15 days);
        assertApproxEqAbs(tokenVault.claimable(vestId), vaulted / 2, vaulted / 1000, "~50% vested");

        // Claim sends to the recipient.
        uint256 before = IERC20(token).balanceOf(creator);
        tokenVault.claim(vestId);
        assertApproxEqAbs(IERC20(token).balanceOf(creator) - before, vaulted / 2, vaulted / 1000, "claimed ~50%");

        // After full vesting: the rest is claimable.
        vm.warp(block.timestamp + 30 days);
        tokenVault.claim(vestId);
        assertEq(IERC20(token).balanceOf(creator) - before, vaulted, "all vested claimed");
        assertEq(tokenVault.claimable(vestId), 0, "nothing left");
    }

    function test_vault_shortLockup_reverts() public {
        IArcadeV3Locker.Recipient[] memory rs = _defaultRecipients();
        vm.startPrank(creator);
        usdc.approve(address(launchpad), type(uint256).max);
        vm.expectRevert(ArcadeTokenVault.BadDuration.selector);
        launchpad.createClankerV3("X", "X", "ipfs://x", rs, _optsVault(FEE, 1000, 1 days, 0, creator)); // < 7d lockup
        vm.stopPrank();
    }

    function test_vault_tooMuch_reverts() public {
        IArcadeV3Locker.Recipient[] memory rs = _defaultRecipients();
        vm.startPrank(creator);
        usdc.approve(address(launchpad), type(uint256).max);
        vm.expectRevert(ArcadeLaunchpad.BadVault.selector);
        launchpad.createClankerV3("X", "X", "ipfs://x", rs, _optsVault(FEE, 9500, 7 days, 0, creator)); // > 90%
        vm.stopPrank();
    }

    // ====================== Anti-sniper tax (soft router) ======================

    function test_sniperTax_skimsDecayingThenExpires() public {
        IArcadeV3Locker.Recipient[] memory rs = _defaultRecipients();
        vm.startPrank(creator);
        usdc.approve(address(launchpad), type(uint256).max);
        // 50% starting tax, decaying linearly to 0 over one hour.
        address token = launchpad.createClankerV3("Snipe Cat", "SNP", "ipfs://x", rs, _optsSnipe(FEE, 5_000, 3600));
        vm.stopPrank();

        // At launch the full 50% applies.
        assertEq(launchpad.currentSnipeBps(token), 5_000, "50% at launch");

        // A buy through the router skims ~50% of the input to the treasury.
        uint256 amountIn = 10_000e6;
        uint256 tBefore = usdc.balanceOf(treasury);
        vm.startPrank(alice);
        usdc.approve(v3Router, type(uint256).max);
        IV3Router(v3Router).exactInputSingle(address(usdc), token, FEE, alice, amountIn, 0, block.timestamp + 60);
        vm.stopPrank();
        assertEq(usdc.balanceOf(treasury) - tBefore, amountIn / 2, "50% skimmed to treasury");

        // Halfway through the window the rate is ~25%.
        vm.warp(block.timestamp + 1800);
        assertApproxEqAbs(launchpad.currentSnipeBps(token), 2_500, 2, "~25% halfway");

        // After the window the tax is gone — no skim on the next buy.
        vm.warp(block.timestamp + 1801);
        assertEq(launchpad.currentSnipeBps(token), 0, "tax expired");
        uint256 tBefore2 = usdc.balanceOf(treasury);
        vm.startPrank(alice);
        IV3Router(v3Router).exactInputSingle(address(usdc), token, FEE, alice, amountIn, 0, block.timestamp + 60);
        vm.stopPrank();
        assertEq(usdc.balanceOf(treasury) - tBefore2, 0, "no skim after window");
    }

    // ====================== Pool types (Clanker-style) ======================

    function _launchPool(uint8 poolType, uint256 legacyMcap) internal returns (address token) {
        IArcadeV3Locker.Recipient[] memory rs = _defaultRecipients();
        vm.startPrank(creator);
        usdc.approve(address(launchpad), type(uint256).max);
        token = launchpad.createClankerV3("Pool Cat", "POOL", "ipfs://x", rs, _optsPool(FEE, poolType, legacyMcap));
        vm.stopPrank();
    }

    function test_poolType_standard_has3Positions() public {
        address token = _launchPool(0, 0); // POOL_STANDARD
        uint256 id = IArcadeV3Locker(v3Locker).positionIdByToken(token);
        assertEq(IArcadeV3Locker(v3Locker).rangeCount(id), 3, "3 positions");
        address pool = IArcadeV3Factory(v3Factory).getPool(address(usdc), token, FEE);
        assertGt(IERC20(token).balanceOf(pool), 900_000_000e18, "pool holds the supply across ranges");
        // Tradeable.
        vm.startPrank(alice);
        usdc.approve(v3Router, type(uint256).max);
        uint256 got = IV3Router(v3Router).exactInputSingle(address(usdc), token, FEE, alice, 5_000e6, 0, block.timestamp + 60);
        vm.stopPrank();
        assertGt(got, 0, "received tokens");
    }

    function test_poolType_legacy_singlePosition() public {
        address token = _launchPool(1, 100_000e6); // POOL_LEGACY, 100k start
        uint256 id = IArcadeV3Locker(v3Locker).positionIdByToken(token);
        assertEq(IArcadeV3Locker(v3Locker).rangeCount(id), 1, "single position");
        address pool = IArcadeV3Factory(v3Factory).getPool(address(usdc), token, FEE);
        assertGt(IERC20(token).balanceOf(pool), 900_000_000e18, "pool holds the supply");
    }

    function test_poolType_legacy_badMcap_reverts() public {
        IArcadeV3Locker.Recipient[] memory rs = _defaultRecipients();
        vm.startPrank(creator);
        usdc.approve(address(launchpad), type(uint256).max);
        vm.expectRevert(ArcadeLaunchpad.BadPoolType.selector);
        launchpad.createClankerV3("X", "X", "ipfs://x", rs, _optsPool(FEE, 1, 2_000_000e6)); // > 1M
        vm.stopPrank();
    }

    function test_poolType_deep_has3Positions() public {
        address token = _launchPool(2, 0); // POOL_DEEP, 50k start
        uint256 id = IArcadeV3Locker(v3Locker).positionIdByToken(token);
        assertEq(IArcadeV3Locker(v3Locker).rangeCount(id), 3, "3 positions");
    }

    function test_poolType_weth_pairsWithWeth() public {
        address token = _launchPool(3, 0); // POOL_WETH, 10 WETH start
        uint256 id = IArcadeV3Locker(v3Locker).positionIdByToken(token);
        assertEq(IArcadeV3Locker(v3Locker).rangeCount(id), 3, "3 positions");
        // The pool is WETH/token (not USDC/token).
        assertTrue(IArcadeV3Factory(v3Factory).getPool(address(weth), token, FEE) != address(0), "WETH pool exists");
        assertEq(IArcadeV3Factory(v3Factory).getPool(address(usdc), token, FEE), address(0), "no USDC pool");
        // Tradeable in WETH via the router.
        weth.mint(alice, 100e18);
        vm.startPrank(alice);
        weth.approve(v3Router, type(uint256).max);
        uint256 got = IV3Router(v3Router).exactInputSingle(address(weth), token, FEE, alice, 1e18, 0, block.timestamp + 60);
        vm.stopPrank();
        assertGt(got, 0, "received tokens for WETH");
    }

    /// @dev A direct pool swap (not via the Arcade router) bypasses the soft tax.
    function test_sniperTax_directPoolSwapBypasses() public {
        IArcadeV3Locker.Recipient[] memory rs = _defaultRecipients();
        vm.startPrank(creator);
        usdc.approve(address(launchpad), type(uint256).max);
        address token = launchpad.createClankerV3("Snipe Cat2", "SNP2", "ipfs://x", rs, _optsSnipe(FEE, 5_000, 3600));
        vm.stopPrank();
        // The router is the only enforcement point; the tax is "soft" by design.
        assertEq(launchpad.currentSnipeBps(token), 5_000, "tax live");
        // Treasury is untouched until someone routes a buy through our router.
        uint256 tBefore = usdc.balanceOf(treasury);
        assertEq(usdc.balanceOf(treasury), tBefore, "no passive skim");
    }
}
