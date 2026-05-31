// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title ArcadeTokenVault
 * @notice Holds a portion of a CLANKER_V3 launch's supply for a beneficiary,
 *         locked for a minimum period then released by linear vesting. Clanker-
 *         style team/creator allocation that can't be dumped at launch.
 *
 *         The launchpad carves out `amount` tokens at creation, transfers them
 *         here, and registers a vest. Tokens unlock as:
 *           - 0 before `lockupEnd`
 *           - linear from `lockupEnd` to `vestingEnd`
 *           - 100% at/after `vestingEnd`
 *         (`vestingEnd == lockupEnd` ⇒ a clean cliff at lockup end.)
 *
 *         `claim` is permissionless but always pays the registered recipient,
 *         who can rotate the payout address via `updateRecipient`.
 */
contract ArcadeTokenVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable launchpad;
    uint64 public constant MIN_LOCKUP = 7 days;
    /// @notice Cap on both `lockupDuration` and `vestingDuration` to prevent
    /// pathological values (eg `type(uint64).max - block.timestamp + 1`) that
    /// would overflow `uint64` arithmetic and revert `createClankerV3` after
    /// the token is already deployed, wasting the caller's signature.
    uint64 public constant MAX_DURATION = 10 * 365 days; // 10 years

    struct Vest {
        address token;
        address recipient;
        uint256 total;
        uint256 claimed;
        uint64 lockupEnd;
        uint64 vestingEnd;
        bool exists;
    }

    mapping(uint256 => Vest) public vests;
    uint256 public vestCount;
    mapping(address => uint256) public vestIdByToken;

    error OnlyLaunchpad();
    error AlreadyVested();
    error NoVest();
    error OnlyRecipient();
    error BadDuration();
    error ZeroAddress();
    error ZeroAmount();

    event VestCreated(
        uint256 indexed id,
        address indexed token,
        address indexed recipient,
        uint256 total,
        uint64 lockupEnd,
        uint64 vestingEnd
    );
    event Claimed(uint256 indexed id, address indexed recipient, uint256 amount);
    event RecipientUpdated(uint256 indexed id, address indexed newRecipient);

    constructor(address launchpad_) {
        if (launchpad_ == address(0)) revert ZeroAddress();
        launchpad = launchpad_;
    }

    /**
     * @notice Register a vest. The launchpad must have transferred `amount` of
     * `token` to this vault beforehand. Launchpad-only.
     */
    function createVest(
        address token,
        address recipient,
        uint256 amount,
        uint64 lockupDuration,
        uint64 vestingDuration
    ) external returns (uint256 id) {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (vestIdByToken[token] != 0) revert AlreadyVested();
        if (lockupDuration < MIN_LOCKUP || lockupDuration > MAX_DURATION) revert BadDuration();
        if (vestingDuration > MAX_DURATION) revert BadDuration();

        uint64 lockupEnd = uint64(block.timestamp) + lockupDuration;
        uint64 vestingEnd = lockupEnd + vestingDuration;

        id = ++vestCount;
        vests[id] = Vest({
            token: token,
            recipient: recipient,
            total: amount,
            claimed: 0,
            lockupEnd: lockupEnd,
            vestingEnd: vestingEnd,
            exists: true
        });
        vestIdByToken[token] = id;
        emit VestCreated(id, token, recipient, amount, lockupEnd, vestingEnd);
    }

    /// @notice Total amount vested so far (claimed + claimable).
    function vestedAmount(uint256 id) public view returns (uint256) {
        Vest memory v = vests[id];
        if (!v.exists || block.timestamp < v.lockupEnd) return 0;
        if (block.timestamp >= v.vestingEnd) return v.total;
        // lockupEnd < now < vestingEnd ⇒ vestingEnd - lockupEnd > 0
        return (v.total * (block.timestamp - v.lockupEnd)) / (v.vestingEnd - v.lockupEnd);
    }

    /// @notice Amount currently claimable (vested minus already claimed).
    function claimable(uint256 id) public view returns (uint256) {
        return vestedAmount(id) - vests[id].claimed;
    }

    /// @notice Claim vested tokens to the registered recipient. Permissionless.
    /// @dev M-01: nonReentrant for consistency with the rest of the protocol.
    /// CEI (claimed += amount before transfer) already protects against re-
    /// entry of THIS function with the current LaunchToken, but the guard
    /// future-proofs us against vesting non-standard tokens.
    function claim(uint256 id) external nonReentrant returns (uint256 amount) {
        Vest storage v = vests[id];
        if (!v.exists) revert NoVest();
        amount = vestedAmount(id) - v.claimed;
        if (amount > 0) {
            v.claimed += amount;
            IERC20(v.token).safeTransfer(v.recipient, amount);
            emit Claimed(id, v.recipient, amount);
        }
    }

    /// @notice Rotate the vest's payout address. Only the current recipient.
    function updateRecipient(uint256 id, address newRecipient) external {
        if (newRecipient == address(0)) revert ZeroAddress();
        Vest storage v = vests[id];
        if (!v.exists) revert NoVest();
        if (msg.sender != v.recipient) revert OnlyRecipient();
        v.recipient = newRecipient;
        emit RecipientUpdated(id, newRecipient);
    }

    function getVest(uint256 id) external view returns (Vest memory) {
        return vests[id];
    }
}
