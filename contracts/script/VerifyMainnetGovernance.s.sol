// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";

/**
 * READ-ONLY post-deploy verifier for the mainnet cutover. Run it AFTER the deploy
 * + TransferOwnershipToSafe + the Safe's acceptOwnership() calls, to prove the
 * FINAL governance state landed (unlike TransferOwnershipToSafe's post-asserts,
 * which run mid-handoff and can't cover the still-pending 2-step owners).
 *
 * No broadcast, no state change: `forge script script/VerifyMainnetGovernance.s.sol
 * --rpc-url <mainnet>`  (drop --broadcast). It reverts on the FIRST mismatch with a
 * named message, else logs every check + "ALL GOVERNANCE CHECKS PASSED".
 *
 * Env (addresses): SAFE, EXPECTED_SIGNER (escrow trustedSigner), V2_FACTORY,
 *   V3_FACTORY, FEE_PROTOCOL_MANAGER, AUTO_COMPOUNDER, ARCADE_HOOK, TWITTER_ESCROW,
 *   AIRDROP_DISTRIBUTOR, V4_ROUTER, V3_LOCKER, LAUNCHPAD
 */
interface IReads {
    function owner() external view returns (address);
    function feeTo() external view returns (address);
    function feeToSetter() external view returns (address);
    function treasury() external view returns (address);
    function factory() external view returns (address);
    function locker() external view returns (address);
    function feeRecipient() external view returns (address);
    function TREASURY() external view returns (address);
    function trustedSigner() external view returns (address);
}

contract VerifyMainnetGovernance is Script {
    function run() external view {
        address safe = vm.envAddress("SAFE");
        address signer = vm.envAddress("EXPECTED_SIGNER");
        address v2Factory = vm.envAddress("V2_FACTORY");
        address v3Factory = vm.envAddress("V3_FACTORY");
        address mgr = vm.envAddress("FEE_PROTOCOL_MANAGER");
        address comp = vm.envAddress("AUTO_COMPOUNDER");
        address hook = vm.envAddress("ARCADE_HOOK");
        address escrow = vm.envAddress("TWITTER_ESCROW");
        address airdrop = vm.envAddress("AIRDROP_DISTRIBUTOR");
        address v4Router = vm.envAddress("V4_ROUTER");
        address locker = vm.envAddress("V3_LOCKER");
        address launchpad = vm.envAddress("LAUNCHPAD");

        // Fee destinations -> Safe.
        _eq("v2Factory.feeTo", IReads(v2Factory).feeTo(), safe);
        _eq("v2Factory.feeToSetter", IReads(v2Factory).feeToSetter(), safe);
        _eq("feeProtocolManager.treasury", IReads(mgr).treasury(), safe);
        _eq("arcadeHook.TREASURY", IReads(hook).TREASURY(), safe);
        _eq("autoCompounder.feeRecipient", IReads(comp).feeRecipient(), safe);
        _eq("airdrop.treasury", IReads(airdrop).treasury(), safe);
        _eq("launchpad.treasury (immutable)", IReads(launchpad).treasury(), safe);

        // Ownership -> Safe (these must be FINAL, i.e. the 2-step accepts are done).
        _eq("v3Factory.owner", IReads(v3Factory).owner(), mgr);
        _eq("feeProtocolManager.owner", IReads(mgr).owner(), safe);
        _eq("autoCompounder.owner", IReads(comp).owner(), safe);
        _eq("arcadeHook.owner", IReads(hook).owner(), safe);
        _eq("twitterEscrow.owner", IReads(escrow).owner(), safe);
        _eq("airdrop.owner", IReads(airdrop).owner(), safe);
        _eq("v4Router.owner", IReads(v4Router).owner(), safe);
        _eq("v3Locker.owner (immutable)", IReads(locker).owner(), safe);

        // Manager immutables sane + the escrow signs with the expected key.
        _eq("feeProtocolManager.factory", IReads(mgr).factory(), v3Factory);
        _eq("feeProtocolManager.locker", IReads(mgr).locker(), locker);
        _eq("twitterEscrow.trustedSigner", IReads(escrow).trustedSigner(), signer);

        console2.log("");
        console2.log("ALL GOVERNANCE CHECKS PASSED (everything on the Safe / expected signer).");
    }

    function _eq(string memory what, address got, address want) internal view {
        if (got != want) {
            revert(string.concat("MISMATCH ", what, ": got ", vm.toString(got), " want ", vm.toString(want)));
        }
        console2.log(string.concat("OK  ", what));
    }
}
