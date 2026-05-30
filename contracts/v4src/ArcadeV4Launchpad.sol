// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ArcadeLaunchToken} from "../src/launchpad/ArcadeLaunchToken.sol";
import {
    ILaunchpadSnipe,
    IPoolManager,
    Currency,
    PoolKey
} from "./interfaces/IUniswapV4Types.sol";

/**
 * @title ArcadeV4Launchpad
 * @notice Standalone launchpad for tokens that trade through a Uniswap V4 pool
 *         with the anti-sniper hook attached. Strictly isolated from the
 *         production V2/V3 launchpad — has its own token registry, its own
 *         treasury, and exposes the `ILaunchpadSnipe` surface the hook reads.
 *
 *         What this contract does today:
 *           - Pulls a fixed creation fee in USDC.
 *           - Deploys an ArcadeLaunchToken with the canonical 1B supply.
 *           - Stores the per-token snipe configuration (start bps + decay
 *             seconds) and the launch timestamp. The hook reads this on
 *             every swap via `currentSnipeBps(token)`.
 *           - Exposes `treasury()` so the hook knows where to route skims.
 *
 *         What's deferred to a follow-up commit (needs a real V4 PoolManager
 *         on Arc):
 *           - V4 pool initialization (`POOL_MANAGER.initialize(key, sqrtPrice)`).
 *           - Single-sided liquidity locking via the V4 unlock callback
 *             pattern (`unlock` + `modifyLiquidity` + `settle`).
 *           - Optional creator buy at launch.
 *
 *         Splitting it this way means the on-chain hook can be tested against
 *         a deployed launchpad TODAY (and the salt miner can target a real
 *         deployer address), without waiting for a working V4 PoolManager.
 */
contract ArcadeV4Launchpad is ILaunchpadSnipe, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice USDC on Arc. Required as currency in every V4 pool we register.
    IERC20 public immutable USDC;
    /// @notice The V4 PoolManager all our pools live on. Stored for the
    ///         follow-up pool-init commit; this version doesn't call it.
    IPoolManager public immutable POOL_MANAGER;
    /// @notice Anti-sniper hook deployed at a CREATE2 address whose low 14
    ///         bits encode BEFORE_SWAP + AFTER_SWAP. Every V4 pool created
    ///         here uses this hook.
    address public immutable HOOK;
    /// @notice Treasury that receives the creation fee and (via the hook)
    ///         the snipe-skim deltas on every taxed swap.
    address public immutable TREASURY;
    /// @notice Deployer that wires the launchpad once - read only.
    address public immutable DEPLOYER;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    /// @notice USDC raw units (6 dp). Matches the production launchpad's flat
    ///         3 USDC creation fee.
    uint256 public constant CREATION_FEE = 3e6;
    /// @notice V4 pools use the same fee tier the V3 stack uses (1%).
    uint24 public constant POOL_FEE = 10_000;
    /// @notice 1% fee tier spacing.
    int24 public constant TICK_SPACING = 200;
    /// @notice Max starting sniper-tax rate (50%). Same cap as production.
    uint16 public constant MAX_SNIPE_BPS = 5_000;

    struct Launch {
        /// @notice Token address (== address of the deployed ArcadeLaunchToken).
        address token;
        /// @notice Wallet that deployed the launch. Stored for attribution
        ///         only; the launchpad itself never sends anything to it.
        address creator;
        /// @notice PoolKey for the V4 pool tied to this launch. Populated on
        ///         pool-init (next commit); zero-initialised today.
        PoolKey poolKey;
        /// @notice Snipe tax shape.
        uint16 snipeStartBps;
        uint32 snipeDecaySeconds;
        /// @notice Wall-clock launch time used by `currentSnipeBps` decay.
        uint64 launchedAt;
    }

    /// @notice Per-token launch info, keyed by token address.
    mapping(address => Launch) public launches;
    /// @notice Append-only registry of every token launched here, for the
    ///         frontend to enumerate.
    address[] public allTokens;

    error EmptyName();
    error InvalidSnipeBps();
    error InvalidDecaySeconds();
    error AlreadyLaunched();
    error UnknownToken();
    error TransferFailed();

    event TokenLaunched(
        address indexed token,
        address indexed creator,
        uint16 snipeStartBps,
        uint32 snipeDecaySeconds,
        uint64 launchedAt,
        string name,
        string symbol,
        string metadataURI
    );

    constructor(IERC20 usdc_, IPoolManager poolManager_, address hook_, address treasury_) {
        USDC = usdc_;
        POOL_MANAGER = poolManager_;
        HOOK = hook_;
        TREASURY = treasury_;
        DEPLOYER = msg.sender;
    }

    // ===================== Launching =====================

    /**
     * @notice Deploy a new launch token and register its snipe config so the
     *         hook can read it on every swap. The caller pays a flat
     *         `CREATION_FEE` in USDC, routed straight to the treasury.
     *
     *         The full 1 B supply is minted to this contract. The pool-init
     *         follow-up will transfer it into the V4 pool's accounting via
     *         the unlock callback; today the supply just sits here.
     *
     * @param name           ERC20 name
     * @param symbol         ERC20 symbol
     * @param metadataURI    off-chain metadata URI (ipfs:// or data:)
     * @param snipeStartBps  starting snipe tax in bps (0..MAX_SNIPE_BPS).
     *                       Pass 0 to disable the anti-sniper hook entirely.
     * @param snipeDecaySeconds linear decay window. Required > 0 when
     *                       `snipeStartBps > 0`; ignored otherwise.
     */
    function createLaunch(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        uint16 snipeStartBps,
        uint32 snipeDecaySeconds
    ) external nonReentrant returns (address tokenAddr) {
        if (bytes(name).length == 0 || bytes(symbol).length == 0) revert EmptyName();
        if (snipeStartBps > MAX_SNIPE_BPS) revert InvalidSnipeBps();
        if (snipeStartBps > 0 && snipeDecaySeconds == 0) revert InvalidDecaySeconds();

        // Pull the creation fee straight to treasury. Doing it before the
        // token deploy means we don't waste gas on a deploy if the user is
        // short on USDC or hasn't approved.
        USDC.safeTransferFrom(msg.sender, TREASURY, CREATION_FEE);

        ArcadeLaunchToken token = new ArcadeLaunchToken(name, symbol, TOTAL_SUPPLY, address(this));
        tokenAddr = address(token);

        if (launches[tokenAddr].token != address(0)) revert AlreadyLaunched();

        uint64 nowTs = uint64(block.timestamp);
        Launch storage l = launches[tokenAddr];
        l.token = tokenAddr;
        l.creator = msg.sender;
        l.snipeStartBps = snipeStartBps;
        l.snipeDecaySeconds = snipeDecaySeconds;
        l.launchedAt = nowTs;
        // l.poolKey stays zero-initialised; populated by the pool-init commit.

        allTokens.push(tokenAddr);

        emit TokenLaunched(tokenAddr, msg.sender, snipeStartBps, snipeDecaySeconds, nowTs, name, symbol, metadataURI);
    }

    // ===================== ILaunchpadSnipe surface =====================

    /// @notice Current snipe tax rate (bps) for `token`. Linear decay from
    ///         `snipeStartBps` at launch to 0 after `snipeDecaySeconds`.
    ///         Mirrors the production launchpad's exact decay math.
    function currentSnipeBps(address token) external view override returns (uint256) {
        Launch memory l = launches[token];
        if (l.snipeStartBps == 0 || l.snipeDecaySeconds == 0) return 0;
        if (l.launchedAt == 0) return 0;
        uint256 elapsed = block.timestamp - l.launchedAt;
        if (elapsed >= l.snipeDecaySeconds) return 0;
        return (uint256(l.snipeStartBps) * (l.snipeDecaySeconds - elapsed)) / l.snipeDecaySeconds;
    }

    /// @notice Treasury that receives the hook's snipe skims.
    function treasury() external view override returns (address) {
        return TREASURY;
    }

    // ===================== Views =====================

    function tokensCount() external view returns (uint256) {
        return allTokens.length;
    }

    function getLaunch(address token) external view returns (Launch memory) {
        return launches[token];
    }
}
