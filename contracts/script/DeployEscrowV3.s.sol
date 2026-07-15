// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ArcadeTwitterEscrowV3} from "../src/launchpad/ArcadeTwitterEscrowV3.sol";

/// @dev Just enough of the launchpad to prove it uses the locker we are about
///      to wire in. See the cross-check in run().
interface IArcadeLaunchpadV3Locker {
    function v3Locker() external view returns (address);
}

/**
 * @title DeployEscrowV3
 * @notice Deploys the audit-fixed v3 escrow + upgraded V3 locker, wiring the
 *         two together via the escrow's one-shot `setLocker`.
 *
 *         Bootstrap order:
 *           1. Deploy `ArcadeTwitterEscrowV3(trustedSigner, owner)` - LOCKER
 *              starts at 0.
 *           2. Deploy upgraded `ArcadeV3Locker(launchpad, factory, escrow)`
 *              (the locker reads the escrow address as its immutable
 *              `twitterEscrow`).
 *           3. Call `escrow.setLocker(locker)` from the owner.
 *
 *         This script handles steps 1 and 3 only because the V3 locker is
 *         compiled with 0.7.6 and lives in a separate Foundry profile. Run
 *         the locker deploy out-of-band with:
 *
 *           FOUNDRY_PROFILE=v3 forge build
 *
 *         Then either use `cast send` to deploy the locker bytecode against
 *         the escrow address logged here, OR re-run `DeployTestnet.s.sol`
 *         with `TWITTER_ESCROW_ADDRESS` set to wire everything in one
 *         broadcast (note: that fully redeploys the launchpad too).
 *
 *         Required env:
 *           PRIVATE_KEY              = deployer key with USDC for gas.
 *           ARCADE_BACKEND_SIGNER    = backend wallet address (signs claims).
 *           ESCROW_OWNER             = owner of the escrow (multisig on
 *                                      mainnet; can be the deployer on
 *                                      testnet).
 *           V3_LOCKER_ADDRESS        = OPTIONAL. If set AND non-zero, the
 *                                      script also calls `setLocker` after
 *                                      deploying the escrow. Otherwise
 *                                      LOCKER stays at 0 and you must call
 *                                      `setLocker` manually once the locker
 *                                      is deployed.
 *
 *         Usage:
 *           FOUNDRY_PROFILE=default \
 *           PRIVATE_KEY=0x... \
 *           ARCADE_BACKEND_SIGNER=0x... \
 *           ESCROW_OWNER=0x... \
 *           forge script script/DeployEscrowV3.s.sol --rpc-url arc_testnet --broadcast
 */
contract DeployEscrowV3 is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address signer = vm.envAddress("ARCADE_BACKEND_SIGNER");
        address owner = vm.envOr("ESCROW_OWNER", deployer);
        address knownLocker = vm.envOr("V3_LOCKER_ADDRESS", address(0));

        require(signer != address(0), "ARCADE_BACKEND_SIGNER must be set");

        vm.startBroadcast(pk);

        ArcadeTwitterEscrowV3 escrow = new ArcadeTwitterEscrowV3(signer, owner);

        if (knownLocker != address(0)) {
            // CROSS-CHECK BEFORE WIRING. setLocker verifies locker -> escrow
            // (`locker.twitterEscrow() == address(this)`), which is necessary
            // but NOT sufficient: two lockers both constructed with this escrow
            // both satisfy it, so setLocker cannot tell whether the LAUNCHPAD
            // actually uses this one.
            //
            // Pick the wrong one and it is TERMINAL: the real locker's
            // creditSlot calls arrive from an address that is not LOCKER, so
            // every credit reverts NotLocker, balances stay 0, authorize
            // reverts NothingToClaim, no claim ever lands, and `claimed` stays
            // false forever -- which also gates out rotateLockerSlot, the only
            // recovery. And rotateLockerSlot targets LOCKER anyway, so the real
            // locker's slots can never be rotated by anyone. setLocker is
            // one-shot and twitterEscrow is immutable: no second chance.
            //
            // DeploySecurityV3 already asserts both directions. This script
            // takes an operator-supplied address and asserted neither, which is
            // exactly where the mistake gets made. One read, at deploy time.
            address lp = vm.envOr("LAUNCHPAD_ADDRESS", address(0));
            if (lp != address(0)) {
                require(
                    IArcadeLaunchpadV3Locker(lp).v3Locker() == knownLocker,
                    "V3_LOCKER_ADDRESS is not the locker the launchpad uses"
                );
            } else {
                console2.log("WARNING: LAUNCHPAD_ADDRESS unset - could NOT verify");
                console2.log("  that the launchpad uses this locker. Wiring the wrong");
                console2.log("  one is unrecoverable. Check launchpad.v3Locker() by hand.");
            }
            // Only the owner can call setLocker. If the deployer == owner
            // we wire in the same broadcast; otherwise log a reminder.
            if (owner == deployer) {
                escrow.setLocker(knownLocker);
            }
        }

        vm.stopBroadcast();

        console2.log("Chain:               Arc");
        console2.log("Deployer:            ", deployer);
        console2.log("Escrow V3:           ", address(escrow));
        console2.log("TrustedSigner:       ", signer);
        console2.log("Owner:               ", owner);
        if (knownLocker != address(0)) {
            console2.log("Locker (pre-known):  ", knownLocker);
            if (owner == deployer) {
                console2.log("setLocker:           wired in this broadcast");
            } else {
                console2.log("setLocker:           PENDING - run separately with the owner key:");
                console2.log("                     cast send", address(escrow), "'setLocker(address)'", knownLocker);
            }
        } else {
            console2.log("Locker:              UNSET (call setLocker after deploying the upgraded locker)");
        }
        console2.log("");
        console2.log("Next:");
        console2.log("  1. Deploy upgraded ArcadeV3Locker with twitterEscrow = escrow address above");
        console2.log("  2. Call escrow.setLocker(locker) from the owner (if not already done)");
        console2.log("  3. Update web env: NEXT_PUBLIC_TWITTER_ESCROW_ADDRESS = escrow address");
    }
}
