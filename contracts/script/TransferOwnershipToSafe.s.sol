// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";

/**
 * Option B: after a fresh mainnet deploy (by a throwaway deployer EOA), hand ALL
 * governance to the 2-of-3 Safe. Run ONCE by the deployer, immediately after the
 * deploy, so the deployer keeps no authority.
 *
 * Governance is heterogeneous, so each contract gets its exact transfer call:
 *   - v2Factory        : setFeeTo(Safe) + setFeeToSetter(Safe)   (single-step)
 *   - v3Factory        : setOwner(feeProtocolManager)            (single-step; the
 *                        manager is Safe-owned, so the permissionless fee switch
 *                        keeps working under governance)
 *   - feeProtocolManager, autoCompounder, arcadeHook, escrow : 2-STEP
 *                        transferOwnership(Safe) -> the Safe must acceptOwnership()
 *                        (a separate Safe tx; this script only initiates it),
 *                        plus their fee destination (setTreasury/setFeeRecipient).
 *   - v3Locker.owner, launchpad.treasury : IMMUTABLE, set in the constructor.
 *                        They CANNOT be transferred, so a pre-flight require()
 *                        asserts they already carry the Safe and reverts the whole
 *                        run BEFORE any handoff if a wrong ctor arg was used (so
 *                        the deployer still controls everything and can redeploy).
 *
 * Env (addresses): SAFE, V2_FACTORY, V3_FACTORY, FEE_PROTOCOL_MANAGER,
 *   AUTO_COMPOUNDER, ARCADE_HOOK, TWITTER_ESCROW, V3_LOCKER, LAUNCHPAD,
 *   AIRDROP_DISTRIBUTOR
 * Env (key): DEPLOYER_PRIVATE_KEY
 *
 * Peripheral V4 contracts (governance verified 2026-08-13):
 *   - airdropDistributor (HolderAirdropDistributor): setTreasury(Safe) +
 *     transferOwnership(Safe) -- 1-STEP (direct, no acceptOwnership). Handled.
 *   - splitterFactory (SplitterLaunchFactory): OWNERLESS -- each per-launch
 *     CreatorSplitter is owned by its creator, not the factory. Nothing to do.
 *   - lockedVault (LockedVault): no admin, no owner-setter, zero functions (a
 *     pure LP holder). Nothing to do.
 *   - tokenVault (ArcadeTokenVault): no governance. Nothing to do.
 */
interface IV2Factory {
    function feeTo() external view returns (address);
    function feeToSetter() external view returns (address);
    function setFeeTo(address) external;
    function setFeeToSetter(address) external;
}

interface IV3Factory {
    function owner() external view returns (address);
    function setOwner(address) external;
}

interface IFeeProtocolManager {
    function treasury() external view returns (address);
    function setTreasury(address) external;
    function transferOwnership(address) external; // 2-step
}

interface IAutoCompounder {
    function feeRecipient() external view returns (address);
    function setFeeRecipient(address) external;
    function transferOwnership(address) external; // 2-step
}

interface IArcadeHook {
    function TREASURY() external view returns (address);
    function setTreasury(address) external;
    function transferOwnership(address) external; // OZ Ownable2Step
}

interface IOwnable2Step {
    function transferOwnership(address) external; // OZ Ownable2Step (escrow)
}

interface IHolderAirdrop {
    function owner() external view returns (address);
    function treasury() external view returns (address);
    function setTreasury(address) external;
    function transferOwnership(address) external; // 1-step (direct, no accept)
}

interface IImmutableOwner {
    function owner() external view returns (address);
}

interface ILaunchpad {
    function treasury() external view returns (address);
}

contract TransferOwnershipToSafe is Script {
    function run() external {
        address safe = vm.envAddress("SAFE");
        address v2Factory = vm.envAddress("V2_FACTORY");
        address v3Factory = vm.envAddress("V3_FACTORY");
        address mgr = vm.envAddress("FEE_PROTOCOL_MANAGER");
        address comp = vm.envAddress("AUTO_COMPOUNDER");
        address hook = vm.envAddress("ARCADE_HOOK");
        address escrow = vm.envAddress("TWITTER_ESCROW");
        address locker = vm.envAddress("V3_LOCKER");
        address launchpad = vm.envAddress("LAUNCHPAD");
        address airdrop = vm.envAddress("AIRDROP_DISTRIBUTOR");
        require(safe != address(0), "SAFE unset");

        // --- Pre-flight: the IMMUTABLE-owner contracts must ALREADY be the Safe.
        //     If not, the deploy passed a wrong constructor arg; stop before any
        //     handoff (the deployer still controls everything -> redeploy those). ---
        require(IImmutableOwner(locker).owner() == safe, "v3Locker.owner != Safe (immutable: redeploy with Safe)");
        require(ILaunchpad(launchpad).treasury() == safe, "launchpad.treasury != Safe (immutable: redeploy with Safe)");

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));

        // v2 factory: fee destination + governance. setFeeTo BEFORE setFeeToSetter
        // (once the setter is the Safe, the deployer can no longer set feeTo).
        IV2Factory(v2Factory).setFeeTo(safe);
        IV2Factory(v2Factory).setFeeToSetter(safe);

        // v3 factory: owned by the fee manager (itself Safe-owned).
        IV3Factory(v3Factory).setOwner(mgr);

        // Fee manager: fixed harvest treasury (immediate) + 2-step ownership.
        IFeeProtocolManager(mgr).setTreasury(safe);
        IFeeProtocolManager(mgr).transferOwnership(safe);

        // Auto-compounder: fee recipient (immediate) + 2-step ownership.
        IAutoCompounder(comp).setFeeRecipient(safe);
        IAutoCompounder(comp).transferOwnership(safe);

        // V4 hook: fee treasury (immediate) + 2-step ownership.
        IArcadeHook(hook).setTreasury(safe);
        IArcadeHook(hook).transferOwnership(safe);

        // Twitter escrow: 2-step ownership (the trustedSigner is a separate EOA,
        // set in the constructor / rotated via startSignerRotation).
        IOwnable2Step(escrow).transferOwnership(safe);

        // Holder airdrop distributor: forfeit treasury + 1-STEP ownership
        // (direct, no acceptOwnership). setTreasury BEFORE transferOwnership.
        IHolderAirdrop(airdrop).setTreasury(safe);
        IHolderAirdrop(airdrop).transferOwnership(safe);

        vm.stopBroadcast();

        // --- Post: assert the IMMEDIATE (single-step) settings landed on the Safe.
        //     The 2-step ownerships are still PENDING until the Safe accepts, so
        //     they are logged, not asserted. ---
        require(IV2Factory(v2Factory).feeTo() == safe, "feeTo != Safe");
        require(IV2Factory(v2Factory).feeToSetter() == safe, "feeToSetter != Safe");
        require(IV3Factory(v3Factory).owner() == mgr, "v3Factory.owner != manager");
        require(IFeeProtocolManager(mgr).treasury() == safe, "mgr.treasury != Safe");
        require(IAutoCompounder(comp).feeRecipient() == safe, "comp.feeRecipient != Safe");
        require(IArcadeHook(hook).TREASURY() == safe, "hook.TREASURY != Safe");
        // Airdrop is 1-step, so its ownership is final here too (assert both).
        require(IHolderAirdrop(airdrop).treasury() == safe, "airdrop.treasury != Safe");
        require(IHolderAirdrop(airdrop).owner() == safe, "airdrop.owner != Safe");

        console2.log("Immediate settings -> Safe: OK (feeTo, feeToSetter, v3Factory owner, mgr/hook treasury, comp feeRecipient, airdrop owner+treasury)");
        console2.log("Immutable owners already Safe: v3Locker, launchpad");
        console2.log("=> The Safe must now call acceptOwnership() on each of:");
        console2.log("   feeProtocolManager:", mgr);
        console2.log("   autoCompounder    :", comp);
        console2.log("   arcadeHook        :", hook);
        console2.log("   twitterEscrow     :", escrow);
    }
}
