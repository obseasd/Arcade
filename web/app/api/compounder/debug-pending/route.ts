import { NextRequest, NextResponse } from "next/server";
import {
    createPublicClient,
    fallback,
    http,
    type Address,
    type Hex,
    type PublicClient,
} from "viem";
import { V3_NPM_ABI, V3_POOL_ABI } from "@/lib/abis/v3-npm";
import { V3_POOL_ABI as V3_POOL_ABI_FULL } from "@/lib/abis/v3";
import { V3_FACTORY_ABI } from "@/lib/abis/v3-npm";
import { ADDRESSES } from "@/lib/constants";
import { computePendingFees } from "@/lib/v3-fee-math";

/**
 * Server-side replica of the client's pending-fees math. Lets us tell
 * "the UI shows 0 because the math returns 0" from "the math is right
 * and the UI is dropping it on the floor" with one curl.
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
    const tokenId = req.nextUrl.searchParams.get("tokenId");
    if (!tokenId || !/^\d+$/.test(tokenId)) {
        return NextResponse.json(
            { error: "tokenId query param required" },
            { status: 400 },
        );
    }

    const client = createPublicClient({
        chain: ARC_CHAIN,
        transport: fallback(ARC_RPC_LIST.map((u) => http(u))),
    }) as unknown as PublicClient;

    // 1. NPM.positions(tokenId)
    let position;
    try {
        position = (await client.readContract({
            address: ADDRESSES.v3PositionManager,
            abi: V3_NPM_ABI,
            functionName: "positions",
            args: [BigInt(tokenId)],
        })) as readonly [
            bigint,
            Address,
            Address,
            Address,
            number,
            number,
            number,
            bigint,
            bigint,
            bigint,
            bigint,
            bigint,
        ];
    } catch (err) {
        return NextResponse.json(
            {
                step: "positions",
                error: (err as Error).message,
            },
            { status: 500 },
        );
    }

    const token0 = position[2];
    const token1 = position[3];
    const fee = Number(position[4]);
    const tickLower = Number(position[5]);
    const tickUpper = Number(position[6]);
    const liquidity = position[7];
    const feeGrowthInside0LastX128 = position[8];
    const feeGrowthInside1LastX128 = position[9];
    const tokensOwed0 = position[10];
    const tokensOwed1 = position[11];

    // 2. factory.getPool(token0, token1, fee)
    let pool: Address;
    try {
        pool = (await client.readContract({
            address: ADDRESSES.v3Factory,
            abi: V3_FACTORY_ABI,
            functionName: "getPool",
            args: [token0, token1, fee],
        })) as Address;
    } catch (err) {
        return NextResponse.json(
            { step: "getPool", error: (err as Error).message },
            { status: 500 },
        );
    }

    // 3. Pool reads: slot0, feeGrowthGlobal, ticks(lower/upper)
    const slot0 = (await client.readContract({
        address: pool,
        abi: V3_POOL_ABI,
        functionName: "slot0",
    })) as readonly [bigint, number, ...unknown[]];

    const feeGrowthGlobal0X128 = (await client.readContract({
        address: pool,
        abi: V3_POOL_ABI_FULL,
        functionName: "feeGrowthGlobal0X128",
    })) as bigint;
    const feeGrowthGlobal1X128 = (await client.readContract({
        address: pool,
        abi: V3_POOL_ABI_FULL,
        functionName: "feeGrowthGlobal1X128",
    })) as bigint;

    const lowerTick = (await client.readContract({
        address: pool,
        abi: V3_POOL_ABI_FULL,
        functionName: "ticks",
        args: [tickLower],
    })) as readonly [
        bigint,
        bigint,
        bigint,
        bigint,
        ...unknown[],
    ];
    const upperTick = (await client.readContract({
        address: pool,
        abi: V3_POOL_ABI_FULL,
        functionName: "ticks",
        args: [tickUpper],
    })) as readonly [
        bigint,
        bigint,
        bigint,
        bigint,
        ...unknown[],
    ];

    // 4. Apply math
    const fees = computePendingFees({
        currentTick: Number(slot0[1]),
        tickLower,
        tickUpper,
        feeGrowthGlobal0X128,
        feeGrowthGlobal1X128,
        lowerFeeGrowthOutside0X128: lowerTick[2],
        lowerFeeGrowthOutside1X128: lowerTick[3],
        upperFeeGrowthOutside0X128: upperTick[2],
        upperFeeGrowthOutside1X128: upperTick[3],
        liquidity,
        feeGrowthInside0LastX128,
        feeGrowthInside1LastX128,
        tokensOwed0,
        tokensOwed1,
    });

    return NextResponse.json({
        tokenId,
        pool,
        token0,
        token1,
        fee,
        tickLower,
        tickUpper,
        currentTick: Number(slot0[1]),
        liquidity: liquidity.toString(),
        feeGrowthInside0LastX128: feeGrowthInside0LastX128.toString(),
        feeGrowthInside1LastX128: feeGrowthInside1LastX128.toString(),
        tokensOwed0: tokensOwed0.toString(),
        tokensOwed1: tokensOwed1.toString(),
        feeGrowthGlobal0X128: feeGrowthGlobal0X128.toString(),
        feeGrowthGlobal1X128: feeGrowthGlobal1X128.toString(),
        lowerTick_feeGrowthOutside0X128: lowerTick[2].toString(),
        lowerTick_feeGrowthOutside1X128: lowerTick[3].toString(),
        upperTick_feeGrowthOutside0X128: upperTick[2].toString(),
        upperTick_feeGrowthOutside1X128: upperTick[3].toString(),
        computed: {
            fees0: fees.fees0.toString(),
            fees1: fees.fees1.toString(),
        },
    });

    void liquidity; // already used
    void (token0 as Hex);
}
