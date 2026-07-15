// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Compiled by the DEFAULT profile, not the `v3` one: the v3 profile points its
// script dir at a non-existent path, and these only need the minimal interfaces
// declared below rather than any v3-core import, so there is nothing to gain
// from dragging them into the 0.7.6 build.

import {Script, console2} from "forge-std/Script.sol";

interface IV3FactoryMin {
    function owner() external view returns (address);
    function setOwner(address) external;
    function getPool(address, address, uint24) external view returns (address);
}

interface IV3PoolMin {
    function slot0()
        external
        view
        returns (uint160, int24, uint16, uint16, uint16, uint8 feeProtocol, bool);
    function fee() external view returns (uint24);
    function setFeeProtocol(uint8 feeProtocol0, uint8 feeProtocol1) external;
    function collectProtocol(address recipient, uint128 amount0Requested, uint128 amount1Requested)
        external
        returns (uint128 amount0, uint128 amount1);
    function protocolFees() external view returns (uint128 token0, uint128 token1);
}

/**
 * V3 protocol-fee plumbing. Three separate scripts, deliberately: turning the
 * fee ON is a governance decision, and the ONLY thing that should be routine is
 * reading state and harvesting.
 *
 * WHY THIS EXISTS EVEN THOUGH WE SHIP AT 0.
 * `feeProtocol` is a per-pool switch settable only by the V3 factory owner.
 * Enabling it later is one tx per pool, but ONLY if the owner path exists and
 * is in the right hands. If mainnet ships with the owner still an EOA, we
 * either run protocol revenue off a solo key or we redeploy pools. The plumbing
 * is nearly free before launch and expensive to retrofit, so build it now and
 * leave the switch at 0. Uniswap waited five years to flip theirs; the point is
 * to be ABLE to.
 *
 * WHAT feeProtocol ACTUALLY DOES (stated plainly, because it is widely
 * misunderstood): it does NOT raise the trader's cost. The fee tier is what the
 * trader pays, full stop. feeProtocol only SPLITS that existing fee, taking
 * 1/N off the top before the rest reaches the LP. So it takes from LPs, not
 * traders.
 *
 * WHICH POOLS. User-created pools only. On CLANKER_V3 launch pools we already
 * take 20% of the LP fee via the locker, which is exactly what Clanker (20% via
 * hook) and Meteora (20% on launch pools) take. Stacking feeProtocol on top
 * would come out of the CREATOR's 80%, not the trader's pocket, and would make
 * us the only protocol in the field applying two mechanisms to one fee stream.
 * Nobody who owns the LP also skims that same pool. So: LP ownership on launch
 * pools, feeProtocol on ordinary pools. One mechanism per pool, never both.
 *
 * HARD CONSTRAINT: stock v3-core accepts feeProtocol of 0, or 4..10 ONLY. The
 * minimum non-zero take is therefore 1/10 = 10%. There is no "small 2%".
 * Uniswap's own post-UNIfication values are 1/4 on the 0.01%/0.05% tiers and
 * 1/6 on the 0.30%/1% tiers; mirroring the leader's published schedule is the
 * least arguable choice.
 */
contract V3ProtocolFeeStatus is Script {
    /// Read-only. `POOLS` is a comma-free single address for now; run per pool.
    function run() external view {
        address factory = vm.envAddress("V3_FACTORY_ADDRESS");
        address pool = vm.envAddress("POOL_ADDRESS");
        console2.log("factory owner:", IV3FactoryMin(factory).owner());
        console2.log("pool:", pool);
        console2.log("  fee tier:", uint256(IV3PoolMin(pool).fee()));
        (,,,,, uint8 fp,) = IV3PoolMin(pool).slot0();
        // feeProtocol packs both sides: fp0 = fp % 16, fp1 = fp >> 4.
        console2.log("  feeProtocol raw:", uint256(fp));
        console2.log("  feeProtocol0 (1/N, 0=off):", uint256(fp % 16));
        console2.log("  feeProtocol1 (1/N, 0=off):", uint256(fp >> 4));
        (uint128 a0, uint128 a1) = IV3PoolMin(pool).protocolFees();
        console2.log("  accrued token0:", uint256(a0));
        console2.log("  accrued token1:", uint256(a1));
    }
}

/**
 * Enable (or disable) the protocol fee on ONE pool. Governance action.
 *
 * FEE_PROTOCOL_0 / FEE_PROTOCOL_1 must each be 0 or 4..10. Mirror Uniswap:
 *   0.01% / 0.05% tiers -> 4 (1/4)
 *   0.30% / 1%    tiers -> 6 (1/6)
 * Do NOT run this on a CLANKER_V3 launch pool: it would cannibalise the
 * creator's 80% locker share, not the trader.
 */
contract V3ProtocolFeeSet is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address pool = vm.envAddress("POOL_ADDRESS");
        uint8 fp0 = uint8(vm.envUint("FEE_PROTOCOL_0"));
        uint8 fp1 = uint8(vm.envUint("FEE_PROTOCOL_1"));
        require(fp0 == 0 || (fp0 >= 4 && fp0 <= 10), "fp0 must be 0 or 4..10");
        require(fp1 == 0 || (fp1 >= 4 && fp1 <= 10), "fp1 must be 0 or 4..10");

        vm.startBroadcast(pk);
        IV3PoolMin(pool).setFeeProtocol(fp0, fp1);
        vm.stopBroadcast();

        (,,,,, uint8 fp,) = IV3PoolMin(pool).slot0();
        console2.log("pool:", pool);
        console2.log("  feeProtocol0 now:", uint256(fp % 16));
        console2.log("  feeProtocol1 now:", uint256(fp >> 4));
    }
}

/**
 * Harvest accrued protocol fees to the treasury. Without this, flipping the
 * switch earns nothing: the fees sit in the pool's `protocolFees` accumulator
 * until someone drains them. Safe to run routinely.
 */
contract V3ProtocolFeeCollect is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address pool = vm.envAddress("POOL_ADDRESS");
        address to = vm.envAddress("TREASURY_ADDRESS");

        (uint128 before0, uint128 before1) = IV3PoolMin(pool).protocolFees();
        console2.log("accrued token0:", uint256(before0));
        console2.log("accrued token1:", uint256(before1));

        vm.startBroadcast(pk);
        // type(uint128).max drains whatever is there. v3-core leaves 1 wei on
        // each side to keep the storage slot warm, which is intended.
        (uint128 got0, uint128 got1) =
            IV3PoolMin(pool).collectProtocol(to, type(uint128).max, type(uint128).max);
        vm.stopBroadcast();

        console2.log("collected token0:", uint256(got0));
        console2.log("collected token1:", uint256(got1));
        console2.log("to:", to);
    }
}

/**
 * Hand the V3 factory owner to the multisig. THIS is the item that must land
 * before mainnet: it is what makes enabling the fee a governance decision
 * rather than a solo key, and it is the same key that today also controls
 * setOwner and enableFeeAmount.
 */
contract V3FactoryTransferOwner is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address factory = vm.envAddress("V3_FACTORY_ADDRESS");
        address newOwner = vm.envAddress("NEW_OWNER");
        require(newOwner != address(0), "zero owner");

        console2.log("current owner:", IV3FactoryMin(factory).owner());
        vm.startBroadcast(pk);
        IV3FactoryMin(factory).setOwner(newOwner);
        vm.stopBroadcast();
        console2.log("new owner:", IV3FactoryMin(factory).owner());
    }
}
