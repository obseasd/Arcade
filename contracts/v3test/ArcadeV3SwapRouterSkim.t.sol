// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;
pragma abicoder v2;

import "../v3src/ArcadeV3SwapRouter.sol";

// No forge-std: it requires >=0.8.13 and this layer is pinned to 0.7.6, which
// is why v3test/ArcadeAutoCompounder.t.sol also avoids it. Assertions are plain
// requires; foundry still runs any `test*` function on any contract.

/// Minimal ERC20 with a blacklist, mirroring Circle USDC's behaviour: a
/// blacklisted address makes transfer/transferFrom REVERT, it does not return
/// false. This is the trigger for the whole deferral path.
contract BlacklistableToken {
    string public name = "USDC";
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blacklisted;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function setBlacklisted(address a, bool b) external {
        blacklisted[a] = b;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        require(!blacklisted[msg.sender] && !blacklisted[to], "BLACKLISTED");
        require(balanceOf[msg.sender] >= amt, "BAL");
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function transferFrom(address f, address to, uint256 amt) external returns (bool) {
        require(!blacklisted[f] && !blacklisted[to], "BLACKLISTED");
        require(balanceOf[f] >= amt, "BAL");
        require(allowance[f][msg.sender] >= amt, "ALLOWANCE");
        allowance[f][msg.sender] -= amt;
        balanceOf[f] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}

/// Stands in for ArcadeLaunchpad's snipe surface (currentSnipeBps + treasury).
contract MockLaunchpadSnipe {
    address public treasury;
    mapping(address => uint256) public snipeBps;

    constructor(address t) {
        treasury = t;
    }

    function setSnipe(address token, uint256 bps) external {
        snipeBps[token] = bps;
    }

    function currentSnipeBps(address token) external view returns (uint256) {
        return snipeBps[token];
    }
}

/// Exposes the router's internal skim so the fee accounting can be tested
/// without standing up V3 pools. The logic under test (`_snipeSkim` /
/// `_paySkim` / `pendingSnipeFees` / `pushSnipeFees`) never touches a pool.
///
/// It INHERITS the real ArcadeV3SwapRouter on purpose. The first version of
/// this file COPIED the helpers into the harness, which made the whole suite
/// decorative: reverting the real `_paySkim` to its buggy form left all five
/// tests green, because they were exercising the copy. An audit caught it. The
/// only assertion a copy can make is about itself.
///
/// This file exists because ArcadeV3SwapRouter had ZERO test coverage: the
/// default foundry profile compiles `src/` only, so `forge test` never even
/// built v3src, and both green suites said nothing about this contract. Run it
/// with `FOUNDRY_PROFILE=v3 forge test`.
contract SkimHarness is ArcadeV3SwapRouter {
    constructor(address factory_, address usdc_, address launchpad_)
        ArcadeV3SwapRouter(factory_, usdc_, launchpad_)
    {}

    /// Calls the REAL _snipeSkim, so the tax-routing rules are under test.
    function skim(address tokenIn, address tokenOut, uint256 amountIn, address payer)
        external
        returns (uint256)
    {
        return _snipeSkim(tokenIn, tokenOut, amountIn, payer);
    }
}

contract ArcadeV3SwapRouterSkimTest {
    BlacklistableToken usdc;
    BlacklistableToken launchToken;
    BlacklistableToken weth;
    MockLaunchpadSnipe launchpad;
    SkimHarness router;

    address treasury = address(0xBEEF);
    // This contract IS the trader: it approves the router directly, which
    // avoids needing vm.prank on a 0.7.6 toolchain with no forge-std.
    address trader;

    uint256 constant SNIPE_BPS = 1000; // 10%

    function setUp() public {
        trader = address(this);
        usdc = new BlacklistableToken();
        launchToken = new BlacklistableToken();
        weth = new BlacklistableToken();
        launchpad = new MockLaunchpadSnipe(treasury);
        // factory_ is never touched by the skim path; it only must be non-zero.
        router = new SkimHarness(address(0xF00D), address(usdc), address(launchpad));

        launchpad.setSnipe(address(launchToken), SNIPE_BPS);

        usdc.mint(trader, 1_000_000e6);
        usdc.approve(address(router), uint256(-1));
        launchToken.mint(trader, 1_000_000e18);
        launchToken.approve(address(router), uint256(-1));
        weth.mint(trader, 1_000e18);
        weth.approve(address(router), uint256(-1));
    }

    function _eq(uint256 a, uint256 b, string memory what) internal pure {
        require(a == b, what);
    }

    // --- the tax-routing rules -------------------------------------------

    /// USDC -> launchToken: the classic buy. Skim in USDC, the input currency.
    function test_snipe_usdcBuy_isTaxed() public {
        uint256 s = router.skim(address(usdc), address(launchToken), 100e6, trader);
        _eq(s, 10e6, "10% of the USDC input");
        _eq(usdc.balanceOf(treasury), 10e6, "treasury paid in USDC");
    }

    /// launchToken -> USDC: the sell. Skim in launchToken.
    function test_snipe_sell_isTaxed() public {
        uint256 s = router.skim(address(launchToken), address(usdc), 100e18, trader);
        _eq(s, 10e18, "10% of the launchToken input");
        _eq(launchToken.balanceOf(treasury), 10e18, "treasury paid in launchToken");
    }

    /// THE HIGH: a POOL_WETH launch's only pool is (launchToken, WETH), so the
    /// only way in is exactInputSingle(WETH, launchToken). That hit the sell
    /// branch, read currentSnipeBps(WETH) == 0, and taxed NOTHING -- while the
    /// exit below stayed taxed. Snipers entered free and holders paid to leave,
    /// the exact inverse of the intent. Fails on the pre-fix router.
    function test_snipe_wethBuy_isTaxed() public {
        uint256 s = router.skim(address(weth), address(launchToken), 100e18, trader);
        _eq(s, 10e18, "10% of the WETH input");
        _eq(weth.balanceOf(treasury), 10e18, "treasury paid in WETH");
    }

    /// The mirror of the above: exits were always taxed. Kept so a future
    /// "simplification" cannot silently restore the asymmetry.
    function test_snipe_wethSell_isTaxed() public {
        uint256 s = router.skim(address(launchToken), address(weth), 100e18, trader);
        _eq(s, 10e18, "10% of the launchToken input");
        _eq(launchToken.balanceOf(treasury), 10e18, "treasury paid in launchToken");
    }

    /// An unrelated pair must not be taxed at all.
    function test_snipe_unrelatedPair_isFree() public {
        uint256 s = router.skim(address(weth), address(usdc), 100e18, trader);
        _eq(s, 0, "no snipe config on either side");
        _eq(weth.balanceOf(treasury), 0, "treasury paid nothing");
    }

    /// Both sides under snipe: taxed ONCE, at the selling token's rate.
    function test_snipe_bothSidesUnderSnipe_taxedOnceAtSellRate() public {
        launchpad.setSnipe(address(weth), 2000); // weth stands in for a 2nd launch token
        uint256 s = router.skim(address(weth), address(launchToken), 100e18, trader);
        _eq(s, 20e18, "sell rate (20%), not the buy rate, and not both");
        _eq(weth.balanceOf(treasury), 20e18, "charged once");
    }

    /// Outside the window (bps == 0) nothing is charged.
    function test_snipe_windowClosed_isFree() public {
        launchpad.setSnipe(address(launchToken), 0);
        uint256 s = router.skim(address(usdc), address(launchToken), 100e6, trader);
        _eq(s, 0, "window closed");
        _eq(usdc.balanceOf(treasury), 0, "treasury paid nothing");
    }

    // --- the payment / deferral path -------------------------------------

    /// Healthy treasury, external payer: paid straight through, nothing held.
    function test_skim_healthyTreasury_paysDirect() public {
        router.skim(address(usdc), address(launchToken), 100e6, trader);
        _eq(usdc.balanceOf(treasury), 10e6, "treasury paid");
        _eq(router.pendingSnipeFees(address(usdc)), 0, "nothing deferred");
    }

    /// THE 5th-REPEAT BUG: exactInputThroughUsdc skims the USDC mid with
    /// payer == address(this). _paySkim built transferFrom(router, treasury)
    /// needing a self-allowance we never grant, so it reverted, fell back, and
    /// self-transferred -- deferring EVERY two-hop skim on a healthy treasury
    /// and making SnipeFeeDeferred fire on the happy path, destroying the
    /// signal whose only job is to alarm "the treasury is dead".
    function test_skim_routerAsPayer_paysDirect_notDeferred() public {
        usdc.mint(address(router), 100e6); // the leg-1 output the router holds
        router.skim(address(usdc), address(launchToken), 100e6, address(router));
        _eq(usdc.balanceOf(treasury), 10e6, "treasury paid on the multi-hop path");
        _eq(router.pendingSnipeFees(address(usdc)), 0, "must NOT defer a healthy payment");
    }

    /// Blacklisted treasury must NOT brick the swap: the payer still pays, the
    /// skim is held, and anyone can push it once the treasury recovers.
    function test_skim_blacklistedTreasury_defersInsteadOfReverting() public {
        usdc.setBlacklisted(treasury, true);
        router.skim(address(usdc), address(launchToken), 100e6, trader);

        _eq(usdc.balanceOf(treasury), 0, "treasury got nothing");
        _eq(router.pendingSnipeFees(address(usdc)), 10e6, "held in the router");
        _eq(usdc.balanceOf(address(router)), 10e6, "backed by real tokens");
        // The trader paid regardless: a failing destination must never become a
        // way to dodge the tax.
        _eq(usdc.balanceOf(trader), 1_000_000e6 - 10e6, "payer always pays");

        // Recovered once the treasury can receive again.
        usdc.setBlacklisted(treasury, false);
        router.pushSnipeFees(address(usdc));
        _eq(usdc.balanceOf(treasury), 10e6, "pushed");
        _eq(router.pendingSnipeFees(address(usdc)), 0, "cleared");
    }

    /// A failed push must not burn the accounting: the revert rolls the zeroing
    /// back, so the fee stays claimable once the treasury recovers.
    function test_pushSnipeFees_stillBlacklisted_revertsAtomically() public {
        usdc.setBlacklisted(treasury, true);
        router.skim(address(usdc), address(launchToken), 100e6, trader);

        (bool ok, ) = address(router).call(
            abi.encodeWithSelector(router.pushSnipeFees.selector, address(usdc))
        );
        require(!ok, "push must revert while blacklisted");
        _eq(router.pendingSnipeFees(address(usdc)), 10e6, "accounting intact after revert");

        usdc.setBlacklisted(treasury, false);
        router.pushSnipeFees(address(usdc));
        _eq(usdc.balanceOf(treasury), 10e6, "recoverable");
    }

    function test_pushSnipeFees_nothingPending_reverts() public {
        (bool ok, ) = address(router).call(
            abi.encodeWithSelector(router.pushSnipeFees.selector, address(usdc))
        );
        require(!ok, "must revert when nothing pending");
    }
}
