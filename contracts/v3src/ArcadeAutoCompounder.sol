// SPDX-License-Identifier: MIT
pragma solidity =0.7.6;
pragma abicoder v2;

import "@uniswap/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";

/// @dev Minimal ERC20 surface (the V3 layer's OZ branch is the 0.7-compatible
///      one and dragging the full IERC20 in increases compile time for zero
///      gain — we only ever transfer / read balance on token0 / token1).
interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

/// @dev Minimal V3 factory surface (pool lookup for slot0 / in-range checks).
interface IArcadeV3FactoryMin {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

/// @dev Minimal V3 pool surface for TWAP + cardinality bump. The full
///      IUniswapV3Pool interface includes mint/swap/burn which we do
///      not call, so inlining the three view + one write we need
///      keeps the deployment bytecode smaller (this contract sits
///      close to the EIP-170 limit already).
interface IUniswapV3PoolMin {
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (
            int56[] memory tickCumulatives,
            uint160[] memory secondsPerLiquidityCumulativeX128s
        );
    function increaseObservationCardinalityNext(uint16 observationCardinalityNext) external;
}

/// @dev IERC721Receiver shape so safeTransferFrom into this contract is
///      accepted. Inlined to avoid an OZ-version coupling.
interface IERC721ReceiverMin {
    function onERC721Received(
        address operator,
        address from,
        uint256 tokenId,
        bytes calldata data
    ) external returns (bytes4);
}

/**
 * @title ArcadeAutoCompounder
 * @notice Custody-based fee-management vault for Arcade V3 LP NFTs. A user
 *         deposits their ERC-721 position into this contract under one of
 *         three modes and can withdraw it at any time:
 *
 *           NORMAL    : tracked but never touched. Withdraw-only escape hatch
 *                       (used when a position is in transit between modes or
 *                       the user pauses auto-management without giving up
 *                       custody).
 *           RECEIVE   : permissionless caller collects accumulated fees from
 *                       the underlying V3 pool and pushes them directly to
 *                       the depositor wallet, minus a 1% protocol fee. This
 *                       is the "auto-claim" UX — the user OAuth-links once
 *                       and the fees land in their wallet without a manual
 *                       claim tx.
 *           COMPOUND  : permissionless caller collects fees and re-deposits
 *                       them into the same position via increaseLiquidity.
 *                       NPM uses whatever proportion of (fee0, fee1) the
 *                       current price + tick range can absorb; any leftover
 *                       token0 / token1 is returned to the depositor (no
 *                       in-protocol swap leg — the MVP keeps a tight attack
 *                       surface; an optimal-ratio swap is a v2 add-on).
 *
 *         Anyone may call `compound` or `pushFees` once a position is past
 *         its 5-minute per-position cooldown and has at least `minFeeMicros`
 *         pending (denominated in token0 or token1 raw units; UI quotes to
 *         USDC for display). A permissionless trigger lets a single backend
 *         keeper handle the bulk of executions without becoming a centralised
 *         dependency: if the keeper goes down, a user (or anyone in the
 *         community running the keeper script) keeps the system live.
 *
 *         Risk surface analysis (full edge case inventory in the RFC):
 *           - Reentrancy: every external call is bookended by a
 *             nonReentrant guard. Compound's three external calls (collect,
 *             approve, increaseLiquidity) never re-enter user code.
 *           - MEV on increaseLiquidity: liquidity adds at the current price
 *             do not move the spot, so there is no immediate sandwich
 *             surface. The amount0Min / amount1Min params still gate any
 *             stale-quote behaviour the keeper might submit.
 *           - Spam: cooldown + protocol fee make repeated calls
 *             economically irrational for an attacker; the keeper still
 *             wins the race in the common case.
 *           - NFT theft: only the recorded depositor can withdraw, and
 *             configs are deleted in the same call as the transfer.
 *           - Admin abuse: protocolFeeBps is bounded at 500 (5%) on-chain;
 *             setOperator / setFeeRecipient cannot drain user funds, they
 *             only redirect routing of newly-collected fees.
 *
 *         Written in =0.7.6 to share the canonical Uniswap V3 math and
 *         interfaces with the rest of the v3src/ stack (NPM, Locker,
 *         SwapRouter). Drop-in compatible with ArcadeV3PositionManager.
 *
 *         **Donations are unrecoverable.** Audit M5 fix — explicit
 *         user warning. Both `pushFees` and `compound` source their
 *         distribution amounts from the NPM.collect return values,
 *         NOT from balanceOf(this). An ERC-20 sent directly to this
 *         contract (by `transfer` from an EOA, by the rare token that
 *         pushes tokens on a fallback handler, by the user accidentally
 *         pasting the Compounder address into a withdraw flow, etc.)
 *         lands in the contract's balance and stays there forever.
 *         There is no `sweep` / `rescue` admin function and intentionally
 *         so: any rescue path inevitably opens a same-block sandwich
 *         against fee-distribution semantics (admin could skim
 *         collected-but-not-yet-distributed fees) and the audit's
 *         risk/reward analysis prefers documented loss over privileged
 *         clawback. If you need to recover a donated balance, deploy
 *         a new Compounder, migrate user positions, and accept the
 *         donation as a one-time loss recorded for governance.
 */
contract ArcadeAutoCompounder is IERC721ReceiverMin {
    // --------------------------------------------------------------------
    // Immutables / config
    // --------------------------------------------------------------------

    INonfungiblePositionManager public immutable NPM;
    IArcadeV3FactoryMin public immutable FACTORY;

    /// @notice Admin (multisig in production) that can rotate operator /
    ///         protocol fee / fee recipient and pause new actions in an
    ///         emergency. Cannot pull user NFTs or accumulated fees out of
    ///         escrow — the only privileged path that touches tokens is
    ///         setProtocolFee, capped at 5%.
    address public owner;

    /// @notice Audit I6 fix: two-step ownership handoff. transferOwnership
    ///         now sets `pendingOwner`; the new owner must call
    ///         `acceptOwnership` to take possession. Closes the fat-finger
    ///         brick risk where transferOwnership(WRONG_ADDR) would leave
    ///         the contract permanently un-admin'd. Mirrors the
    ///         OpenZeppelin Ownable2Step pattern without dragging the OZ
    ///         dep into the 0.7 layer.
    address public pendingOwner;

    /// @notice Wallet authorised to call compound / pushFees on behalf of
    ///         users. Permissionless callers can also trigger but pay the
    ///         protocol fee on top of gas; the keeper has the same economic
    ///         opportunity, just better latency.
    address public operator;

    /// @notice Recipient of protocol fees (typically the Arcade treasury).
    address public feeRecipient;

    /// @notice Basis points taken from collected fees on every successful
    ///         compound / pushFees. Hard-capped at 500 (5%) on-chain.
    uint16 public protocolFeeBps;

    /// @notice Pause switch for new actions. Withdraw remains live so users
    ///         always have an escape hatch even if the admin disappears.
    bool public paused;

    // --------------------------------------------------------------------
    // Constants
    // --------------------------------------------------------------------

    uint16 internal constant MAX_PROTOCOL_FEE_BPS = 500; // 5% ceiling
    uint16 internal constant BPS_DENOMINATOR = 10_000;
    uint64 internal constant ACTION_COOLDOWN_SECONDS = 5 minutes;
    uint64 internal constant TX_DEADLINE_BUFFER_SECONDS = 60;

    /// @dev Audit H2 fix: minimum acceptable `minFeeMicros` per
    ///      position. Stops the dust-position DoS where an attacker
    ///      deposits a thousand NFTs with `minFeeMicros = 1` and forces
    ///      the keeper to burn gas on worthless compounds. The cron's
    ///      sort change (commit d55ef36) helps but does not bound the
    ///      worst case; this floor cuts the attack at its root.
    ///      Conservative default: 1e6 micros == $1.00 USDC of fees
    ///      before the position is even considered for triggering.
    uint64 internal constant MIN_FEE_MICROS_FLOOR = 1_000_000;

    /// @dev 2026-06-15 audit HIGH fix: the TWAP gate compares raw tick
    ///      distance against `maxSlippageBps` as if 1 tick == 1 bp.
    ///      At maxSlippageBps == BPS_DENOMINATOR the gate accepts
    ///      ~10_000 ticks (~172% price deviation), effectively
    ///      disabled. Capping the depositor-chosen value at 1000 bps
    ///      keeps the linear tick-as-bp approximation honest (within
    ///      ~5% of the true sqrt-price distance per the comment in
    ///      _enforceTwapGate) AND closes the related vector where a
    ///      phishing-signed setMode could flip slippage to BPS_DEN
    ///      in one tx to neutralise the gate before the next compound.
    uint16 internal constant MAX_USER_SLIPPAGE_BPS = 1_000;

    // Audit H1 fix: TWAP gate parameters. The window is intentionally
    // short (60 seconds) so the gate's reaction to genuine price
    // movement is fast — the goal is to block sandwich attacks where
    // the attacker tilts the pool, calls compound, and reverts the
    // tilt in the same block. A 60-second TWAP averages a single
    // block's manipulation down to ~1/12 of its impact on Arc (~5s
    // blocks → 12 blocks per window), enough to fail the deviation
    // gate under any honest slippage setting. The cardinality target
    // is 60+ so the pool's observation array carries at least one full
    // window of history.
    uint32 internal constant TWAP_WINDOW_SECONDS = 60;
    uint16 internal constant TARGET_OBSERVATION_CARDINALITY = 60;

    // Mode is encoded as uint8 (instead of a proper enum) so the
    // PositionConfig packs cleanly into two storage slots — frequent reads
    // dominate the gas profile so layout matters more than syntax sugar.
    uint8 internal constant MODE_NORMAL = 0;
    uint8 internal constant MODE_RECEIVE = 1;
    uint8 internal constant MODE_COMPOUND = 2;

    // --------------------------------------------------------------------
    // Storage
    // --------------------------------------------------------------------

    struct PositionConfig {
        // Slot 0: 20 + 1 + 2 + 8 = 31 bytes
        address depositor;
        uint8 mode;
        uint16 maxSlippageBps;
        uint64 lastActionAt;
        // Slot 1: 8 + 24 (padding) = 32 bytes — threshold + room for future
        // per-position toggles without a storage migration.
        uint64 minFeeMicros;
    }

    /// @notice tokenId => PositionConfig. depositor == address(0) means
    ///         "not deposited" — we never zero out the rest of the struct
    ///         on withdraw so the historical config is auditable on chain,
    ///         but every active-path check keys on `depositor != 0`.
    mapping(uint256 => PositionConfig) public configs;

    /// @dev Simple reentrancy guard. 0.7.6 lacks the OZ "1 / 2" pattern
    ///      flavour with `immutable` slots so we inline; a single bool is
    ///      enough since every guarded function is `external`.
    bool internal _locked;

    modifier nonReentrant() {
        require(!_locked, "REENTRANT");
        _locked = true;
        _;
        _locked = false;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    modifier onlyDepositor(uint256 tokenId) {
        require(configs[tokenId].depositor == msg.sender, "NOT_DEPOSITOR");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "PAUSED");
        _;
    }

    // --------------------------------------------------------------------
    // Events
    // --------------------------------------------------------------------

    event PositionDeposited(
        uint256 indexed tokenId,
        address indexed depositor,
        uint8 mode,
        uint64 minFeeMicros,
        uint16 maxSlippageBps
    );
    event PositionWithdrawn(uint256 indexed tokenId, address indexed to);
    event ModeChanged(
        uint256 indexed tokenId,
        uint8 oldMode,
        uint8 newMode,
        uint64 minFeeMicros,
        uint16 maxSlippageBps
    );
    event Compounded(
        uint256 indexed tokenId,
        address indexed caller,
        uint256 fee0Collected,
        uint256 fee1Collected,
        uint256 protocolFee0,
        uint256 protocolFee1,
        uint128 liquidityAdded,
        uint256 amount0Used,
        uint256 amount1Used,
        uint256 amount0Leftover,
        uint256 amount1Leftover
    );
    event FeesPushed(
        uint256 indexed tokenId,
        address indexed caller,
        address indexed recipient,
        uint256 amount0,
        uint256 amount1,
        uint256 protocolFee0,
        uint256 protocolFee1
    );

    event OperatorSet(address indexed previous, address indexed next);
    event ProtocolFeeBpsSet(uint16 previous, uint16 next);
    event FeeRecipientSet(address indexed previous, address indexed next);
    event OwnerSet(address indexed previous, address indexed next);
    /// @notice Audit I6 fix: ownership transfer is now two-step. This
    ///         event fires when the owner proposes a new owner; the
    ///         OwnerSet event still fires when that proposal is
    ///         accepted, so a single subscriber can track both halves.
    event OwnershipTransferStarted(address indexed previous, address indexed pending);
    event PausedSet(bool paused);

    // --------------------------------------------------------------------
    // Constructor
    // --------------------------------------------------------------------

    constructor(
        address _npm,
        address _factory,
        address _owner,
        address _operator,
        address _feeRecipient,
        uint16 _protocolFeeBps
    ) {
        require(_npm != address(0), "ZERO_NPM");
        require(_factory != address(0), "ZERO_FACTORY");
        require(_owner != address(0), "ZERO_OWNER");
        require(_feeRecipient != address(0), "ZERO_FEE_RECIPIENT");
        require(_protocolFeeBps <= MAX_PROTOCOL_FEE_BPS, "FEE_TOO_HIGH");

        NPM = INonfungiblePositionManager(_npm);
        FACTORY = IArcadeV3FactoryMin(_factory);
        owner = _owner;
        operator = _operator; // may be zero at deploy; admin wires it later
        feeRecipient = _feeRecipient;
        protocolFeeBps = _protocolFeeBps;
    }

    // --------------------------------------------------------------------
    // ERC721 receiver
    // --------------------------------------------------------------------

    /// @notice Honours the safeTransferFrom path: a user can either pre-call
    ///         depositPosition() OR call NPM.safeTransferFrom(user, this,
    ///         tokenId, abi.encode(mode, minFeeMicros, maxSlippageBps)).
    ///         The latter avoids the approve-then-call two-tx UX.
    function onERC721Received(
        address transferOperator,
        address from,
        uint256 tokenId,
        bytes calldata data
    ) external override whenNotPaused returns (bytes4) {
        require(msg.sender == address(NPM), "NOT_NPM");
        // If the user pre-approved + called depositPosition(), the inner
        // safeTransferFrom triggers this callback with no data — config is
        // already set. Skip the decode in that case.
        if (configs[tokenId].depositor != address(0)) {
            return IERC721ReceiverMin.onERC721Received.selector;
        }
        require(data.length == 96, "BAD_RECEIVE_DATA");
        // 2026-06-15 audit HIGH fix: require operator == from for the
        // data-bearing transfer path so a third party with
        // ERC721.setApprovalForAll() over the user's NFT cannot
        // force-deposit it into the Compounder under
        // attacker-chosen (mode, minFeeMicros, maxSlippageBps).
        // The pre-approved + depositPosition() route is unaffected
        // (that path comes through depositPosition's onlyOwnerOf
        // guard and bypasses this decode branch via the early-return
        // above when configs is already set).
        // Parameter renamed from `operator` to `transferOperator` to
        // avoid shadowing the contract's state-level `operator` role.
        require(transferOperator == from, "OPERATOR_NOT_OWNER");
        (uint8 mode, uint64 minFeeMicros, uint16 maxSlippageBps) =
            abi.decode(data, (uint8, uint64, uint16));
        _writeConfig(tokenId, from, mode, minFeeMicros, maxSlippageBps);
        // Audit H1 fix: parallel of the cardinality bump in
        // depositPosition. The safeTransferFrom-with-data deposit path
        // (Integration A on the frontend) also needs the gate's TWAP
        // window pre-warmed; without this call, a position deposited
        // via the integrated mint flow would have an uninitialised
        // observation slot and its first compound would revert.
        _bumpObservationCardinality(tokenId);
        emit PositionDeposited(tokenId, from, mode, minFeeMicros, maxSlippageBps);
        return IERC721ReceiverMin.onERC721Received.selector;
    }

    // --------------------------------------------------------------------
    // User-facing custody
    // --------------------------------------------------------------------

    /// @notice Deposit a V3 LP NFT into auto-management. The caller MUST
    ///         have approved this contract (NPM.approve or
    ///         NPM.setApprovalForAll) before invoking — otherwise the
    ///         inner safeTransferFrom reverts. We use safeTransferFrom so
    ///         the same custody path triggers our onERC721Received hook
    ///         and any future ERC-721-aware NPMs handle the transfer
    ///         identically to a direct receive.
    function depositPosition(
        uint256 tokenId,
        uint8 mode,
        uint64 minFeeMicros,
        uint16 maxSlippageBps
    ) external whenNotPaused nonReentrant {
        require(configs[tokenId].depositor == address(0), "ALREADY_DEPOSITED");
        _writeConfig(tokenId, msg.sender, mode, minFeeMicros, maxSlippageBps);
        // The NPM transfer fires onERC721Received with empty data; the
        // callback no-ops because the config is already set.
        NPM.safeTransferFrom(msg.sender, address(this), tokenId);
        // Audit H1 fix: bump the pool's observation cardinality so the
        // _enforceTwapGate read inside compound() always finds a fresh
        // window of history. Cheap (one storage write per bump) and
        // idempotent.
        _bumpObservationCardinality(tokenId);
        emit PositionDeposited(tokenId, msg.sender, mode, minFeeMicros, maxSlippageBps);
    }

    /// @notice Pull the LP NFT back to the depositor wallet. Available
    ///         even when the contract is paused — pause must never lock
    ///         user assets.
    function withdrawPosition(uint256 tokenId) external onlyDepositor(tokenId) nonReentrant {
        address depositor = configs[tokenId].depositor;
        // Wipe the slot fully so a future re-deposit gets a clean state.
        delete configs[tokenId];
        NPM.safeTransferFrom(address(this), depositor, tokenId);
        emit PositionWithdrawn(tokenId, depositor);
    }

    /// @notice Change mode / threshold / slippage without withdrawing.
    function setMode(
        uint256 tokenId,
        uint8 mode,
        uint64 minFeeMicros,
        uint16 maxSlippageBps
    ) external whenNotPaused onlyDepositor(tokenId) {
        PositionConfig storage cfg = configs[tokenId];
        require(mode <= MODE_COMPOUND, "BAD_MODE");
        // 2026-06-15 audit HIGH fix: cap maxSlippageBps at
        // MAX_USER_SLIPPAGE_BPS so a phishing-signed setMode (or
        // depositor mistake) cannot disable the TWAP gate. Also
        // enforce MIN_FEE_MICROS_FLOOR here - the audit identified
        // this as a bypass of the depositPosition-time floor since
        // setMode wrote cfg.minFeeMicros directly without re-checking
        // the floor. _writeConfig has the same constraints; we mirror
        // them inline rather than route through it because setMode
        // intentionally does NOT touch the depositor field.
        require(
            maxSlippageBps <= MAX_USER_SLIPPAGE_BPS,
            "SLIPPAGE_OVER_CAP"
        );
        require(
            minFeeMicros >= MIN_FEE_MICROS_FLOOR,
            "MIN_FEE_TOO_LOW"
        );
        uint8 oldMode = cfg.mode;
        cfg.mode = mode;
        cfg.minFeeMicros = minFeeMicros;
        cfg.maxSlippageBps = maxSlippageBps;
        // 2026-06-15 audit LOW fix: reset the per-position cooldown so
        // a slippage upgrade does NOT take effect on a compound that
        // could be sandwiched in the same block. Without this, an
        // attacker who tricks the user into setMode(maxSlippageBps = 999)
        // could call compound() in the very same block and capture
        // the up-to-10% deviation the gate now permits. The reset
        // forces the attacker to wait out ACTION_COOLDOWN_SECONDS,
        // giving the user a real chance to setMode back or withdraw.
        cfg.lastActionAt = uint64(block.timestamp);
        emit ModeChanged(tokenId, oldMode, mode, minFeeMicros, maxSlippageBps);
    }

    // --------------------------------------------------------------------
    // Permissionless triggers
    // --------------------------------------------------------------------

    /// @notice Collect a position's fees and push them directly to the
    ///         depositor wallet. Reverts if (a) mode != RECEIVE, (b) the
    ///         5-minute cooldown is still active, or (c) the collected
    ///         total in either token is below the per-position threshold.
    /// @param maxAcceptableProtocolFeeBps Audit M1 fix: caller-set ceiling
    ///        on the protocol fee skim, prevents owner sandwich.
    /// @param deadline Audit M2 fix: caller-supplied UNIX deadline.
    function pushFees(
        uint256 tokenId,
        uint16 maxAcceptableProtocolFeeBps,
        uint256 deadline
    )
        external
        whenNotPaused
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        require(block.timestamp <= deadline, "DEADLINE_PASSED");
        require(
            protocolFeeBps <= maxAcceptableProtocolFeeBps,
            "FEE_BPS_OVER_CAP"
        );
        PositionConfig storage cfg = configs[tokenId];
        require(cfg.depositor != address(0), "NOT_DEPOSITED");
        require(cfg.mode == MODE_RECEIVE, "WRONG_MODE");
        _enforceCooldown(cfg);

        (amount0, amount1) = _collectFees(tokenId);
        _enforceMinFee(cfg, amount0, amount1);

        (, , address token0, address token1, , , , , , , , ) = NPM.positions(tokenId);

        (uint256 pf0, uint256 pf1) = _takeProtocolFee(token0, token1, amount0, amount1);
        amount0 -= pf0;
        amount1 -= pf1;

        if (amount0 > 0) require(IERC20Min(token0).transfer(cfg.depositor, amount0), "T0_FAIL");
        if (amount1 > 0) require(IERC20Min(token1).transfer(cfg.depositor, amount1), "T1_FAIL");

        emit FeesPushed(
            tokenId,
            msg.sender,
            cfg.depositor,
            amount0,
            amount1,
            pf0,
            pf1
        );
    }

    /// @dev Per-compound scratch state. Held in MEMORY (not stack) so
    ///      Solc 0.7.6's 16-slot stack limit does not bite when the
    ///      compound body has to track simultaneously: the two collected
    ///      fees, the two protocol fees, the two net amounts, the two
    ///      token addresses, the depositor, the three NPM return values,
    ///      and the two leftover amounts. The struct is allocated once
    ///      per call and lives only for the duration of compound().
    struct CompoundLocals {
        address depositor;
        address token0;
        address token1;
        uint256 fee0;
        uint256 fee1;
        uint256 pf0;
        uint256 pf1;
        uint256 net0;
        uint256 net1;
        uint128 liquidityAdded;
        uint256 amount0Used;
        uint256 amount1Used;
        uint256 leftover0;
        uint256 leftover1;
    }

    /// @notice Collect a position's fees and re-deposit them into the same
    ///         position via increaseLiquidity. Leftover tokens (the side
    ///         the current price + tick range cannot absorb) are returned
    ///         to the depositor wallet, with no in-protocol swap.
    /// @param amount0Min Slippage check passed straight through to NPM. UI
    ///        should derive this from configs[tokenId].maxSlippageBps
    ///        applied to a fresh quote so the on-chain check is current.
    /// @param amount1Min Same as amount0Min, for token1.
    /// @param maxAcceptableProtocolFeeBps Audit M1 fix: the caller commits to
    ///        a ceiling on the protocol fee that will be skimmed inside this
    ///        call. If the owner front-runs with `setProtocolFeeBps(higher)`,
    ///        the call reverts and the caller pays nothing. The cron should
    ///        read `protocolFeeBps()` immediately before this call and pass
    ///        that value (no buffer); a permissionless caller can pass a
    ///        higher tolerance if they want to opt into a wider window.
    /// @param deadline Audit M2 fix: caller-supplied UNIX deadline; the call
    ///        reverts if `block.timestamp > deadline`. Closes the prior
    ///        `block.timestamp + 60` tautology by making the gate meaningful
    ///        for held / replayed txs.
    function compound(
        uint256 tokenId,
        uint256 amount0Min,
        uint256 amount1Min,
        uint16 maxAcceptableProtocolFeeBps,
        uint256 deadline
    )
        external
        whenNotPaused
        nonReentrant
        returns (
            uint128 liquidityAdded,
            uint256 amount0Used,
            uint256 amount1Used
        )
    {
        require(block.timestamp <= deadline, "DEADLINE_PASSED");
        require(
            protocolFeeBps <= maxAcceptableProtocolFeeBps,
            "FEE_BPS_OVER_CAP"
        );
        PositionConfig storage cfg = configs[tokenId];
        require(cfg.depositor != address(0), "NOT_DEPOSITED");
        require(cfg.mode == MODE_COMPOUND, "WRONG_MODE");
        _enforceCooldown(cfg);

        CompoundLocals memory s;
        s.depositor = cfg.depositor;
        (s.fee0, s.fee1) = _collectFees(tokenId);
        _enforceMinFee(cfg, s.fee0, s.fee1);

        _runCompound(tokenId, amount0Min, amount1Min, s);

        liquidityAdded = s.liquidityAdded;
        amount0Used = s.amount0Used;
        amount1Used = s.amount1Used;
    }

    /// @dev All the post-collect work of compound() lives here so the
    ///      external function's stack frame stays under the Solc 0.7.6
    ///      classic-codegen limit. The struct argument is by reference
    ///      (memory) so the write-backs are visible to the caller.
    function _runCompound(
        uint256 tokenId,
        uint256 amount0Min,
        uint256 amount1Min,
        CompoundLocals memory s
    ) internal {
        // Audit H1 fix: TWAP-anchored price-deviation gate runs BEFORE
        // any state-changing call. If the pool's spot price has drifted
        // more than cfg.maxSlippageBps from its 60s TWAP, the compound
        // reverts unconditionally — regardless of what mins the caller
        // passed. This closes the permissionless-caller hole and makes
        // cfg.maxSlippageBps a real on-chain enforcement (previously it
        // was decorative; the cron's H1 commit derived mins off-chain
        // but a direct attacker bypassed that).
        _enforceTwapGate(tokenId, configs[tokenId].maxSlippageBps);

        (s.token0, s.token1) = _tokensOf(tokenId);
        (s.pf0, s.pf1) = _takeProtocolFee(s.token0, s.token1, s.fee0, s.fee1);
        s.net0 = s.fee0 - s.pf0;
        s.net1 = s.fee1 - s.pf1;
        if (s.net0 > 0) _safeApprove(s.token0, address(NPM), s.net0);
        if (s.net1 > 0) _safeApprove(s.token1, address(NPM), s.net1);

        // Clamp min amounts to what we actually hold post-protocol-fee —
        // passing a value above net would unconditionally revert inside
        // NPM. Reading from the struct keeps the local frame tiny.
        (s.liquidityAdded, s.amount0Used, s.amount1Used) = NPM.increaseLiquidity(
            INonfungiblePositionManager.IncreaseLiquidityParams({
                tokenId: tokenId,
                amount0Desired: s.net0,
                amount1Desired: s.net1,
                amount0Min: amount0Min > s.net0 ? s.net0 : amount0Min,
                amount1Min: amount1Min > s.net1 ? s.net1 : amount1Min,
                deadline: block.timestamp + TX_DEADLINE_BUFFER_SECONDS
            })
        );

        s.leftover0 = s.net0 - s.amount0Used;
        s.leftover1 = s.net1 - s.amount1Used;
        if (s.leftover0 > 0) {
            require(IERC20Min(s.token0).transfer(s.depositor, s.leftover0), "L0_FAIL");
        }
        if (s.leftover1 > 0) {
            require(IERC20Min(s.token1).transfer(s.depositor, s.leftover1), "L1_FAIL");
        }
        // Reset NPM allowance to 0 so USDT-style approve-from-nonzero
        // quirks do not bite the next compound.
        if (s.net0 > 0) _safeApprove(s.token0, address(NPM), 0);
        if (s.net1 > 0) _safeApprove(s.token1, address(NPM), 0);

        emit Compounded(
            tokenId,
            msg.sender,
            s.fee0,
            s.fee1,
            s.pf0,
            s.pf1,
            s.liquidityAdded,
            s.amount0Used,
            s.amount1Used,
            s.leftover0,
            s.leftover1
        );
    }

    /// @dev Convenience: extract just the token pair from NPM.positions().
    ///      Used by both pushFees and the compound helpers; an indirect
    ///      read keeps the call-site frame compact.
    function _tokensOf(uint256 tokenId)
        internal
        view
        returns (address token0, address token1)
    {
        (, , token0, token1, , , , , , , , ) = NPM.positions(tokenId);
    }

    /// @dev Audit H1 fix: TWAP-anchored price-deviation gate. Reverts
    ///      if the pool's spot price has drifted more than the
    ///      depositor-configured slippage tolerance from its 60-second
    ///      TWAP. The check is the contract-level MEV defence for
    ///      compound() — a sandwicher would have to either hold the
    ///      manipulation across the whole TWAP window (which is
    ///      capital-inefficient at Arc block times) or settle for a
    ///      tilt below the depositor's bps cap (in which case the
    ///      attack profit is bounded by that same cap and is no longer
    ///      free).
    ///
    ///      The pool's observation cardinality must be >= 2 for
    ///      observe() to succeed. depositPosition + onERC721Received
    ///      both bump cardinality to TARGET_OBSERVATION_CARDINALITY on
    ///      first touch so a never-deposited pool's first compound
    ///      finds the buffer pre-warmed. Pools touched out-of-band
    ///      (an unrelated mint elsewhere bumped them already) skip the
    ///      bump cheaply.
    function _enforceTwapGate(uint256 tokenId, uint16 maxSlippageBps)
        internal
        view
    {
        (, , address t0, address t1, uint24 fee, , , , , , , ) = NPM.positions(tokenId);
        address pool = FACTORY.getPool(t0, t1, fee);
        require(pool != address(0), "NO_POOL");

        // Spot tick from slot0.
        (, int24 currentTick, , , , , ) = IUniswapV3PoolMin(pool).slot0();

        // 60-second TWAP via the pool's observation oracle. The
        // secondsAgos array is [TWAP_WINDOW_SECONDS, 0] which asks
        // the pool for "the tick cumulative TWAP_WINDOW_SECONDS ago"
        // and "the tick cumulative now". Their difference, divided
        // by the window length, is the average tick over the window.
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = TWAP_WINDOW_SECONDS;
        secondsAgos[1] = 0;
        (int56[] memory tickCumulatives, ) =
            IUniswapV3PoolMin(pool).observe(secondsAgos);
        int56 tickDelta = tickCumulatives[1] - tickCumulatives[0];
        int24 twapTick = int24(tickDelta / int56(uint56(TWAP_WINDOW_SECONDS)));
        // 2026-06-15 audit LOW fix: Solidity truncates toward zero. For
        // a negative `tickDelta` not divisible by TWAP_WINDOW_SECONDS,
        // the truncation rounds the quotient *up* (less negative) by 1
        // tick, which is the off-by-one Uniswap's OracleLibrary.consult
        // closes explicitly. Mirror their fix so the floor goes toward
        // -infinity. Asymmetric impact (~1 bp on a 50 bp gate) but
        // free to apply.
        if (
            tickDelta < 0 &&
            (tickDelta % int56(uint56(TWAP_WINDOW_SECONDS))) != 0
        ) {
            twapTick = twapTick - 1;
        }

        // Tick distance in absolute value. Each tick is ~1 bp of
        // price (the exact relationship is 1.0001^tick, so 1 tick =
        // ~0.9999 bp; over the 1-1000 bp range users actually pick,
        // the approximation is within 5% of the true sqrt-price
        // distance). Using ticks directly avoids the gas + bytecode
        // weight of a sqrtPriceX96 deviation calculation in 0.7.6.
        int24 diff = currentTick > twapTick
            ? currentTick - twapTick
            : twapTick - currentTick;
        require(uint24(diff) <= uint24(maxSlippageBps), "PRICE_DEVIATION");
    }

    /// @dev Audit H1 fix: bump the pool's observation cardinality to
    ///      TARGET_OBSERVATION_CARDINALITY so the TWAP gate has at
    ///      least one full window of history. Called from
    ///      depositPosition and onERC721Received on every new deposit.
    ///      Pools already at-or-above the target skip the call; pools
    ///      below pay the one-time ~SSTORE-per-slot cost (~5-100k gas
    ///      depending on starting cardinality). Idempotent and safe to
    ///      double-call: the pool itself short-circuits on no-op.
    function _bumpObservationCardinality(uint256 tokenId) internal {
        (, , address t0, address t1, uint24 fee, , , , , , , ) = NPM.positions(tokenId);
        address pool = FACTORY.getPool(t0, t1, fee);
        if (pool == address(0)) return;
        (, , , , uint16 nextCardinality, , ) = IUniswapV3PoolMin(pool).slot0();
        if (nextCardinality >= TARGET_OBSERVATION_CARDINALITY) return;
        // Wrap in try/catch defensively: a malicious pool could revert
        // here to grief deposits, but the gate's failure mode is just
        // that compound() reverts later — the user can still withdraw.
        try
            IUniswapV3PoolMin(pool).increaseObservationCardinalityNext(
                TARGET_OBSERVATION_CARDINALITY
            )
        {} catch {}
    }

    // --------------------------------------------------------------------
    // Internal helpers
    // --------------------------------------------------------------------

    function _writeConfig(
        uint256 tokenId,
        address depositor,
        uint8 mode,
        uint64 minFeeMicros,
        uint16 maxSlippageBps
    ) internal {
        require(mode <= MODE_COMPOUND, "BAD_MODE");
        // 2026-06-15 audit HIGH fix: cap maxSlippageBps at
        // MAX_USER_SLIPPAGE_BPS on the deposit-time path too, not
        // just BPS_DENOMINATOR. Same reasoning as setMode: the TWAP
        // gate's tick-as-bp approximation only holds within
        // ~1-1000 bps; above that the gate is effectively disabled.
        require(
            maxSlippageBps <= MAX_USER_SLIPPAGE_BPS,
            "SLIPPAGE_OVER_CAP"
        );
        // Audit H2 fix: enforce both gates on every config write —
        // depositPosition, onERC721Received, AND setMode. Threshold
        // floor stops the dust DoS; factory gate stops deposits of
        // NFTs whose underlying pool was never deployed by the
        // canonical Arcade V3 factory.
        require(minFeeMicros >= MIN_FEE_MICROS_FLOOR, "MIN_FEE_TOO_LOW");
        _requireFactoryPool(tokenId);
        configs[tokenId] = PositionConfig({
            depositor: depositor,
            mode: mode,
            maxSlippageBps: maxSlippageBps,
            lastActionAt: 0,
            minFeeMicros: minFeeMicros
        });
    }

    /// @dev Audit H2 fix: assert the position's token pair has a pool
    ///      deployed on the Arcade V3 factory. Foreign NPM NFTs would
    ///      satisfy NPM.positions(tokenId) but their pool would not
    ///      exist on our factory; this guard rejects them at deposit
    ///      time so the user never custodies a position the contract
    ///      cannot manage.
    function _requireFactoryPool(uint256 tokenId) internal view {
        (, , address t0, address t1, uint24 fee, , , , , , , ) = NPM.positions(tokenId);
        require(FACTORY.getPool(t0, t1, fee) != address(0), "POOL_NOT_FOUND");
    }

    function _enforceCooldown(PositionConfig storage cfg) internal {
        require(
            block.timestamp >= uint256(cfg.lastActionAt) + ACTION_COOLDOWN_SECONDS,
            "COOLDOWN"
        );
        // Updating BEFORE the external calls means a re-entry attempt (if
        // any token transfer were ever weaponised through a hook on a
        // future NPM upgrade) finds the cooldown already armed and bails.
        cfg.lastActionAt = uint64(block.timestamp);
    }

    function _enforceMinFee(
        PositionConfig storage cfg,
        uint256 amount0,
        uint256 amount1
    ) internal view {
        // Threshold check uses MAX(amount0, amount1) rather than a sum so
        // a position whose fees accrue mostly to one side still triggers
        // — the UI quotes via the V3 quoter to a USDC value before
        // setting the threshold, so cross-token comparison is safe at
        // the UX level.
        uint256 best = amount0 > amount1 ? amount0 : amount1;
        require(best >= uint256(cfg.minFeeMicros), "BELOW_THRESHOLD");
    }

    function _collectFees(uint256 tokenId)
        internal
        returns (uint256 amount0, uint256 amount1)
    {
        (amount0, amount1) = NPM.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
    }

    function _takeProtocolFee(
        address token0,
        address token1,
        uint256 amount0,
        uint256 amount1
    ) internal returns (uint256 pf0, uint256 pf1) {
        // Snapshot once so a mid-tx setProtocolFeeBps cannot widen the cut
        // against a position that was scanned at the old rate. The admin
        // path setter still validates the ceiling.
        uint16 feeBps = protocolFeeBps;
        if (feeBps == 0) return (0, 0);
        pf0 = (amount0 * feeBps) / BPS_DENOMINATOR;
        pf1 = (amount1 * feeBps) / BPS_DENOMINATOR;
        address recipient = feeRecipient;
        if (pf0 > 0) require(IERC20Min(token0).transfer(recipient, pf0), "PF0_FAIL");
        if (pf1 > 0) require(IERC20Min(token1).transfer(recipient, pf1), "PF1_FAIL");
    }

    /// @dev USDT-style ERC-20s revert when you try to increase a non-zero
    ///      allowance. Force-reset to zero before setting the new value
    ///      so we work even if the user's pool pairs against USDT later.
    function _safeApprove(address token, address spender, uint256 amount) internal {
        IERC20Min t = IERC20Min(token);
        uint256 current = t.allowance(address(this), spender);
        if (current == amount) return;
        if (current != 0 && amount != 0) {
            require(t.approve(spender, 0), "APPROVE_RESET");
        }
        require(t.approve(spender, amount), "APPROVE_SET");
    }

    // --------------------------------------------------------------------
    // Admin
    // --------------------------------------------------------------------

    function setOperator(address newOperator) external onlyOwner {
        emit OperatorSet(operator, newOperator);
        operator = newOperator;
    }

    function setProtocolFeeBps(uint16 newBps) external onlyOwner {
        require(newBps <= MAX_PROTOCOL_FEE_BPS, "FEE_TOO_HIGH");
        emit ProtocolFeeBpsSet(protocolFeeBps, newBps);
        protocolFeeBps = newBps;
    }

    function setFeeRecipient(address newRecipient) external onlyOwner {
        require(newRecipient != address(0), "ZERO_FEE_RECIPIENT");
        emit FeeRecipientSet(feeRecipient, newRecipient);
        feeRecipient = newRecipient;
    }

    /// @notice Audit I6 fix: two-step ownership transfer. The previous
    ///         single-step implementation would brick the contract if
    ///         the owner sent transferOwnership(WRONG_ADDR). The new
    ///         flow stores the proposed owner in `pendingOwner`; the
    ///         actual ownership change only happens when the proposed
    ///         owner calls `acceptOwnership` themselves, which proves
    ///         they hold the key. Cancellable: the current owner can
    ///         call transferOwnership(address(this)) or any other
    ///         non-zero address to overwrite the pending slot, OR
    ///         transferOwnership(owner) to clear it cheaply.
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ZERO_OWNER");
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "NOT_PENDING_OWNER");
        emit OwnerSet(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PausedSet(_paused);
    }

    // --------------------------------------------------------------------
    // Read helpers (for indexers + frontend)
    // --------------------------------------------------------------------

    /// @notice Returns the most-recent uncollected fees on a position as
    ///         reported by NPM.positions().tokensOwed0/1. The backend
    ///         scanner uses this + a USDC quote to decide whether a
    ///         position is eligible for compound / pushFees. Reverts if
    ///         the token is not deposited (callers should query that
    ///         first via configs(tokenId)).
    function pendingFees(uint256 tokenId)
        external
        view
        returns (uint256 fees0, uint256 fees1)
    {
        require(configs[tokenId].depositor != address(0), "NOT_DEPOSITED");
        (, , , , , , , , , , uint128 tokensOwed0, uint128 tokensOwed1) =
            NPM.positions(tokenId);
        fees0 = uint256(tokensOwed0);
        fees1 = uint256(tokensOwed1);
    }

    /// @notice Surface the cooldown deadline so the UI can render a
    ///         "ready in HH:MM" countdown without reading the raw config
    ///         and doing the math itself.
    function nextActionAvailableAt(uint256 tokenId) external view returns (uint64) {
        uint64 last = configs[tokenId].lastActionAt;
        if (last == 0) return uint64(block.timestamp);
        return last + ACTION_COOLDOWN_SECONDS;
    }
}
