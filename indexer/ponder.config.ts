import { createConfig, factory } from "ponder";
import { http, getAbiItem } from "viem";
import { LaunchpadAbi, V3FactoryAbi, V3PoolAbi } from "./abis";

/**
 * Ponder config for the Arcade OHLC indexer on Arc testnet.
 *
 * Indexes:
 *   - Launchpad Buy/Sell  -> curve/migrated token trades (price from newPriceQ64)
 *   - V3 pools (via the factory's PoolCreated) -> Swap trades (price from
 *     sqrtPriceX96). The factory() source makes Ponder auto-discover every pool
 *     the factory creates and index its Swaps -- no hardcoded pool list.
 *
 * All addresses + start blocks come from env so the same code serves testnet
 * now and mainnet later (turn-key). START_BLOCK should be the launchpad's
 * deploy block for full history; see INDEXER_SETUP.md for how to find it.
 */

const RPC_URL = process.env.PONDER_RPC_URL_5042002 ?? "https://rpc.testnet.arc.network";
const CHAIN_ID = Number(process.env.ARC_CHAIN_ID ?? 5042002);
const LAUNCHPAD = (process.env.LAUNCHPAD_ADDRESS ?? "") as `0x${string}`;
const V3_FACTORY = (process.env.V3_FACTORY_ADDRESS ?? "") as `0x${string}`;
// Separate start blocks: the launchpad is the CURRENT gen (recent deploy),
// while the V3 factory is REUSED across gens (older), so its pools + swaps
// predate the launchpad. Using one block for both would miss early V3 history.
const LAUNCHPAD_START_BLOCK = Number(process.env.LAUNCHPAD_START_BLOCK ?? 0);
const V3_START_BLOCK = Number(process.env.V3_START_BLOCK ?? 0);

export default createConfig({
    chains: {
        arc: {
            id: CHAIN_ID,
            rpc: http(RPC_URL),
        },
    },
    contracts: {
        Launchpad: {
            chain: "arc",
            abi: LaunchpadAbi,
            address: LAUNCHPAD,
            startBlock: LAUNCHPAD_START_BLOCK,
        },
        // Every pool the V3 factory has ever created; Ponder indexes each
        // child pool's Swap events. The PoolCreated event's `pool` arg names
        // the child address.
        V3Pool: {
            chain: "arc",
            abi: V3PoolAbi,
            address: factory({
                address: V3_FACTORY,
                event: getAbiItem({ abi: V3FactoryAbi, name: "PoolCreated" }),
                parameter: "pool",
            }),
            startBlock: V3_START_BLOCK,
        },
        // The factory itself, so we capture PoolCreated to learn each pool's
        // token0 orientation (usdcIsToken0) before its first Swap.
        V3Factory: {
            chain: "arc",
            abi: V3FactoryAbi,
            address: V3_FACTORY,
            startBlock: V3_START_BLOCK,
        },
    },
});
