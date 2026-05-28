import { NextRequest, NextResponse } from "next/server";
import { Address, createPublicClient, erc20Abi, http, isAddress, parseAbiItem } from "viem";
import { LAUNCHPAD_ABI } from "@/lib/abis/launchpad";

const TOKEN_CREATED_EVT = parseAbiItem(
  "event TokenCreated(address indexed token, address indexed creator, uint8 mode, address creator2, uint16 creator2ShareBps, string name, string symbol, string metadataURI)",
);
import { arcTestnet } from "@/lib/chains";
import { ADDRESSES, FEATURED_TOKENS } from "@/lib/constants";
import { parseInlineMetadata } from "@/lib/metadata";

export const dynamic = "force-dynamic";
export const revalidate = 30;

const client = createPublicClient({
  chain: arcTestnet,
  transport: http(arcTestnet.rpcUrls.default.http[0]),
});

interface TokenRow {
  address: Address;
  name: string | null;
  symbol: string | null;
  creator: Address;
  mode: number;
  createdAt: number;
  migrated: boolean;
  marketCap: string | null;
  pool: Address | null;
  metadata: {
    image?: string;
    description?: string;
    twitter?: string;
    creatorTwitter?: string;
    website?: string;
    telegram?: string;
  } | null;
  featured: boolean;
}

async function getAllTokens(): Promise<TokenRow[]> {
  const count = (await client.readContract({
    address: ADDRESSES.launchpad,
    abi: LAUNCHPAD_ABI,
    functionName: "getTokensCount",
  })) as bigint;
  const n = Number(count);
  if (n === 0) return [];

  // 1) addresses
  const addrCalls = Array.from({ length: n }, (_, i) => ({
    address: ADDRESSES.launchpad,
    abi: LAUNCHPAD_ABI,
    functionName: "allTokens" as const,
    args: [BigInt(i)],
  }));
  const addrRes = await client.multicall({ contracts: addrCalls, allowFailure: true });
  const addresses = addrRes
    .map((r) => (r.status === "success" ? (r.result as Address) : null))
    .filter((a): a is Address => !!a);
  if (addresses.length === 0) return [];

  // 2) state + name + symbol per address (3 calls each)
  const detailCalls = addresses.flatMap((a) => [
    { address: ADDRESSES.launchpad, abi: LAUNCHPAD_ABI, functionName: "getTokenState" as const, args: [a] },
    { address: a, abi: erc20Abi, functionName: "name" as const },
    { address: a, abi: erc20Abi, functionName: "symbol" as const },
  ]);
  const detailRes = await client.multicall({ contracts: detailCalls, allowFailure: true });

  // Batch-fetch all TokenCreated events to recover metadataURIs (no longer stored
  // in state). Single pass over recent logs.
  const metadataMap = new Map<string, string>();
  try {
    const latest = await client.getBlockNumber();
    let end = latest;
    let walked = 0n;
    while (walked < 500_000n) {
      const start = end > 999n ? end - 999n : 0n;
      try {
        const logs = await client.getLogs({
          address: ADDRESSES.launchpad,
          event: TOKEN_CREATED_EVT,
          fromBlock: start,
          toBlock: end,
        });
        for (const log of logs) {
          const addr = (log.args.token as string).toLowerCase();
          if (!metadataMap.has(addr)) metadataMap.set(addr, (log.args.metadataURI as string) ?? "");
        }
      } catch {
        break;
      }
      if (start === 0n) break;
      walked += end - start + 1n;
      end = start - 1n;
    }
  } catch {
    /* swallow */
  }

  const rows: TokenRow[] = [];
  for (let i = 0; i < addresses.length; i++) {
    const base = i * 3;
    const stateRes = detailRes[base];
    if (stateRes?.status !== "success") continue;
    const s = stateRes.result as any;
    const name = detailRes[base + 1]?.status === "success" ? (detailRes[base + 1].result as string) : null;
    const symbol = detailRes[base + 2]?.status === "success" ? (detailRes[base + 2].result as string) : null;
    const metadataURI = metadataMap.get(addresses[i].toLowerCase()) ?? "";
    const meta = parseInlineMetadata(metadataURI) ?? null;
    rows.push({
      address: addresses[i],
      name,
      symbol,
      creator: s.creator,
      mode: Number(s.mode),
      createdAt: Number(s.createdAt),
      migrated: !!s.migrated,
      marketCap: null,
      pool: s.v2Pair && s.v2Pair !== "0x0000000000000000000000000000000000000000" ? s.v2Pair : null,
      metadata: meta
        ? {
            image: meta.image,
            description: meta.description,
            twitter: meta.twitter,
            creatorTwitter: meta.creatorTwitter,
            website: meta.website,
            telegram: meta.telegram,
          }
        : null,
      featured: FEATURED_TOKENS.has(addresses[i].toLowerCase()),
    });
  }
  return rows;
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const q = (searchParams.get("q") ?? "").trim().toLowerCase().replace(/^@/, "");
  const modeParam = searchParams.get("mode");
  const featuredOnly = searchParams.get("featured") === "true";
  const creator = searchParams.get("creator");
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "100", 10) || 100, 500);

  try {
    let rows = await getAllTokens();

    if (q) {
      rows = rows.filter((r) => {
        if ((r.name ?? "").toLowerCase().includes(q)) return true;
        if ((r.symbol ?? "").toLowerCase().includes(q)) return true;
        if (r.address.toLowerCase().includes(q)) return true;
        if (r.metadata?.creatorTwitter?.toLowerCase()?.includes(q)) return true;
        return false;
      });
    }

    if (modeParam !== null) {
      const m = parseInt(modeParam, 10);
      if (!isNaN(m)) rows = rows.filter((r) => r.mode === m);
    }

    if (featuredOnly) rows = rows.filter((r) => r.featured);

    if (creator && isAddress(creator)) {
      const c = creator.toLowerCase();
      rows = rows.filter((r) => r.creator.toLowerCase() === c);
    }

    rows.sort((a, b) => b.createdAt - a.createdAt);
    rows = rows.slice(0, limit);

    return NextResponse.json(
      { tokens: rows, total: rows.length },
      {
        headers: {
          "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? "Unknown error" },
      { status: 500 },
    );
  }
}
