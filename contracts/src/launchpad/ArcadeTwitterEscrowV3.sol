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

    // ====================== Immutable wiring ======================

    address public immutable LOCKER;
    bytes32 private immutable _DOMAIN_SEPARATOR_CACHED;
    uint256 private immutable _CACHED_CHAIN_ID;

    bytes32 private constant CLAIM_TYPEHASH = keccak256(
        "Claim(uint256 positionId,uint256 slotIndex,address recipient,address pairedToken,uint256 pairedAmount,address clankerToken,uint256 clankerAmount,uint256 deadline,bytes32 nonce)"
    );

    /// @notice Maximum value the owner can set for `claimTimelock`. Caps DOS
    ///         potential while leaving room for a 7-day mainnet timelock.
    uint64 public constant MAX_TIMELOCK = 7 days;

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

    // ====================== Errors ======================

    error Expired();
    error AlreadyClaimed();
    error NonceReused();
    error InvalidSignature();
    error ZeroAddress();
    error NotLocker();
    error NotAuthorized();
    error Timelocked();
    error TimelockTooLong();
    error Already();
    error SlotPending();
    error InsufficientBalance();
    error ExceedsFreeBalance();
    error InvalidTokens();
    error DeadlineInPast();

    // ====================== Construction ======================

    constructor(address locker_, address trustedSigner_, address owner_) Ownable(owner_) {
        if (locker_ == address(0) || trustedSigner_ == address(0)) revert ZeroAddress();
        LOCKER = locker_;
        trustedSigner = trustedSigner_;
        _CACHED_CHAIN_ID = block.chainid;
        _DOMAIN_SEPARATOR_CACHED = _buildDomainSeparator();
        emit TrustedSignerUpdated(address(0), trustedSigner_);
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
        if (msg.sender != LOCKER) revert NotLocker();
        if (token == address(0)) revert ZeroAddress();
        balances[positionId][slotIndex][token] += amount;
        creditedTotal[token] += amount;
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
        if (pairedAmount > balances[positionId][slotIndex][pairedToken]) revert InsufficientBalance();
        if (clankerAmount > balances[positionId][slotIndex][clankerToken]) revert InsufficientBalance();

        // F-10: same-token aliasing trap. If both tokens point at the same
        // address, the two safeTransfers in _settle would double-pull from the
        // single balance line. Refuse this shape unless at least one is zero.
        if (pairedToken == clankerToken && pairedAmount > 0 && clankerAmount > 0) revert InvalidTokens();

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

        // Snapshot before state writes so the settle path uses fixed values.
        uint256 positionId = p.positionId;
        uint256 slotIndex = p.slotIndex;
        address recipient = p.recipient;
        address pairedToken = p.pairedToken;
        uint256 pairedAmount = p.pairedAmount;
        address clankerToken = p.clankerToken;
        uint256 clankerAmount = p.clankerAmount;

        // Re-check balances (the locker MAY have re-credited or claimed
        // since authorize; we already enforced >= at authorize but the
        // invariant could shift if creditSlot is ever called with a negative
        // delta - not possible today, but cheap to re-check).
        if (pairedAmount > balances[positionId][slotIndex][pairedToken]) revert InsufficientBalance();
        if (clankerAmount > balances[positionId][slotIndex][clankerToken]) revert InsufficientBalance();

        // Effects.
        p.consumed = true;
        claimed[positionId][slotIndex] = true;
        hasPending[positionId][slotIndex] = false;
        if (pairedAmount > 0) {
            balances[positionId][slotIndex][pairedToken] -= pairedAmount;
            creditedTotal[pairedToken] -= pairedAmount;
        }
        if (clankerAmount > 0) {
            balances[positionId][slotIndex][clankerToken] -= clankerAmount;
            creditedTotal[clankerToken] -= clankerAmount;
        }

        // Interactions: transfers first (CEI), then locker rotation in try/catch.
        if (pairedAmount > 0) IERC20(pairedToken).safeTransfer(recipient, pairedAmount);
        if (clankerAmount > 0) IERC20(clankerToken).safeTransfer(recipient, clankerAmount);

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

        emit Claimed(positionId, slotIndex, recipient, pairedToken, pairedAmount, clankerToken, clankerAmount);
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
        claimTimelock = newTimelock;
        emit TimelockChanged(newTimelock);
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
