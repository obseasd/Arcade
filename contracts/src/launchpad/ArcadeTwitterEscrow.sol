// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface IArcadeV3Locker {
    function updateRecipient(uint256 positionId, uint256 index, address newRecipient) external;
    function updateAdmin(uint256 positionId, uint256 index, address newAdmin) external;
}

/**
 * @title ArcadeTwitterEscrow
 * @notice Holds Clanker LP fees attributed to a Twitter handle until the
 *         verified owner claims them.
 *
 *         Two claim flows:
 *
 *         1. `claim(...)` - direct one-shot, signature in URL. The user
 *            submits the EIP-712 signature themselves as a tx argument.
 *            Simple, no on-chain pre-state. Kept for backward compatibility.
 *
 *         2. `authorize(...)` + `claimByTwitter(...)` - two-step with optional
 *            timelock. Backend submits authorize() right after OAuth, the
 *            authorization is stored on-chain with `executeAfter = now +
 *            claimTimelock`. The owner can `veto` during the window. The user
 *            then calls claimByTwitter() with a tiny payload. Cleaner UX,
 *            shareable claim URL, optional safety window.
 */
contract ArcadeTwitterEscrow {
    using ECDSA for bytes32;
    using SafeERC20 for IERC20;

    address public immutable LOCKER;
    address public immutable TRUSTED_SIGNER;

    /// @dev Stored at construction so we can detect a fork later and re-derive.
    bytes32 private immutable _DOMAIN_SEPARATOR_CACHED;
    uint256 private immutable _CACHED_CHAIN_ID;
    bytes32 private constant CLAIM_TYPEHASH = keccak256(
        "Claim(uint256 positionId,uint256 slotIndex,address recipient,address pairedToken,uint256 pairedAmount,address clankerToken,uint256 clankerAmount,uint256 deadline,bytes32 nonce)"
    );

    /// @notice One-shot per-slot claim flag, shared by both flows.
    mapping(uint256 positionId => mapping(uint256 slotIndex => bool)) public claimed;
    /// @notice Replay guard on EIP-712 nonces.
    mapping(bytes32 => bool) public nonceUsed;
    /// @notice Tracks whether a (positionId, slotIndex) pair already has an
    /// in-flight (pending, not consumed, not vetoed) authorization. Used to
    /// prevent zombie pendingClaims that can never execute because the slot
    /// has been claimed by a different nonce.
    mapping(uint256 positionId => mapping(uint256 slotIndex => bool)) public hasPending;

    // --------- claimByTwitter state ---------

    struct PendingClaim {
        address recipient;
        address pairedToken;
        uint256 pairedAmount;
        address clankerToken;
        uint256 clankerAmount;
        uint256 positionId;
        uint256 slotIndex;
        uint64 executeAfter;
        uint64 deadline;
        bool consumed;
        bool vetoed;
    }

    /// @notice Pending claim authorizations keyed by nonce. Filled by `authorize`.
    mapping(bytes32 nonce => PendingClaim) public pendingClaims;

    /// @notice Owner that can veto pending authorizations and tweak the timelock.
    ///         Should be a multisig in production.
    address public owner;
    /// @notice Delay between `authorize` and the earliest moment `claimByTwitter`
    ///         can execute. Default 0 (instant). Owner can set up to 7 days for
    ///         extra safety on suspicious operations.
    uint64 public claimTimelock;

    event Claimed(
        uint256 indexed positionId,
        uint256 indexed slotIndex,
        address indexed recipient,
        address pairedToken,
        uint256 pairedAmount,
        address clankerToken,
        uint256 clankerAmount
    );
    event Authorized(bytes32 indexed nonce, uint256 indexed positionId, uint256 indexed slotIndex, uint64 executeAfter);
    event Vetoed(bytes32 indexed nonce);
    event TimelockChanged(uint64 newTimelock);
    event OwnerChanged(address newOwner);
    /// @notice Emitted when the owner sweeps stuck or vetoed tokens.
    event Rescued(address indexed token, address indexed to, uint256 amount);

    error Expired();
    error AlreadyClaimed();
    error NonceReused();
    error InvalidSignature();
    error ZeroAddress();
    error NotOwner();
    error NotAuthorized();
    error Timelocked();
    error TimelockTooLong();
    error Already();
    error SlotPending();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address locker_, address trustedSigner_, address owner_) {
        if (locker_ == address(0) || trustedSigner_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        LOCKER = locker_;
        TRUSTED_SIGNER = trustedSigner_;
        owner = owner_;
        _CACHED_CHAIN_ID = block.chainid;
        _DOMAIN_SEPARATOR_CACHED = _buildDomainSeparator();
    }

    /// @notice EIP-712 domain separator. Re-derived live when the chainId
    /// changes (eg fork), to prevent cross-chain replay of long-lived sigs.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        if (block.chainid == _CACHED_CHAIN_ID) return _DOMAIN_SEPARATOR_CACHED;
        return _buildDomainSeparator();
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ArcadeTwitterEscrow"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    // ====================== Flow 1: direct claim ======================

    function claim(
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
    ) external {
        if (block.timestamp > deadline) revert Expired();
        if (claimed[positionId][slotIndex]) revert AlreadyClaimed();
        if (nonceUsed[nonce]) revert NonceReused();
        if (
            _recover(positionId, slotIndex, recipient, pairedToken, pairedAmount, clankerToken, clankerAmount, deadline, nonce, signature)
                != TRUSTED_SIGNER
        ) revert InvalidSignature();

        nonceUsed[nonce] = true;
        claimed[positionId][slotIndex] = true;
        // Clear any zombie pending flag (a different nonce authorize on the same
        // slot now becomes a no-op because hasPending is false again).
        hasPending[positionId][slotIndex] = false;
        _settle(positionId, slotIndex, recipient, pairedToken, pairedAmount, clankerToken, clankerAmount);
    }

    // ====================== Flow 2: authorize + claimByTwitter ======================

    /// @notice Anyone with a valid backend signature can deposit a claim
    ///         authorization on-chain. The actual transfer happens later via
    ///         `claimByTwitter`. The recipient receives nothing from this call.
    ///         Reverts if the slot already has an in-flight authorization to
    ///         avoid zombie pendingClaims (the owner must `veto` the previous
    ///         one first, after which a fresh nonce can be authorized).
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
    ) external {
        if (block.timestamp > deadline) revert Expired();
        if (claimed[positionId][slotIndex]) revert AlreadyClaimed();
        if (hasPending[positionId][slotIndex]) revert SlotPending();
        if (nonceUsed[nonce]) revert NonceReused();
        if (pendingClaims[nonce].executeAfter != 0) revert Already();
        if (
            _recover(positionId, slotIndex, recipient, pairedToken, pairedAmount, clankerToken, clankerAmount, deadline, nonce, signature)
                != TRUSTED_SIGNER
        ) revert InvalidSignature();

        uint64 executeAfter = uint64(block.timestamp) + claimTimelock;
        pendingClaims[nonce] = PendingClaim({
            recipient: recipient,
            pairedToken: pairedToken,
            pairedAmount: pairedAmount,
            clankerToken: clankerToken,
            clankerAmount: clankerAmount,
            positionId: positionId,
            slotIndex: slotIndex,
            executeAfter: executeAfter,
            deadline: uint64(deadline),
            consumed: false,
            vetoed: false
        });
        nonceUsed[nonce] = true;
        hasPending[positionId][slotIndex] = true;

        emit Authorized(nonce, positionId, slotIndex, executeAfter);
    }

    /// @notice Execute a previously-authorized claim. Permissionless: anyone
    ///         can pay the gas; funds always go to the `recipient` stored at
    ///         `authorize` time.
    function claimByTwitter(bytes32 nonce) external {
        PendingClaim storage p = pendingClaims[nonce];
        if (p.executeAfter == 0) revert NotAuthorized();
        if (p.consumed) revert AlreadyClaimed();
        if (p.vetoed) revert AlreadyClaimed();
        if (claimed[p.positionId][p.slotIndex]) revert AlreadyClaimed();
        if (block.timestamp < p.executeAfter) revert Timelocked();
        if (block.timestamp > p.deadline) revert Expired();

        p.consumed = true;
        claimed[p.positionId][p.slotIndex] = true;
        hasPending[p.positionId][p.slotIndex] = false;
        _settle(p.positionId, p.slotIndex, p.recipient, p.pairedToken, p.pairedAmount, p.clankerToken, p.clankerAmount);
    }

    // ====================== Admin ======================

    /// @notice Cancel a pending authorization. Use case: backend key was
    ///         suspected compromised; veto suspicious claims during the
    ///         timelock window. Cannot be reversed. Frees the slot so the
    ///         signer can issue a fresh nonce.
    function veto(bytes32 nonce) external onlyOwner {
        PendingClaim storage p = pendingClaims[nonce];
        if (p.executeAfter == 0) revert NotAuthorized();
        if (p.consumed) revert AlreadyClaimed();
        if (p.vetoed) revert Already();
        p.vetoed = true;
        hasPending[p.positionId][p.slotIndex] = false;
        emit Vetoed(nonce);
    }

    /// @notice Adjust the timelock delay applied to future authorizations.
    ///         Capped at 7 days to prevent griefing.
    function setClaimTimelock(uint64 newTimelock) external onlyOwner {
        if (newTimelock > 7 days) revert TimelockTooLong();
        claimTimelock = newTimelock;
        emit TimelockChanged(newTimelock);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        owner = newOwner;
        emit OwnerChanged(newOwner);
    }

    /// @notice Owner-only escape hatch to sweep stuck or vetoed token balances
    ///         (eg a claim was vetoed and the corresponding token never flows
    ///         out, or someone accidentally sends ERC20 to this contract).
    ///         Should be a multisig in production.
    function rescue(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit Rescued(token, to, amount);
    }

    // ====================== Internal ======================

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

    function _settle(
        uint256 positionId,
        uint256 slotIndex,
        address recipient,
        address pairedToken,
        uint256 pairedAmount,
        address clankerToken,
        uint256 clankerAmount
    ) internal {
        // SafeERC20 handles non-standard ERC20s (USDT-style no-return-value),
        // which the prior raw IERC20.transfer + bool check couldn't.
        if (pairedAmount > 0) IERC20(pairedToken).safeTransfer(recipient, pairedAmount);
        if (clankerAmount > 0) IERC20(clankerToken).safeTransfer(recipient, clankerAmount);
        IArcadeV3Locker(LOCKER).updateRecipient(positionId, slotIndex, recipient);
        IArcadeV3Locker(LOCKER).updateAdmin(positionId, slotIndex, recipient);
        emit Claimed(positionId, slotIndex, recipient, pairedToken, pairedAmount, clankerToken, clankerAmount);
    }
}
