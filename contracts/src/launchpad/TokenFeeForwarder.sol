// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title TokenFeeForwarder
 * @notice A thin, custody-free relay that delivers the TOKEN leg of a CLANKER
 *         launch's creator fees to a claimant AND emits a single indexed
 *         `Forwarded` event carrying the (positionId, slotIndex, claimTxHash)
 *         so the subgraph can join it to the escrow's USDC-side `Claim` and the
 *         launchpad activity feed can show BOTH legs (USDC + token).
 *
 *         Why this exists: today the USDC leg is escrowed on-chain (an escrow
 *         `Claimed` event is indexed), but the token leg accrues on the backend
 *         forwarder wallet and is delivered by a bare ERC-20 `transfer` with NO
 *         on-chain marker tying it to the claim. So the activity row can only
 *         show the USDC amount. Routing that same delivery through this contract
 *         adds the marker WITHOUT touching the audited escrow core (which pins
 *         one-token-per-slot and could not carry the token leg without a
 *         multi-token rewrite = new audit surface).
 *
 *         Design invariants:
 *          - CUSTODY-FREE. `forward` pulls exactly `amount` of `token` from the
 *            caller and pushes it to `recipient` in the SAME call. The contract
 *            never holds a balance between calls; `rescue` only recovers dust
 *            mistakenly sent here.
 *          - CALLER-GATED. Only an owner-allow-listed caller (the backend
 *            forwarder wallet) may `forward`. This is what keeps the `Forwarded`
 *            event trustworthy: an arbitrary account cannot emit spoofed rows
 *            into the activity feed. The token movement itself is always real
 *            (a `transferFrom` moves `amount` of `token`), but the join metadata
 *            (positionId / slotIndex / claimTxHash) is only as trustworthy as
 *            the caller, so the caller must be the honest backend.
 *          - The forwarded `amount` is the RAW token amount (the launch token's
 *            own decimals, typically 18). Consumers format by `token`'s decimals;
 *            never divide by a fixed 1e6 (that is the USDC-leg convention).
 */
contract TokenFeeForwarder is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Accounts allowed to call `forward` (the backend forwarder wallet).
    mapping(address => bool) public allowedCaller;

    /// @param token       the launch token being delivered.
    /// @param recipient   the claimant receiving the token leg.
    /// @param amount      RAW token amount delivered (token's own decimals).
    /// @param positionId  the pool's positionId (uint256(poolId)); ties to Claim.
    /// @param slotIndex   escrow slot (0 = replier / sole, 1 = poster).
    /// @param claimTxHash the escrow USDC-side claim tx this token leg pairs with.
    event Forwarded(
        address indexed token,
        address indexed recipient,
        uint256 amount,
        uint256 indexed positionId,
        uint256 slotIndex,
        bytes32 claimTxHash
    );
    event CallerSet(address indexed caller, bool allowed);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    error NotAllowedCaller();
    error ZeroAddress();
    error NothingToForward();
    error RenounceDisabled();

    /// @param owner_        the Ownable2Step owner (the treasury Safe). Set
    ///                      directly so no post-deploy transfer/accept is needed.
    /// @param initialCaller the backend forwarder wallet, seeded into the
    ///                      allowlist (pass address(0) to seed none).
    constructor(address owner_, address initialCaller) Ownable(owner_) {
        if (initialCaller != address(0)) {
            allowedCaller[initialCaller] = true;
            emit CallerSet(initialCaller, true);
        }
    }

    /// @notice Allow / disallow a `forward` caller. Owner only (the Safe).
    function setCaller(address caller, bool allowed) external onlyOwner {
        if (caller == address(0)) revert ZeroAddress();
        allowedCaller[caller] = allowed;
        emit CallerSet(caller, allowed);
    }

    /// @notice Deliver `amount` of `token` from the caller to `recipient` and
    ///         emit `Forwarded` with the claim-join metadata. The caller must
    ///         have approved this contract for `amount` of `token`.
    /// @dev CUSTODY-FREE pull-and-push: the whole amount moves caller -> recipient
    ///      in one call; the contract holds nothing afterwards.
    function forward(
        address token,
        address recipient,
        uint256 amount,
        uint256 positionId,
        uint256 slotIndex,
        bytes32 claimTxHash
    ) external nonReentrant {
        if (!allowedCaller[msg.sender]) revert NotAllowedCaller();
        if (token == address(0) || recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert NothingToForward();

        IERC20(token).safeTransferFrom(msg.sender, recipient, amount);
        emit Forwarded(token, recipient, amount, positionId, slotIndex, claimTxHash);
    }

    /// @notice Recover tokens mistakenly sent to this contract. Owner only.
    ///         The forward path never leaves a balance here, so this only ever
    ///         moves stray donations.
    function rescue(IERC20 token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
        emit Rescued(address(token), to, amount);
    }

    /// @notice Renouncing ownership is disabled so the caller allowlist can never
    ///         be frozen (a compromised caller must always stay revocable).
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }
}
