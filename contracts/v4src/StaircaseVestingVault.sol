// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IStaircaseVestingVault} from "./interfaces/IStaircaseVestingVault.sol";

/**
 * @title StaircaseVestingVault
 * @notice Trustless, immutable, admin-less vault for staircase (tranche) token
 *         vesting at launch. Adapted from `ArcadeTokenVault` but with a step
 *         release curve instead of linear vesting, and a strictly one-way trust
 *         model: once a vest is created NOBODY can change the schedule, redirect
 *         the beneficiary, withdraw early, or sweep tokens. The only privileged
 *         action is `createVest`, gated to the immutable `launchpad` (the
 *         ArcadeHook). Everyone else can only `claim` (which always pays the
 *         recorded beneficiary).
 *
 *         Release curve: each vest carries an array of `Step { unlockTime,
 *         cumulativeBps }`. At time `t` the vested (cumulative) fraction equals
 *         the `cumulativeBps` of the LATEST step whose `unlockTime <= t`, and 0
 *         before the first step. `cumulativeBps` is the running total unlocked
 *         in basis points of the vest amount, so the last step is 10000 (100%).
 *
 *         The launchpad carves out `amount` tokens at creation and transfers
 *         them here BEFORE/AT `createVest`; the vault only records the schedule
 *         and never pulls tokens itself (same pattern as `ArcadeTokenVault`).
 */
contract StaircaseVestingVault is IStaircaseVestingVault, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The only address permitted to register vests (the ArcadeHook).
    address public immutable launchpad;

    /// @notice Upper bound on steps per vest, bounding `createVest`/view gas.
    uint16 public constant MAX_STEPS = 24;
    /// @notice 100% in basis points; the final step must reach exactly this.
    uint16 public constant BPS_DENOMINATOR = 10000;

    struct Vest {
        address token;
        address beneficiary;
        uint256 amount;
        uint256 claimed;
        Step[] steps;
    }

    /// @notice vestId => vest record. Ids start at 1 (see `nextVestId`).
    mapping(uint256 => Vest) private _vests;
    /// @notice Id assigned to the next created vest (also == count once past 0).
    uint256 public nextVestId = 1;

    error OnlyLaunchpad();
    error NoVest();
    error ZeroAddress();
    error ZeroAmount();
    error BadStepCount();
    error NonIncreasingTime();
    error NonIncreasingBps();
    error BpsOutOfRange();
    error LastStepNotFull();
    error FirstStepNotFuture();

    event VestCreated(uint256 indexed vestId, address indexed token, address indexed beneficiary, uint256 amount);
    event Claimed(uint256 indexed vestId, address indexed beneficiary, uint256 amount);

    constructor(address launchpad_) {
        if (launchpad_ == address(0)) revert ZeroAddress();
        launchpad = launchpad_;
    }

    /**
     * @notice Register a staircase vest. The launchpad must have transferred
     *         `amount` of `token` to this vault beforehand. Launchpad-only.
     * @dev    Validates the full schedule up front so a malformed vest can never
     *         be recorded (and thus can never strand tokens in an unclaimable
     *         state or over-release).
     */
    function createVest(address token, address beneficiary, uint256 amount, Step[] calldata steps)
        external
        returns (uint256 vestId)
    {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        if (beneficiary == address(0) || token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        uint256 n = steps.length;
        if (n < 1 || n > MAX_STEPS) revert BadStepCount();

        // First step must be future-dated. The hook additionally enforces
        // >= launch + 1 day; the vault only needs the schedule to start ahead
        // of now so nothing is instantly claimable at registration.
        if (steps[0].unlockTime <= block.timestamp) revert FirstStepNotFuture();

        // Validate monotonicity + bounds across the whole curve.
        for (uint256 i = 0; i < n; ++i) {
            uint16 bps = steps[i].cumulativeBps;
            if (bps == 0 || bps > BPS_DENOMINATOR) revert BpsOutOfRange();
            if (i > 0) {
                if (steps[i].unlockTime <= steps[i - 1].unlockTime) revert NonIncreasingTime();
                if (bps <= steps[i - 1].cumulativeBps) revert NonIncreasingBps();
            }
        }
        if (steps[n - 1].cumulativeBps != BPS_DENOMINATOR) revert LastStepNotFull();

        vestId = nextVestId++;
        Vest storage v = _vests[vestId];
        v.token = token;
        v.beneficiary = beneficiary;
        v.amount = amount;
        for (uint256 i = 0; i < n; ++i) {
            v.steps.push(steps[i]);
        }

        emit VestCreated(vestId, token, beneficiary, amount);
    }

    /// @notice Cumulative amount vested at the current block time.
    function vestedAmount(uint256 vestId) public view returns (uint256) {
        Vest storage v = _vests[vestId];
        if (v.amount == 0) return 0; // nonexistent (or zero) vest
        uint256 bps = _cumulativeBpsAt(v, block.timestamp);
        if (bps == 0) return 0;
        if (bps >= BPS_DENOMINATOR) return v.amount; // guard against dust loss at 100%
        return (v.amount * bps) / BPS_DENOMINATOR;
    }

    /// @notice Amount currently claimable (vested minus already claimed).
    function claimable(uint256 vestId) public view returns (uint256) {
        return vestedAmount(vestId) - _vests[vestId].claimed;
    }

    /**
     * @notice Claim vested-but-unclaimed tokens to the recorded beneficiary.
     *         Permissionless: ANYONE may call it, but funds always go to the
     *         beneficiary (enables third-party automation without custody).
     *         A no-op (no revert) when nothing is currently claimable.
     */
    function claim(uint256 vestId) external nonReentrant {
        Vest storage v = _vests[vestId];
        if (v.amount == 0) revert NoVest();
        uint256 amount = vestedAmount(vestId) - v.claimed;
        if (amount > 0) {
            v.claimed += amount;
            IERC20(v.token).safeTransfer(v.beneficiary, amount);
            emit Claimed(vestId, v.beneficiary, amount);
        }
    }

    /// @notice Full vest record including its step schedule.
    function getVest(uint256 vestId)
        external
        view
        returns (address token, address beneficiary, uint256 amount, uint256 claimed, Step[] memory steps)
    {
        Vest storage v = _vests[vestId];
        return (v.token, v.beneficiary, v.amount, v.claimed, v.steps);
    }

    /// @notice The step schedule for a vest.
    function getSteps(uint256 vestId) external view returns (Step[] memory) {
        return _vests[vestId].steps;
    }

    /// @dev Cumulative bps unlocked at `t`: the bps of the latest step whose
    ///      unlockTime <= t, or 0 if t precedes the first step. Steps are
    ///      strictly increasing in time (enforced at creation), so a forward
    ///      scan finds the boundary; MAX_STEPS bounds the loop.
    function _cumulativeBpsAt(Vest storage v, uint256 t) private view returns (uint256 bps) {
        uint256 n = v.steps.length;
        for (uint256 i = 0; i < n; ++i) {
            if (v.steps[i].unlockTime <= t) {
                bps = v.steps[i].cumulativeBps;
            } else {
                break;
            }
        }
    }
}
