// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity =0.7.6;
pragma abicoder v2;

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
/// without standing up V3 pools. The logic under test (`_paySkim` /
/// `pendingSnipeFees` / `pushSnipeFees`) is entirely independent of swapping.
///
/// This file exists because ArcadeV3SwapRouter had ZERO test coverage: the
/// default foundry profile compiles `src/` only, so `forge test` never even
/// built v3src, and both green suites said nothing about this contract. That is
/// how a real bug (`_paySkim` ignoring `payer == address(this)`) shipped and
/// was only caught by reading.
contract SkimHarness {
    address public immutable USDC;
    address public immutable launchpad;
    mapping(address => uint256) public pendingSnipeFees;

    event SnipeFeeDeferred(address indexed token, uint256 amount);
    event SnipeFeesPushed(address indexed token, uint256 amount);

    constructor(address _usdc, address _launchpad) {
        USDC = _usdc;
        launchpad = _launchpad;
    }

    function skim(address token, address payer, uint256 amount) external {
        _paySkim(token, payer, amount);
    }

    function pushSnipeFees(address token) external {
        uint256 amount = pendingSnipeFees[token];
        require(amount > 0, "NOTHING_PENDING");
        pendingSnipeFees[token] = 0;
        _pay(token, address(this), MockLaunchpadSnipe(launchpad).treasury(), amount);
        emit SnipeFeesPushed(token, amount);
    }

    // --- copies of the router's helpers under test -----------------------
    function _paySkim(address token, address payer, uint256 amount) internal {
        address treasury_ = MockLaunchpadSnipe(launchpad).treasury();
        bytes memory payload = payer == address(this)
            ? abi.encodeWithSelector(bytes4(0xa9059cbb), treasury_, amount)
            : abi.encodeWithSelector(bytes4(0x23b872dd), payer, treasury_, amount);
        (bool ok, bytes memory ret) = token.call(payload);
        if (ok && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool))))) return;
        _pay(token, payer, address(this), amount);
        pendingSnipeFees[token] += amount;
        emit SnipeFeeDeferred(token, amount);
    }

    function _pay(address token, address payer, address to, uint256 amount) internal {
        bytes memory payload = payer == address(this)
            ? abi.encodeWithSelector(bytes4(0xa9059cbb), to, amount)
            : abi.encodeWithSelector(bytes4(0x23b872dd), payer, to, amount);
        (bool ok, bytes memory ret) = token.call(payload);
        require(ok && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool)))), "PAY_FAIL");
    }
}

contract ArcadeV3SwapRouterSkimTest {
    BlacklistableToken usdc;
    MockLaunchpadSnipe launchpad;
    SkimHarness router;

    address treasury = address(0xBEEF);
    // This contract IS the trader: it approves the router directly, which
    // avoids needing vm.prank on a 0.7.6 toolchain with no forge-std.
    address trader;

    function setUp() public {
        trader = address(this);
        usdc = new BlacklistableToken();
        launchpad = new MockLaunchpadSnipe(treasury);
        router = new SkimHarness(address(usdc), address(launchpad));
        usdc.mint(trader, 1_000_000e6);
        usdc.approve(address(router), uint256(-1));
    }

    function _eq(uint256 a, uint256 b, string memory what) internal pure {
        require(a == b, what);
    }

    /// Healthy treasury, external payer: paid straight through, nothing held.
    function test_skim_healthyTreasury_paysDirect() public {
        router.skim(address(usdc), trader, 100e6);
        _eq(usdc.balanceOf(treasury), 100e6, "treasury paid");
        _eq(router.pendingSnipeFees(address(usdc)), 0, "nothing deferred");
    }

    /// THE BUG: exactInputThroughUsdc skims the USDC mid with payer ==
    /// address(this). _paySkim built transferFrom(router, treasury) needing a
    /// self-allowance we never grant, so it reverted, fell back, and
    /// self-transferred -- deferring EVERY two-hop skim on a healthy treasury
    /// and making SnipeFeeDeferred fire on the happy path, destroying the
    /// signal whose only job is to alarm "the treasury is dead".
    function test_skim_routerAsPayer_paysDirect_notDeferred() public {
        usdc.mint(address(router), 100e6); // the leg-1 output the router holds
        router.skim(address(usdc), address(router), 100e6);
        _eq(usdc.balanceOf(treasury), 100e6, "treasury paid on the multi-hop path");
        _eq(router.pendingSnipeFees(address(usdc)), 0, "must NOT defer a healthy payment");
    }

    /// Blacklisted treasury must NOT brick the swap: the payer still pays, the
    /// skim is held, and anyone can push it once the treasury recovers.
    function test_skim_blacklistedTreasury_defersInsteadOfReverting() public {
        usdc.setBlacklisted(treasury, true);
        router.skim(address(usdc), trader, 100e6);

        _eq(usdc.balanceOf(treasury), 0, "treasury got nothing");
        _eq(router.pendingSnipeFees(address(usdc)), 100e6, "held in the router");
        _eq(usdc.balanceOf(address(router)), 100e6, "backed by real tokens");
        // The trader paid regardless: a failing destination must never become a
        // way to dodge the tax.
        _eq(usdc.balanceOf(trader), 1_000_000e6 - 100e6, "payer always pays");

        // Recovered once the treasury can receive again.
        usdc.setBlacklisted(treasury, false);
        router.pushSnipeFees(address(usdc));
        _eq(usdc.balanceOf(treasury), 100e6, "pushed");
        _eq(router.pendingSnipeFees(address(usdc)), 0, "cleared");
    }

    /// A failed push must not burn the accounting: the revert rolls the zeroing
    /// back, so the fee stays claimable once the treasury recovers.
    function test_pushSnipeFees_stillBlacklisted_revertsAtomically() public {
        usdc.setBlacklisted(treasury, true);
        router.skim(address(usdc), trader, 100e6);

        (bool ok, ) = address(router).call(
            abi.encodeWithSelector(router.pushSnipeFees.selector, address(usdc))
        );
        require(!ok, "push must revert while blacklisted");
        _eq(router.pendingSnipeFees(address(usdc)), 100e6, "accounting intact after revert");

        usdc.setBlacklisted(treasury, false);
        router.pushSnipeFees(address(usdc));
        _eq(usdc.balanceOf(treasury), 100e6, "recoverable");
    }

    function test_pushSnipeFees_nothingPending_reverts() public {
        (bool ok, ) = address(router).call(
            abi.encodeWithSelector(router.pushSnipeFees.selector, address(usdc))
        );
        require(!ok, "must revert when nothing pending");
    }
}
