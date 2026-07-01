// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {ArcadeV2Factory} from "../src/dex/ArcadeV2Factory.sol";
import {ArcadeV2Router} from "../src/dex/ArcadeV2Router.sol";
import {ArcadeLaunchpad} from "../src/launchpad/ArcadeLaunchpad.sol";
import {IArcadeLaunchpad} from "../src/launchpad/interfaces/IArcadeLaunchpad.sol";
import {
    ArcadeMultiSwap,
    IArcadeV4SwapRouterMin,
    IArcadeV4LaunchpadMin,
    V4PoolKey
} from "../src/swap/ArcadeMultiSwap.sol";
import {IArcadeV3Factory, IArcadeV3Router} from "../src/v3/interfaces/IArcadeV3Minimal.sol";

contract MockV4LaunchToken is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @notice Mock V4 launchpad: records the PoolKey we hand back for each
///         registered launch, so the aggregator can look it up via
///         getLaunch. The MultiSwap's `_isV4LaunchToken` short-circuits via
///         `l.token == token` so non-registered addresses return false.
contract MockV4Launchpad is IArcadeV4LaunchpadMin {
    mapping(address => Launch) internal _launches;
    address internal _hook;

    function setHook(address h) external { _hook = h; }

    function register(address token, V4PoolKey calldata key) external {
        Launch storage l = _launches[token];
        l.token = token;
        l.creator = address(0xC0FFEE);
        l.poolKey = key;
    }

    function getLaunch(address token) external view override returns (Launch memory) {
        return _launches[token];
    }

    function HOOK() external view override returns (address) { return _hook; }
}

/// @notice Mock V4 swap router that:
///   - Records every exactInputSingle call so the test can assert correct
///     routing (poolKey, zeroForOne, amountIn, recipient).
///   - Pays the recipient by minting the OUTPUT token. The test pre-funds
///     it with input liquidity by transferring input tokens INTO it (the
///     aggregator forceApprove + the router would pull via transferFrom in
///     production - here we accept the approve but don't actually take, so
///     the aggregator keeps the input. Fine for routing-shape assertions).
contract MockV4SwapRouter is IArcadeV4SwapRouterMin {
    struct Call {
        V4PoolKey key;
        bool zeroForOne;
        uint256 amountIn;
        address recipient;
    }
    Call[] public calls;

    /// @notice For each (tokenIn, tokenOut) pair the test specifies how much
    ///         output to give. Defaults to 1:1.
    mapping(bytes32 => uint256) public quotedOutFor;

    function setQuote(address tokenIn, address tokenOut, uint256 out) external {
        quotedOutFor[keccak256(abi.encode(tokenIn, tokenOut))] = out;
    }

    function callCount() external view returns (uint256) { return calls.length; }

    function exactInputSingle(
        V4PoolKey calldata key,
        bool zeroForOne,
        uint256 amountIn,
        uint256, /* minAmountOut */
        address recipient,
        uint160  /* sqrtPriceLimitX96 */
    ) external override returns (uint256 amountOut) {
        calls.push(Call({key: key, zeroForOne: zeroForOne, amountIn: amountIn, recipient: recipient}));

        address tokenIn = zeroForOne ? key.currency0 : key.currency1;
        address tokenOut = zeroForOne ? key.currency1 : key.currency0;

        bytes32 k = keccak256(abi.encode(tokenIn, tokenOut));
        amountOut = quotedOutFor[k];
        if (amountOut == 0) amountOut = amountIn; // default 1:1

        // Pull approved input (aggregator forceApproved this contract above).
        // We don't strictly need it; we use balanceOf-based mint of output.
        try IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn) {
            // ok - tokens captured.
        } catch {
            // ok - some tests may not pre-approve; that's fine.
        }

        // Mint the output to the recipient. Tests inject mintable mocks for
        // both sides, so this is always valid.
        MockV4LaunchToken(tokenOut).mint(recipient, amountOut);
    }
}

contract ArcadeMultiSwapV4Test is Test {
    MockUSDC usdc;
    ArcadeV2Factory factory;
    ArcadeV2Router router;
    ArcadeLaunchpad launchpad;
    ArcadeMultiSwap multiSwap;

    MockV4SwapRouter v4Router;
    MockV4Launchpad v4Launchpad;
    MockV4LaunchToken v4Token; // a V4 launch
    MockV4LaunchToken v4Token2; // a second V4 launch

    address treasury = address(0xBEEF);
    address user = address(0xA11CE);

    ArcadeMultiSwap.Input[] inputsBuf;

    function setUp() public {
        usdc = new MockUSDC();
        factory = new ArcadeV2Factory(address(this));
        router = new ArcadeV2Router(address(factory));
        launchpad = new ArcadeLaunchpad(
            IERC20(address(usdc)), factory, address(router), treasury, IArcadeV3Factory(address(0)), address(0)
        );

        v4Router = new MockV4SwapRouter();
        v4Launchpad = new MockV4Launchpad();
        // H-06: MultiSwap now whitelists the hook returned by HOOK(). Set the
        // mock's hook to match the address we use in the registered PoolKeys.
        v4Launchpad.setHook(address(0xCAFE));

        multiSwap = new ArcadeMultiSwap(
            IERC20(address(usdc)),
            factory,
            router,
            IArcadeLaunchpad(address(launchpad)),
            IArcadeV3Router(address(0)),
            IArcadeV4SwapRouterMin(address(v4Router)),
            IArcadeV4LaunchpadMin(address(v4Launchpad))
        );

        // Register a V4 launch: USDC + v4Token paired.
        v4Token = new MockV4LaunchToken("V4 Token", "V4T");
        // Canonical sort: lower address = currency0.
        (address c0, address c1) = address(v4Token) < address(usdc)
            ? (address(v4Token), address(usdc))
            : (address(usdc), address(v4Token));
        V4PoolKey memory key = V4PoolKey({
            currency0: c0, currency1: c1, fee: 10_000, tickSpacing: 200, hooks: address(0xCAFE)
        });
        v4Launchpad.register(address(v4Token), key);

        // Register a SECOND V4 launch (USDC + v4Token2) for V4<->V4 tests.
        v4Token2 = new MockV4LaunchToken("V4 Token 2", "V4T2");
        (address c2_0, address c2_1) = address(v4Token2) < address(usdc)
            ? (address(v4Token2), address(usdc))
            : (address(usdc), address(v4Token2));
        V4PoolKey memory key2 = V4PoolKey({
            currency0: c2_0, currency1: c2_1, fee: 10_000, tickSpacing: 200, hooks: address(0xCAFE)
        });
        v4Launchpad.register(address(v4Token2), key2);

        // Fund user.
        usdc.mint(user, 1_000_000e6);
        v4Token.mint(user, 1_000e18);
        v4Token2.mint(user, 1_000e18);
        vm.startPrank(user);
        usdc.approve(address(multiSwap), type(uint256).max);
        v4Token.approve(address(multiSwap), type(uint256).max);
        v4Token2.approve(address(multiSwap), type(uint256).max);
        vm.stopPrank();
    }

    function _push(address token, uint256 amount) internal {
        inputsBuf.push(ArcadeMultiSwap.Input({token: token, amount: amount, minOut: 0, usdcMidMin: 0}));
    }

    function _reset() internal { delete inputsBuf; }

    // =================== USDC -> V4 token ===================

    function test_usdcInToV4Token_singleV4Hop() public {
        _reset();
        _push(address(usdc), 1_000e6);
        v4Router.setQuote(address(usdc), address(v4Token), 42e18);

        vm.prank(user);
        uint256 out = multiSwap.swapToSingle(
            inputsBuf, address(v4Token), 0, block.timestamp + 60
        );
        assertEq(out, 42e18, "user received quoted V4 output");
        assertEq(v4Router.callCount(), 1, "exactly one V4 swap");

        (V4PoolKey memory key, bool zeroForOne, uint256 amtIn, address recip) =
            _readCall(0);
        // tokenIn = USDC; zeroForOne == (USDC == currency0).
        bool usdcIsC0 = address(usdc) < address(v4Token);
        assertEq(zeroForOne, usdcIsC0, "zeroForOne derived from sort");
        assertEq(amtIn, 1_000e6);
        assertEq(recip, address(multiSwap), "router pays the aggregator");
        assertEq(key.currency0, usdcIsC0 ? address(usdc) : address(v4Token));
    }

    // =================== V4 token -> USDC ===================

    function test_v4TokenToUsdc_singleV4Hop() public {
        _reset();
        _push(address(v4Token), 10e18);
        v4Router.setQuote(address(v4Token), address(usdc), 1_234e6);

        vm.prank(user);
        uint256 out = multiSwap.swapToSingle(
            inputsBuf, address(usdc), 0, block.timestamp + 60
        );
        assertEq(out, 1_234e6);
        assertEq(v4Router.callCount(), 1);

        (, bool zeroForOne,,) = _readCall(0);
        // tokenIn = v4Token; zeroForOne == (v4Token == currency0).
        bool v4IsC0 = address(v4Token) < address(usdc);
        assertEq(zeroForOne, v4IsC0);
    }

    // =================== V4 -> V4 (pivot USDC) ===================

    function test_v4ToV4_pivotsThroughUsdc_twoV4Hops() public {
        _reset();
        _push(address(v4Token), 10e18);
        v4Router.setQuote(address(v4Token), address(usdc), 500e6);
        v4Router.setQuote(address(usdc), address(v4Token2), 22e18);

        vm.prank(user);
        uint256 out = multiSwap.swapToSingle(
            inputsBuf, address(v4Token2), 0, block.timestamp + 60
        );
        assertEq(out, 22e18, "two V4 hops total quoted output");
        assertEq(v4Router.callCount(), 2, "two V4 swaps");
    }

    // =================== V4 dispatch DOES NOT fire when stack disabled ===================

    function test_v4Dispatch_skippedWhenAggregatorHasNoV4Stack() public {
        // Deploy a parallel aggregator with V4 disabled and check that a
        // route involving a V4 token does NOT call the router.
        ArcadeMultiSwap noV4 = new ArcadeMultiSwap(
            IERC20(address(usdc)),
            factory,
            router,
            IArcadeLaunchpad(address(launchpad)),
            IArcadeV3Router(address(0)),
            IArcadeV4SwapRouterMin(address(0)),
            IArcadeV4LaunchpadMin(address(0))
        );

        // The token isn't a known V2 pair either, so routing falls all the
        // way to a V2 multi-hop attempt that reverts (no pair to USDC).
        // We just assert the V4 router got zero hits.
        _reset();
        _push(address(usdc), 100e6);
        vm.prank(user);
        usdc.approve(address(noV4), type(uint256).max);
        vm.prank(user);
        vm.expectRevert(); // no pair, V2 multi-hop fails
        noV4.swapToSingle(inputsBuf, address(v4Token), 0, block.timestamp + 60);
        assertEq(v4Router.callCount(), 0);
    }

    // =================== H-06: hook whitelist enforced ===================

    function test_H06_swap_revertsOnUnknownHook() public {
        // Register a NEW V4 launch whose PoolKey carries an attacker-chosen
        // hook address. The aggregator should refuse the swap because the
        // launchpad's HOOK() returns 0xCAFE (set in setUp), not 0xBAD.
        MockV4LaunchToken badToken = new MockV4LaunchToken("Bad", "BAD");
        (address c0, address c1) = address(badToken) < address(usdc)
            ? (address(badToken), address(usdc))
            : (address(usdc), address(badToken));
        V4PoolKey memory badKey = V4PoolKey({
            currency0: c0, currency1: c1, fee: 10_000, tickSpacing: 200, hooks: address(0xBAD)
        });
        v4Launchpad.register(address(badToken), badKey);

        badToken.mint(user, 1_000e18);
        vm.prank(user);
        badToken.approve(address(multiSwap), type(uint256).max);

        _reset();
        _push(address(badToken), 10e18);

        vm.prank(user);
        vm.expectRevert(ArcadeMultiSwap.UnknownHook.selector);
        multiSwap.swapToSingle(inputsBuf, address(usdc), 0, block.timestamp + 60);
    }

    function test_H06_swap_acceptsCorrectHook() public {
        // Sanity: the standard happy path (hook matches HOOK()) still works.
        // Reuses the v4Token registered in setUp with hooks = 0xCAFE.
        _reset();
        _push(address(usdc), 1_000e6);
        v4Router.setQuote(address(usdc), address(v4Token), 42e18);
        vm.prank(user);
        multiSwap.swapToSingle(inputsBuf, address(v4Token), 0, block.timestamp + 60);
    }

    // =================== L-09: uninitialized pool guard ===================

    function test_L09_isV4LaunchToken_returnsFalseForUninitialized() public {
        // A V4 launch registered with a zeroed PoolKey (currency0 == 0) is
        // treated as "not V4-routable yet" by _isV4LaunchToken, so a swap
        // touching it falls through to the V2/V3 path (which will revert
        // for a token without a V2 pair). The user gets a clean error,
        // not an opaque V4 router revert.
        MockV4LaunchToken pending = new MockV4LaunchToken("Pending", "PND");
        V4PoolKey memory zeroKey = V4PoolKey({
            currency0: address(0), currency1: address(0), fee: 0, tickSpacing: 0, hooks: address(0)
        });
        v4Launchpad.register(address(pending), zeroKey);

        pending.mint(user, 1_000e18);
        vm.prank(user);
        pending.approve(address(multiSwap), type(uint256).max);

        _reset();
        _push(address(pending), 10e18);
        vm.prank(user);
        // Falls to V2 path which has no pair -> revert. The important assert
        // is that v4Router callCount remains 0 (the V4 dispatch was skipped).
        vm.expectRevert();
        multiSwap.swapToSingle(inputsBuf, address(usdc), 0, block.timestamp + 60);
        assertEq(v4Router.callCount(), 0, "no V4 dispatch for uninitialized launch");
    }

    // =================== Helper ===================

    function _readCall(uint256 i)
        internal
        view
        returns (V4PoolKey memory, bool, uint256, address)
    {
        (V4PoolKey memory key, bool zfo, uint256 amtIn, address recip) = v4Router.calls(i);
        return (key, zfo, amtIn, recip);
    }
}
