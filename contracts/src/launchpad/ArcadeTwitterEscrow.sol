// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IArcadeV3Locker {
    function updateRecipient(uint256 positionId, uint256 index, address newRecipient) external;
    function updateAdmin(uint256 positionId, uint256 index, address newAdmin) external;
}

/**
 * @title ArcadeTwitterEscrow
 * @notice Holds Clanker LP fees attributed to a Twitter handle until the
 *         verified owner of that handle claims them.
 *
 *         At launch, a token creator wires a recipient slot to this escrow
 *         (recipient = admin = address(this)). The locker pays the slot's bps
 *         share of every collectFees() call into this contract.
 *
 *         When the Twitter owner shows up:
 *           1. They authenticate via OAuth on Arcade's backend.
 *           2. Backend signs an EIP-712 `Claim` message attesting the OAuth'd
 *              handle matches the slot's attribution.
 *           3. They submit the signature to `claim()`. The escrow transfers
 *              the accumulated paired + clanker balances and rotates the
 *              locker's recipient/admin to their wallet so future fees flow
 *              direct (no more escrow round-trip).
 *
 *         The contract trusts a single off-chain signer (`TRUSTED_SIGNER`) to
 *         attest both the handle match AND the cumulative amounts. A compromise
 *         of that key lets an attacker drain accrued balances to arbitrary
 *         addresses. For mainnet, migrate to a multisig signer or per-slot
 *         CREATE2 sub-escrows.
 */
contract ArcadeTwitterEscrow {
    using ECDSA for bytes32;

    /// @notice The ArcadeV3Locker contract that pays fees into this escrow.
    address public immutable LOCKER;
    /// @notice Off-chain signer whose key authorizes Twitter-OAuth'd claims.
    address public immutable TRUSTED_SIGNER;

    bytes32 public immutable DOMAIN_SEPARATOR;
    bytes32 private constant CLAIM_TYPEHASH = keccak256(
        "Claim(uint256 positionId,uint256 slotIndex,address recipient,address pairedToken,uint256 pairedAmount,address clankerToken,uint256 clankerAmount,uint256 deadline,bytes32 nonce)"
    );

    /// @notice Per-slot one-shot claim flag. Once claimed, the slot rotates
    ///         to the claimer's wallet on the locker and can never re-enter
    ///         this escrow.
    mapping(uint256 positionId => mapping(uint256 slotIndex => bool)) public claimed;
    /// @notice Replay guard on EIP-712 nonces.
    mapping(bytes32 => bool) public nonceUsed;

    event Claimed(
        uint256 indexed positionId,
        uint256 indexed slotIndex,
        address indexed recipient,
        address pairedToken,
        uint256 pairedAmount,
        address clankerToken,
        uint256 clankerAmount
    );

    error Expired();
    error AlreadyClaimed();
    error NonceReused();
    error InvalidSignature();
    error ZeroAddress();
    error TransferFailed();

    constructor(address locker_, address trustedSigner_) {
        if (locker_ == address(0) || trustedSigner_ == address(0)) revert ZeroAddress();
        LOCKER = locker_;
        TRUSTED_SIGNER = trustedSigner_;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ArcadeTwitterEscrow"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    /**
     * @notice Permissionless. The signature attests that OAuth verified the
     *         Twitter owner of the slot's attributed handle as `recipient`,
     *         and that `pairedAmount`/`clankerAmount` reflect that slot's
     *         current share of escrow balance.
     */
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
        bytes32 digest = MessageHashUtils.toTypedDataHash(DOMAIN_SEPARATOR, structHash);
        if (digest.recover(signature) != TRUSTED_SIGNER) revert InvalidSignature();

        nonceUsed[nonce] = true;
        claimed[positionId][slotIndex] = true;

        if (pairedAmount > 0) {
            if (!IERC20Min(pairedToken).transfer(recipient, pairedAmount)) revert TransferFailed();
        }
        if (clankerAmount > 0) {
            if (!IERC20Min(clankerToken).transfer(recipient, clankerAmount)) revert TransferFailed();
        }

        IArcadeV3Locker(LOCKER).updateRecipient(positionId, slotIndex, recipient);
        IArcadeV3Locker(LOCKER).updateAdmin(positionId, slotIndex, recipient);

        emit Claimed(positionId, slotIndex, recipient, pairedToken, pairedAmount, clankerToken, clankerAmount);
    }
}
