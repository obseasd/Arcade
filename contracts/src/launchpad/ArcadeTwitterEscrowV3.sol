// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IArcadeV3Locker {
    function updateRecipient(uint256 positionId, uint256 index, address newRecipient) external;
    function updateAdmin(uint256 positionId, uint256 index, address newAdmin) external;
    function withdrawPending(address token) external returns (uint256 amount);
}

/**
 * @title ArcadeTwitterEscrow v3
 * @notice Holds Clanker LP fees attributed to a Twitter handle until the
 *         verified owner claims them. Rewrite of the v2 contract addressing
 *         the audit findings F-1 to F-10.
 *
 *         Key differences from v2 (intentional break - frontend must be
 *         updated to point at the v3 address):
 *           1. ONE claim path only (`authorize` + `claimByTwitter`). The
 *              legacy direct `claim()` flow is gone — same typehash for both
 *              flows let attackers bypass the timelock/veto window. (F-1, F-8)
 *           2. Trusted signer is MUTABLE via `setTrustedSigner`. Compromise
 *              of the Vercel key no longer means the contract is bricked. (F-2)
 *           3. `pause` / `unpause` blocks `authorize` and `claimByTwitter`
 *              (but never `veto` or `creditSlot`). (F-2)
 *           4. PER-SLOT on-chain accounting: the locker must call
 *              `creditSlot(positionId, slot, token, amount)` when routing
 *              fees here. Claims fail with `InsufficientBalance` if the
 *              backend signs over an amount that wasn't credited. (F-3)
 *           5. `rescue()` is bounded: can only sweep tokens NOT earmarked
 *              by `creditedTotal[token]`. Owner cannot confiscate pending
 *              user balances. (F-4)
 *           6. `Ownable2Step` for ownership transfer (typos no longer brick
 *              the contract). (F-5)
 *           7. Locker `updateRecipient` / `updateAdmin` calls are in
 *              try/catch; the user always gets their tokens even if rotation
 *              reverts. A `RotationFailed` event lets the backend retry
 *              out-of-band. (F-6)
 *           8. `pairedToken != clankerToken` invariant in `_settle` (or one
 *              of the amounts is zero). (F-10)
 *           9. `deadline` stored as `uint256` (no uint64 truncation). (F-9)
 *          10. `ReentrancyGuard` on `claimByTwitter` for defense-in-depth.
 *
 *         Storage is a clean break: v3 starts with empty balances. Any
 *         leftover pending claims on v2 stay claimable on v2.
 *
 *         To use this contract, the V3 locker (or any future depositor) MUST
 *         call `creditSlot` whenever it routes fees here. Sending tokens
 *         without calling `creditSlot` leaves them unrecoverable except via
 *         `rescue` (since they aren't in `creditedTotal`, the rescue path
 *         can still sweep them).
 */
contract ArcadeTwitterEscrowV3 is Ownable2Step, Pausable, ReentrancyGuard {
    using ECDSA for bytes32;
    using SafeERC20 for IERC20;

    // ====================== Wiring ======================

    /// @notice Authorised depositor (the V3 locker). Settable ONCE post-
    ///         construct via `setLocker` to resolve the mutual constructor
    ///         dependency with the locker (locker needs the escrow address;
    ///         escrow needs the locker address). After the first set, this
    ///         is effectively immutable.
    address public LOCKER;
    bytes32 private immutable _DOMAIN_SEPARATOR_CACHED;
    uint256 private immutable _CACHED_CHAIN_ID;

    bytes32 private constant CLAIM_TYPEHASH = keccak256(
        "Claim(uint256 positionId,uint256 slotIndex,address recipient,address pairedToken,uint256 pairedAmount,address clankerToken,uint256 clankerAmount,uint256 deadline,bytes32 nonce)"
    );

    /// @notice Maximum value the owner can set for `claimTimelock`. Caps DOS
    ///         potential while leaving room for a 7-day mainnet timelock.
    uint64 public constant MAX_TIMELOCK = 7 days;

    /// @notice Minimum value the owner can set for `claimTimelock`. Enforces a
    ///         non-zero veto window so the F-1/F-8 safety net is never
    ///         accidentally disabled by setting timelock = 0.
    uint64 public constant MIN_TIMELOCK = 1 hours;

    /// @notice Default timelock applied at construction so the veto window is
    ///         active from block one, even if the owner forgets to call
    ///         setClaimTimelock post-deploy.
    uint64 public constant DEFAULT_TIMELOCK = 1 hours;

    /// @notice After this many seconds of no `creditSlot` activity on a
    ///         (positionId, slotIndex), the owner can forfeit any credited
    ///         balance via `forfeitStaleClaim`. Designed for the abandoned-
    ///         handle case: Twitter user never appears, the platform owner
    ///         can route the locked balance elsewhere (treasury, refund to
    ///         creator, charity) instead of letting it sit forever. The
    ///         180-day default gives a real claimant ample time to surface.
    uint64 public constant FORFEIT_DELAY = 180 days;

    // ====================== Mutable security primitives ======================

    /// @notice Backend signer. Mutable so a compromised key can be rotated
    ///         without redeploying the escrow.
    address public trustedSigner;

    /// @notice Delay between `authorize` and the earliest `claimByTwitter`.
    ///         Snapshotted into `pendingClaims[nonce].executeAfter` at
    ///         authorize time — changing this never affects in-flight claims.
    uint64 public claimTimelock;

    // ====================== Per-slot accounting (F-3) ======================

    /// @notice On-chain accounting: amount credited to each (positionId, slot,
    ///         token). The locker writes here via `creditSlot`. Claims debit
    ///         from this. Backend over-attestation reverts with
    ///         `InsufficientBalance`.
    mapping(uint256 positionId => mapping(uint256 slotIndex => mapping(address token => uint256))) public balances;

    /// @notice Sum of `balances[*][*][token]` across all slots. Used by
    ///         `rescue` to refuse touching user-earmarked balances.
    mapping(address token => uint256) public creditedTotal;

    /// @notice Timestamp of the last `creditSlot` call for each
    ///         (positionId, slotIndex). Anchors the FORFEIT_DELAY window
    ///         for `forfeitStaleClaim`. 0 means never credited.
    mapping(uint256 positionId => mapping(uint256 slotIndex => uint64)) public lastCreditedAt;

    // ====================== Claim state ======================

    mapping(uint256 positionId => mapping(uint256 slotIndex => bool)) public claimed;
    mapping(bytes32 => bool) public nonceUsed;
    mapping(uint256 positionId => mapping(uint256 slotIndex => bool)) public hasPending;
    mapping(bytes32 nonce => PendingClaim) public pendingClaims;

    struct PendingClaim {
        address recipient;
        address pairedToken;
        uint256 pairedAmount;
        address clankerToken;
        uint256 clankerAmount;
        uint256 positionId;
        uint256 slotIndex;
        uint256 executeAfter;
        uint256 deadline;
        bool consumed;
        bool vetoed;
    }

    // ====================== Events ======================

    event Claimed(
        uint256 indexed positionId,
        uint256 indexed slotIndex,
        address indexed recipient,
        address pairedToken,
        uint256 pairedAmount,
        address clankerToken,
        uint256 clankerAmount
    );
    event Authorized(bytes32 indexed nonce, uint256 indexed positionId, uint256 indexed slotIndex, uint256 executeAfter);
    event Vetoed(bytes32 indexed nonce);
    event TimelockChanged(uint64 newTimelock);
    event Rescued(address indexed token, address indexed to, uint256 amount);
    event Credited(uint256 indexed positionId, uint256 indexed slotIndex, address indexed token, uint256 amount);
    event TrustedSignerUpdated(address indexed previous, address indexed next);
    event RotationFailed(uint256 indexed positionId, uint256 indexed slotIndex, bytes reason);
    event LockerSet(address indexed locker);
    event Forfeited(
        uint256 indexed positionId,
        uint256 indexed slotIndex,
        address indexed to,
        address pairedToken,
        uint256 pairedAmount,
        address clankerToken,
        uint256 clankerAmount
    );

    // ====================== Errors ======================

    error Expired();
    error AlreadyClaimed();
    error NonceReused();
    error InvalidSignature();
    error ZeroAddress();
    error NotLocker();
    error LockerNotSet();
    error LockerAlreadySet();
    error NotAuthorized();
    error Timelocked();
    error TimelockTooLong();
    error TimelockTooShort();
    error Already();
    error SlotPending();
    error InsufficientBalance();
    error ExceedsFreeBalance();
    error InvalidTokens();
    error DeadlineInPast();
    error NothingToClaim();
    error RenounceDisabled();
    error SlotAlreadyClaimed();
    error NotStaleYet();

    // ====================== Construction ======================

    /// @param trustedSigner_ Backend EIP-712 signer. Must be non-zero.
    /// @param owner_         Initial owner (typically a multisig).
    constructor(address trustedSigner_, address owner_) Ownable(owner_) {
        if (trustedSigner_ == address(0)) revert ZeroAddress();
        trustedSigner = trustedSigner_;
        // H-01: ship with a live veto window. The F-1/F-8 safety net depended
        // on the owner remembering to call setClaimTimelock right after deploy.
        // Default to 1 hour so even an unconfigured escrow is not drainable
        // in a single tx by a compromised signer.
        claimTimelock = DEFAULT_TIMELOCK;
        _CACHED_CHAIN_ID = block.chainid;
        _DOMAIN_SEPARATOR_CACHED = _buildDomainSeparator();
        emit TrustedSignerUpdated(address(0), trustedSigner_);
        emit TimelockChanged(DEFAULT_TIMELOCK);
    }

    /// @notice One-shot setter the deployer calls after deploying the locker
    ///         at its predicted (CREATE-derived) address. Reverts on second
    ///         call so the wiring is effectively immutable post-bootstrap.
    function setLocker(address locker_) external onlyOwner {
        if (locker_ == address(0)) revert ZeroAddress();
        if (LOCKER != address(0)) revert LockerAlreadySet();
        LOCKER = locker_;
        emit LockerSet(locker_);
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        if (block.chainid == _CACHED_CHAIN_ID) return _DOMAIN_SEPARATOR_CACHED;
        return _buildDomainSeparator();
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ArcadeTwitterEscrow"),
                keccak256("3"),
                block.chainid,
                address(this)
            )
        );
    }

    // ====================== Deposit (F-3) ======================

    /**
     * @notice The locker calls this when it routes a slot's fees here, so
     *         the escrow can track per-slot balances and prevent backend
     *         over-attestation from draining the shared pool.
     *
     *         The locker is expected to have transferred `amount` of `token`
     *         to this contract BEFORE (or in the same tx as) this call. We
     *         do not verify the transfer because the locker is trusted; if
     *         we ever add other depositor roles, switch to a balance-diff
     *         check.
     */
    function creditSlot(uint256 positionId, uint256 slotIndex, address token, uint256 amount) external {
        // Belt-and-suspenders: LOCKER == 0 means setLocker was never called,
        // in which case msg.sender == 0 would be the only "match" - which
        // can't happen, but we reject explicitly for clarity.
        if (LOCKER == address(0)) revert LockerNotSet();
        if (msg.sender != LOCKER) revert NotLocker();
        if (token == address(0)) revert ZeroAddress();
        // H-03: refuse credits to an already-claimed slot. The slot's recipient
        // on the locker SHOULD have been rotated by claimByTwitter so further
        // collectFees calls don't route here, but if updateRecipient failed in
        // the try/catch we'd silently strand fees forever. Reverting here lets
        // the locker's own try/catch route the amount to its pendingWithdrawals
        // ledger for the escrow's address, recoverable via pullFromLocker.
        if (claimed[positionId][slotIndex]) revert SlotAlreadyClaimed();
        balances[positionId][slotIndex][token] += amount;
        creditedTotal[token] += amount;
        // Anchor the staleness clock at every credit. As long as the locker
        // routes fees here, the slot stays "active" and never becomes
        // forfeit-eligible. Only goes idle when no one is collecting fees
        // anymore (token abandoned, etc).
        lastCreditedAt[positionId][slotIndex] = uint64(block.timestamp);
        emit Credited(positionId, slotIndex, token, amount);
    }

    // ====================== Authorize (Step 1 of 2) ======================

    /**
     * @notice Deposit a backend-signed claim authorization on-chain. The
     *         actual transfer happens later via `claimByTwitter`, optionally
     *         after a delay (`claimTimelock`). The recipient receives nothing
     *         from this call.
     *
     *         The balance check IS done here (not just at claim time) so a
     *         malformed signature fails fast and never enters the timelock.
     */
    function authorize(
        uint256 positionId,
        uint256 slotIndex,
        address recipient,
        address pairedToken,
        uint256 pairedAmount,
        address clankerToken,
        uint256 clankerAmount,
        uint256 deadline,
        bytes32 nonce,
        bytes calldata signature
    ) external whenNotPaused {
        if (deadline < block.timestamp) revert DeadlineInPast();
        if (recipient == address(0)) revert ZeroAddress();
        if (claimed[positionId][slotIndex]) revert AlreadyClaimed();
        if (hasPending[positionId][slotIndex]) revert SlotPending();
        if (nonceUsed[nonce]) revert NonceReused();
        if (pendingClaims[nonce].executeAfter != 0) revert Already();
        if (
            _recover(positionId, slotIndex, recipient, pairedToken, pairedAmount, clankerToken, clankerAmount, deadline, nonce, signature)
                != trustedSigner
        ) revert InvalidSignature();

        // F-3: hard balance check. Backend over-attestation reverts here.
        // Signed amounts act as a MINIMUM at claim time (the user is
        // guaranteed at least this much); the claim itself sweeps the full
        // current balance to avoid stranding fees credited after authorize.
        if (pairedAmount > balances[positionId][slotIndex][pairedToken]) revert InsufficientBalance();
        if (clankerAmount > balances[positionId][slotIndex][clankerToken]) revert InsufficientBalance();

        // M-11: refuse an authorization that would brick the slot for nothing.
        // If both tokens have zero balance at authorize time, the claim would
        // mark `claimed[slot]=true` and permanently freeze any future credits
        // (per H-03 logic). Reject so the slot stays open until real fees land.
        if (
            balances[positionId][slotIndex][pairedToken] == 0
                && balances[positionId][slotIndex][clankerToken] == 0
        ) revert NothingToClaim();

        // F-10 + audit (escrow-same-token-aliasing-credit-corruption):
        // refuse ANY authorize where pairedToken == clankerToken, not just
        // the case where both amounts are non-zero. The previous gate let
        // through a single-side auth (eg pairedAmount=100, clankerAmount=0)
        // where the SAME token is on both sides. At claim time, both
        // actualPaired and actualClanker read from the SAME balance line,
        // and the effects block then debits creditedTotal[token] TWICE for
        // the same physical balance. The transfer side has its own
        // `pairedToken != clankerToken` guard so funds aren't double-sent,
        // but creditedTotal underflows / under-counts, breaking rescue()
        // accounting and letting the owner sweep more than intended.
        if (pairedToken == clankerToken) revert InvalidTokens();

        uint256 executeAfter = block.timestamp + claimTimelock;
        pendingClaims[nonce] = PendingClaim({
            recipient: recipient,
            pairedToken: pairedToken,
            pairedAmount: pairedAmount,
            clankerToken: clankerToken,
            clankerAmount: clankerAmount,
            positionId: positionId,
            slotIndex: slotIndex,
            executeAfter: executeAfter,
            deadline: deadline,
            consumed: false,
            vetoed: false
        });
        nonceUsed[nonce] = true;
        hasPending[positionId][slotIndex] = true;

        emit Authorized(nonce, positionId, slotIndex, executeAfter);
    }

    // ====================== Claim (Step 2 of 2) ======================

    /**
     * @notice Execute a previously-authorized claim. Permissionless: anyone
     *         can pay the gas; funds always go to the `recipient` stored at
     *         authorize time. `whenNotPaused` so the owner can freeze claims
     *         under incident response; `nonReentrant` for defense-in-depth.
     */
    function claimByTwitter(bytes32 nonce) external whenNotPaused nonReentrant {
        PendingClaim storage p = pendingClaims[nonce];
        if (p.executeAfter == 0) revert NotAuthorized();
        if (p.consumed) revert AlreadyClaimed();
        if (p.vetoed) revert AlreadyClaimed();
        if (claimed[p.positionId][p.slotIndex]) revert AlreadyClaimed();
        if (block.timestamp < p.executeAfter) revert Timelocked();
        if (block.timestamp > p.deadline) revert Expired();

        // Snapshot the addresses + slot from the authorized claim.
        uint256 positionId = p.positionId;
        uint256 slotIndex = p.slotIndex;
        address recipient = p.recipient;
        address pairedToken = p.pairedToken;
        address clankerToken = p.clankerToken;
        uint256 signedPaired = p.pairedAmount;
        uint256 signedClanker = p.clankerAmount;

        // H-04: sweep the CURRENT credited balance, not the snapshot from
        // authorize. The locker is permissionless to call collectFees, so any
        // fees credited during the timelock window would otherwise be
        // permanently stranded (the per-slot `claimed` flag becomes true after
        // this call and blocks future authorize). Signed amounts act as a
        // minimum guarantee — re-check below ensures the actual balance is at
        // least what the backend signed for.
        uint256 actualPaired = balances[positionId][slotIndex][pairedToken];
        uint256 actualClanker = balances[positionId][slotIndex][clankerToken];

        if (signedPaired > actualPaired) revert InsufficientBalance();
        if (signedClanker > actualClanker) revert InsufficientBalance();

        // Effects (CEI).
        p.consumed = true;
        claimed[positionId][slotIndex] = true;
        hasPending[positionId][slotIndex] = false;
        if (actualPaired > 0) {
            balances[positionId][slotIndex][pairedToken] = 0;
            creditedTotal[pairedToken] -= actualPaired;
        }
        if (actualClanker > 0) {
            balances[positionId][slotIndex][clankerToken] = 0;
            creditedTotal[clankerToken] -= actualClanker;
        }

        // Interactions: transfers first (CEI), then locker rotation in try/catch.
        if (actualPaired > 0) IERC20(pairedToken).safeTransfer(recipient, actualPaired);
        if (actualClanker > 0 && pairedToken != clankerToken) {
            IERC20(clankerToken).safeTransfer(recipient, actualClanker);
        }

        // F-6: rotation is best-effort. If the locker reverts (slot already
        // rotated, locker upgraded, etc), the user STILL gets their tokens.
        // Backend can retry rotation out-of-band by reading the event.
        try IArcadeV3Locker(LOCKER).updateRecipient(positionId, slotIndex, recipient) {
            // ok
        } catch (bytes memory reason) {
            emit RotationFailed(positionId, slotIndex, reason);
        }
        try IArcadeV3Locker(LOCKER).updateAdmin(positionId, slotIndex, recipient) {
            // ok
        } catch (bytes memory reason) {
            emit RotationFailed(positionId, slotIndex, reason);
        }

        emit Claimed(positionId, slotIndex, recipient, pairedToken, actualPaired, clankerToken, actualClanker);
    }

    // ====================== Veto ======================

    /**
     * @notice Cancel a pending authorization. Use case: backend key
     *         suspected compromised; veto suspicious claims during the
     *         timelock window. Cannot be reversed. Frees the slot so the
     *         signer can issue a fresh nonce.
     */
    function veto(bytes32 nonce) external onlyOwner {
        PendingClaim storage p = pendingClaims[nonce];
        if (p.executeAfter == 0) revert NotAuthorized();
        if (p.consumed) revert AlreadyClaimed();
        if (p.vetoed) revert Already();
        // F-7: refuse veto on a slot already settled (shouldn't happen since
        // we removed the legacy claim path, but cheap defense-in-depth).
        if (claimed[p.positionId][p.slotIndex]) revert AlreadyClaimed();
        p.vetoed = true;
        hasPending[p.positionId][p.slotIndex] = false;
        emit Vetoed(nonce);
    }

    // ====================== Admin: timelock / signer / pause ======================

    function setClaimTimelock(uint64 newTimelock) external onlyOwner {
        if (newTimelock > MAX_TIMELOCK) revert TimelockTooLong();
        // H-01: enforce a non-zero floor so the veto window is never disabled.
        if (newTimelock < MIN_TIMELOCK) revert TimelockTooShort();
        claimTimelock = newTimelock;
        emit TimelockChanged(newTimelock);
    }

    /// @notice M-03: disable renounceOwnership. With a hot owner key, an
    ///         accidental or coerced renounce would permanently disable
    ///         pause/veto/setTrustedSigner/rescue — the only defenses against
    ///         a compromised backend signer. Can be removed in a future
    ///         upgrade once governance is fully decentralised.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /// @notice Rotate the trusted backend signer. Use when the signer's key
    ///         has been compromised or when migrating to a multisig.
    function setTrustedSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();
        address old = trustedSigner;
        trustedSigner = newSigner;
        emit TrustedSignerUpdated(old, newSigner);
    }

    /// @notice Pause `authorize` and `claimByTwitter`. `veto`, `creditSlot`,
    ///         and admin functions stay live.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ====================== Rescue (F-4 bounded) ======================

    /**
     * @notice Owner-only escape hatch for stuck/excess tokens. CANNOT touch
     *         credited balances. The owner can sweep at most
     *         `balanceOf(this, token) - creditedTotal[token]` of any given
     *         token in one call.
     *
     *         Use cases: (a) someone accidentally sent ERC20 directly (not
     *         via `creditSlot`); (b) the locker over-transferred without
     *         crediting; (c) a token's credited total drops to zero post-
     *         claim and we want to sweep any rounding dust.
     */
    function rescue(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 held = IERC20(token).balanceOf(address(this));
        uint256 free = held > creditedTotal[token] ? held - creditedTotal[token] : 0;
        if (amount > free) revert ExceedsFreeBalance();
        IERC20(token).safeTransfer(to, amount);
        emit Rescued(token, to, amount);
    }

    /**
     * @notice Forfeit a stale slot's accumulated balance to a chosen recipient.
     *         Designed for the abandoned-handle case: the Twitter user never
     *         surfaces to claim. After `FORFEIT_DELAY` seconds (180 days) of
     *         no `creditSlot` activity on the slot, the owner can route the
     *         credited balance elsewhere (treasury, refund to creator, charity).
     *
     *         Marks the slot as `claimed=true` to align with H-03: future
     *         creditSlot calls revert and the locker's try/catch will route
     *         any later fees through its own pendingWithdrawals ledger
     *         instead, where `pullFromLocker` can recover them.
     *
     *         Refuses to operate while a claim is still pending (call `veto`
     *         first if needed) and refuses if both balances are already zero.
     */
    function forfeitStaleClaim(
        uint256 positionId,
        uint256 slotIndex,
        address pairedToken,
        address clankerToken,
        address to
    ) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (claimed[positionId][slotIndex]) revert AlreadyClaimed();
        if (hasPending[positionId][slotIndex]) revert SlotPending();

        uint64 last = lastCreditedAt[positionId][slotIndex];
        if (last == 0) revert NothingToClaim();
        if (block.timestamp < uint256(last) + uint256(FORFEIT_DELAY)) revert NotStaleYet();

        uint256 paired = pairedToken != address(0) ? balances[positionId][slotIndex][pairedToken] : 0;
        // Same-token aliasing: if pairedToken == clankerToken, only count
        // the balance once (mirrors F-10 safety net).
        uint256 clanker = (clankerToken != address(0) && clankerToken != pairedToken)
            ? balances[positionId][slotIndex][clankerToken]
            : 0;
        if (paired == 0 && clanker == 0) revert NothingToClaim();

        claimed[positionId][slotIndex] = true;

        if (paired > 0) {
            balances[positionId][slotIndex][pairedToken] = 0;
            creditedTotal[pairedToken] -= paired;
            IERC20(pairedToken).safeTransfer(to, paired);
        }
        if (clanker > 0) {
            balances[positionId][slotIndex][clankerToken] = 0;
            creditedTotal[clankerToken] -= clanker;
            IERC20(clankerToken).safeTransfer(to, clanker);
        }

        emit Forfeited(positionId, slotIndex, to, pairedToken, paired, clankerToken, clanker);
    }

    /// @notice H-08: pull tokens credited to this contract in the locker's
    ///         pull-payment ledger (eg failed inline transfers from
    ///         _payOrCredit). Without this, any token routed to the escrow
    ///         via the locker's catch path stays permanently locked because
    ///         the escrow address has no other way to call withdrawPending.
    ///         The retrieved amount lands in the escrow's free balance bucket
    ///         (not earmarked, so rescue() can sweep it). Owner gated.
    function pullFromLocker(address token) external onlyOwner returns (uint256 amount) {
        if (LOCKER == address(0)) revert LockerNotSet();
        if (token == address(0)) revert ZeroAddress();
        amount = IArcadeV3Locker(LOCKER).withdrawPending(token);
    }

    /// @notice M-12: owner-callable locker admin rotation. If the in-claim
    ///         updateAdmin try/catch failed (locker race / bug), the slot's
    ///         admin is stuck at the escrow's address with no rotation path.
    ///         This lets the owner unstick it after off-chain investigation.
    function rotateLockerAdmin(uint256 positionId, uint256 slotIndex, address newAdmin)
        external
        onlyOwner
    {
        if (LOCKER == address(0)) revert LockerNotSet();
        if (newAdmin == address(0)) revert ZeroAddress();
        IArcadeV3Locker(LOCKER).updateAdmin(positionId, slotIndex, newAdmin);
    }

    /// @notice Companion to rotateLockerAdmin for the recipient field.
    function rotateLockerRecipient(uint256 positionId, uint256 slotIndex, address newRecipient)
        external
        onlyOwner
    {
        if (LOCKER == address(0)) revert LockerNotSet();
        if (newRecipient == address(0)) revert ZeroAddress();
        IArcadeV3Locker(LOCKER).updateRecipient(positionId, slotIndex, newRecipient);
    }

    // ====================== EIP-712 helpers ======================

    function _recover(
        uint256 positionId,
        uint256 slotIndex,
        address recipient,
        address pairedToken,
        uint256 pairedAmount,
        address clankerToken,
        uint256 clankerAmount,
        uint256 deadline,
        bytes32 nonce,
        bytes calldata signature
    ) internal view returns (address) {
        bytes32 structHash = keccak256(
            abi.encode(
                CLAIM_TYPEHASH,
                positionId,
                slotIndex,
                recipient,
                pairedToken,
                pairedAmount,
                clankerToken,
                clankerAmount,
                deadline,
                nonce
            )
        );
        bytes32 digest = MessageHashUtils.toTypedDataHash(DOMAIN_SEPARATOR(), structHash);
        return digest.recover(signature);
    }
}
