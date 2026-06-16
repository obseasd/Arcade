import { NextRequest, NextResponse } from "next/server";
import {
    createPublicClient,
    erc20Abi,
    fallback,
    http,
    type Address,
    type PublicClient,
} from "viem";
import { FACTORY_ABI, PAIR_ABI } from "@/lib/abis/dex";
import { ADDRESSES } from "@/lib/constants";

/**
 * Lists every V2 pair the wallet has LP in, plus where the LP came
 * from. Used to track down "mystery" LP positions that show up in
 * MyPositions even though the user does not remember providing.
 */
export const dynamic = "force-dynamic";

const ARC_RPC_LIST: readonly string[] = [
    "https://5042002.rpc.thirdweb.com",
    "https://rpc.testnet.arc.network",
];
const ARC_CHAIN = {
    id: 5042002,
    name: "Arc Testnet",
    network: "arc-testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
    rpcUrls: {
        default: { http: ARC_RPC_LIST },
        public: { http: ARC_RPC_LIST },
    },
} as const;

export async function GET(req: NextRequest) {
    const owner = req.nextUrl.searchParams.get("owner");
    if (!owner || !/^0x[a-fA-F0-9]{40}$/.test(owner)) {
        return NextResponse.json(
            { error: "owner query param required (0x + 40 hex)" },
            { status: 400 },
        );
    }

    const client = createPublicClient({
        chain: ARC_CHAIN,
        transport: fallback(ARC_RPC_LIST.map((u) => http(u))),
    }) as unknown as PublicClient;

    // 1) Walk every pair on the V2 factory.
    let pairCount = 0;
    try {
        pairCount = Number(
            (await client.readContract({
                address: ADDRESSES.factory,
                abi: FACTORY_ABI,
                functionName: "allPairsLength",
            })) as bigint,
        );
    } catch (err) {
        return NextResponse.json(
            { step: "allPairsLength", error: (err as Error).message },
            { status: 500 },
        );
    }

    const pairAddresses: Address[] = [];
    for (let i = 0; i < pairCount; i++) {
        try {
            const addr = (await client.readContract({
                address: ADDRESSES.factory,
                abi: FACTORY_ABI,
                functionName: "allPairs",
                args: [BigInt(i)],
            })) as Address;
            pairAddresses.push(addr);
        } catch {
            pairAddresses.push(
                "0x0000000000000000000000000000000000000000" as Address,
            );
        }
    }

    // 2) For each pair, read the user's LP balance and skip zero.
    const positions: Array<{
        pair: Address;
        balance: string;
        token0: Address;
        token1: Address;
        token0Symbol: string;
        token1Symbol: string;
        totalSupply: string;
        reserve0: string;
        reserve1: string;
    }> = [];

    for (const pair of pairAddresses) {
        try {
            const balance = (await client.readContract({
                address: pair,
                abi: PAIR_ABI,
                functionName: "balanceOf",
                args: [owner as Address],
            })) as bigint;
            if (balance === 0n) continue;

            const [token0, token1, totalSupply, reserves] = await Promise.all([
                client.readContract({
                    address: pair,
                    abi: PAIR_ABI,
                    functionName: "token0",
                }) as Promise<Address>,
                client.readContract({
                    address: pair,
                    abi: PAIR_ABI,
                    functionName: "token1",
                }) as Promise<Address>,
                client.readContract({
                    address: pair,
                    abi: PAIR_ABI,
                    functionName: "totalSupply",
                }) as Promise<bigint>,
                client.readContract({
                    address: pair,
                    abi: PAIR_ABI,
                    functionName: "getReserves",
                }) as Promise<readonly [bigint, bigint, number]>,
            ]);

            const [symbol0, symbol1] = await Promise.all([
                client
                    .readContract({
                        address: token0,
                        abi: erc20Abi,
                        functionName: "symbol",
                    })
                    .catch(() => "?") as Promise<string>,
                client
                    .readContract({
                        address: token1,
                        abi: erc20Abi,
                        functionName: "symbol",
                    })
                    .catch(() => "?") as Promise<string>,
            ]);

            positions.push({
                pair,
                balance: balance.toString(),
                token0,
                token1,
                token0Symbol: symbol0,
                token1Symbol: symbol1,
                totalSupply: totalSupply.toString(),
                reserve0: reserves[0].toString(),
                reserve1: reserves[1].toString(),
            });
        } catch {
            // Skip pairs that error out (eg uninitialised).
        }
    }

    return NextResponse.json({
        owner,
        pairsScanned: pairCount,
        positions,
    });
}
