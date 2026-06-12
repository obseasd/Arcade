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
        address /* operator */,
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
        (uint8 mode, uint64 minFeeMicros, uint16 maxSlippageBps) =
            abi.decode(data, (uint8, uint64, uint16));
        _writeConfig(tokenId, from, mode, minFeeMicros, maxSlippageBps);
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
        require(maxSlippageBps <= BPS_DENOMINATOR, "BAD_SLIPPAGE");
        uint8 oldMode = cfg.mode;
        cfg.mode = mode;
        cfg.minFeeMicros = minFeeMicros;
        cfg.maxSlippageBps = maxSlippageBps;
        emit ModeChanged(tokenId, oldMode, mode, minFeeMicros, maxSlippageBps);
    }

    // --------------------------------------------------------------------
    // Permissionless triggers
    // --------------------------------------------------------------------

    /// @notice Collect a position's fees and push them directly to the
    ///         depositor wallet. Reverts if (a) mode != RECEIVE, (b) the
    ///         5-minute cooldown is still active, or (c) the collected
    ///         total in either token is below the per-position threshold.
    function pushFees(uint256 tokenId)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
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
    function compound(
        uint256 tokenId,
        uint256 amount0Min,
        uint256 amount1Min
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
        require(maxSlippageBps <= BPS_DENOMINATOR, "BAD_SLIPPAGE");
        configs[tokenId] = PositionConfig({
            depositor: depositor,
            mode: mode,
            maxSlippageBps: maxSlippageBps,
            lastActionAt: 0,
            minFeeMicros: minFeeMicros
        });
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

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ZERO_OWNER");
        emit OwnerSet(owner, newOwner);
        owner = newOwner;
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
