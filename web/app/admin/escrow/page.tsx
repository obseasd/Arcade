"use client";

import { ArrowLeft, Pause, Play, RefreshCw, Shield } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Address, isAddress, parseUnits, zeroAddress } from "viem";
import { useAccount, useReadContract, useWriteContract } from "wagmi";

import { ADDRESSES, USDC_DECIMALS } from "@/lib/constants";
import { pushToast } from "@/lib/toast";
import { formatAddress, formatUSDC } from "@/lib/utils";

/**
 * Owner-only admin panel for ArcadeTwitterEscrowV4 (the CURRENT escrow the V4
 * hook credits). Rewritten 2026-07-21 for the V4 surface: the previous page was
 * written against ArcadeTwitterEscrowV3 (locker rotation, dual paired/clanker
 * slots, V3 PendingClaim shape) and every write reverted against the deployed V4
 * contract. V4 has no locker rotation (the hook credits the escrow directly).
 *
 * Gated client-side against escrow.owner(); the contract enforces onlyOwner on
 * every write, so a wallet spoof only sees data already public via cast call.
 */

const ESCROW_V4_ADMIN_ABI = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "trustedSigner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "pendingSigner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "pendingSignerAfter", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "claimTimelock", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  {
    type: "function", name: "balances", stateMutability: "view",
    inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "address" }], outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "setCrediter", stateMutability: "nonpayable",
    inputs: [{ name: "crediter", type: "address" }, { name: "allowed", type: "bool" }], outputs: [],
  },
  {
    type: "function", name: "setClaimTimelock", stateMutability: "nonpayable",
    inputs: [{ name: "newTimelock", type: "uint64" }], outputs: [],
  },
  {
    type: "function", name: "startSignerRotation", stateMutability: "nonpayable",
    inputs: [{ name: "next", type: "address" }], outputs: [],
  },
  { type: "function", name: "finalizeSignerRotation", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "cancelSignerRotation", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "pause", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "unpause", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "veto", stateMutability: "nonpayable", inputs: [{ name: "nonce", type: "bytes32" }], outputs: [] },
  {
    type: "function", name: "forfeitStaleClaim", stateMutability: "nonpayable",
    inputs: [{ name: "positionId", type: "uint256" }, { name: "slotIndex", type: "uint256" }, { name: "to", type: "address" }], outputs: [],
  },
  {
    type: "function", name: "rescue", stateMutability: "nonpayable",
    inputs: [{ name: "token", type: "address" }, { name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [],
  },
] as const;

function Card({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="arc-card space-y-3 p-5">
      <div className="flex items-center gap-2 text-sm font-medium text-arc-text">
        {icon}
        {title}
      </div>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="text-arc-text-muted">{label}</span>
      <span className="font-mono text-arc-text">{value}</span>
    </div>
  );
}

export default function EscrowAdminPage() {
  const { address: account } = useAccount();
  const escrow = ADDRESSES.twitterEscrow;
  const configured = !!escrow && escrow !== zeroAddress;
  const { writeContractAsync } = useWriteContract();
  const [busy, setBusy] = useState<string | null>(null);

  const base = {
    address: (configured ? escrow : undefined) as Address | undefined,
    abi: ESCROW_V4_ADMIN_ABI,
    query: { enabled: configured, refetchInterval: 30_000 },
  } as const;
  const ownerQ = useReadContract({ ...base, functionName: "owner" });
  const pausedQ = useReadContract({ ...base, functionName: "paused" });
  const signerQ = useReadContract({ ...base, functionName: "trustedSigner" });
  const pendingSignerQ = useReadContract({ ...base, functionName: "pendingSigner" });
  const pendingAfterQ = useReadContract({ ...base, functionName: "pendingSignerAfter" });
  const timelockQ = useReadContract({ ...base, functionName: "claimTimelock" });

  const owner = ownerQ.data as Address | undefined;
  const isOwner = !!account && !!owner && account.toLowerCase() === owner.toLowerCase();
  const paused = pausedQ.data as boolean | undefined;
  const pendingSigner = pendingSignerQ.data as Address | undefined;
  const pendingAfter = pendingAfterQ.data as bigint | undefined;

  const [crediterAddr, setCrediterAddr] = useState("");
  const [crediterAllowed, setCrediterAllowed] = useState(true);
  const [timelockSecs, setTimelockSecs] = useState("");
  const [nextSigner, setNextSigner] = useState("");
  const [vetoNonce, setVetoNonce] = useState("");
  const [forfeitPos, setForfeitPos] = useState("");
  const [forfeitSlot, setForfeitSlot] = useState("0");
  const [forfeitTo, setForfeitTo] = useState("");
  const [rescueToken, setRescueToken] = useState("");
  const [rescueTo, setRescueTo] = useState("");
  const [rescueAmt, setRescueAmt] = useState("");
  const [lookupPos, setLookupPos] = useState("");
  const [lookupSlot, setLookupSlot] = useState("0");
  const [lookupToken, setLookupToken] = useState<string>(ADDRESSES.usdc ?? "");
  const [lookupArgs, setLookupArgs] = useState<readonly [bigint, bigint, Address] | undefined>();
  const balanceQ = useReadContract({
    address: configured && lookupArgs ? escrow : undefined,
    abi: ESCROW_V4_ADMIN_ABI,
    functionName: "balances",
    args: lookupArgs,
    query: { enabled: !!lookupArgs && configured },
  });

  async function run(label: string, fn: string, args: readonly unknown[]) {
    if (!configured) return;
    setBusy(label);
    try {
      await writeContractAsync({ address: escrow, abi: ESCROW_V4_ADMIN_ABI, functionName: fn as never, args: args as never });
      pushToast({ kind: "info", title: `${label} submitted` });
    } catch (e) {
      pushToast({ kind: "error", title: `${label} failed`, message: e instanceof Error ? e.message.slice(0, 160) : "" });
    } finally {
      setBusy(null);
    }
  }

  const input = "w-full rounded-lg border border-arc-border bg-arc-bg-elevated px-3 py-2 text-xs font-mono text-arc-text";
  const btn = "rounded-lg bg-arc-cta px-3 py-2 text-xs font-semibold text-arc-bg hover:bg-arc-cta-hover disabled:opacity-50";

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <Link href="/admin" className="inline-flex items-center gap-1 text-xs text-arc-text-muted hover:text-arc-text">
        <ArrowLeft className="h-3.5 w-3.5" /> Admin
      </Link>
      <h1 className="mt-3 flex items-center gap-2 text-2xl font-semibold">
        <Shield className="h-5 w-5" /> Twitter escrow (V4) admin
      </h1>

      {!configured ? (
        <div className="mt-6 rounded-xl bg-arc-warn/10 p-4 text-sm text-arc-warn">Escrow address not configured.</div>
      ) : (
        <>
          {!isOwner && (
            <div className="mt-4 rounded-xl bg-arc-warn/10 p-3 text-xs text-arc-warn">
              Connected wallet is not the escrow owner. Writes will revert on-chain; reads are public.
            </div>
          )}

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <Card title="Status" icon={<RefreshCw className="h-4 w-4" />}>
              <Row label="Escrow" value={<a className="hover:text-arc-cta-hover" href={`https://testnet.arcscan.app/address/${escrow}`} target="_blank" rel="noreferrer">{formatAddress(escrow)}</a>} />
              <Row label="Owner" value={owner ? formatAddress(owner) : "…"} />
              <Row label="Trusted signer" value={signerQ.data ? formatAddress(signerQ.data as Address) : "…"} />
              <Row label="Claim timelock" value={timelockQ.data !== undefined ? `${Number(timelockQ.data)}s` : "…"} />
              <Row label="Paused" value={paused === undefined ? "…" : paused ? "YES" : "no"} />
              <Row label="Pending signer" value={pendingSigner && pendingSigner !== zeroAddress ? formatAddress(pendingSigner) : "none"} />
              {pendingSigner && pendingSigner !== zeroAddress && pendingAfter !== undefined && (
                <Row label="Rotation eta" value={new Date(Number(pendingAfter) * 1000).toLocaleString()} />
              )}
            </Card>

            <Card title="Pause" icon={paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}>
              <p className="text-xs text-arc-text-muted">Pausing blocks authorize/claim (crediting stays open by design).</p>
              <button className={btn} disabled={!!busy} onClick={() => run(paused ? "Unpause" : "Pause", paused ? "unpause" : "pause", [])}>
                {paused ? "Unpause" : "Pause"}
              </button>
            </Card>

            <Card title="Crediter allowlist">
              <p className="text-xs text-arc-text-muted">Allow/disallow an address (hook, operator) to credit slots.</p>
              <input className={input} placeholder="0x crediter" value={crediterAddr} onChange={(e) => setCrediterAddr(e.target.value)} />
              <label className="flex items-center gap-2 text-xs text-arc-text-muted">
                <input type="checkbox" checked={crediterAllowed} onChange={(e) => setCrediterAllowed(e.target.checked)} /> allowed
              </label>
              <button className={btn} disabled={!!busy || !isAddress(crediterAddr)}
                onClick={() => run("setCrediter", "setCrediter", [crediterAddr as Address, crediterAllowed])}>
                Set crediter
              </button>
            </Card>

            <Card title="Claim timelock">
              <p className="text-xs text-arc-text-muted">Seconds a claim waits between authorize and sweep (max 7 days).</p>
              <input className={input} placeholder="seconds (0 = instant)" value={timelockSecs} onChange={(e) => setTimelockSecs(e.target.value)} />
              <button className={btn} disabled={!!busy || timelockSecs === "" || Number.isNaN(Number(timelockSecs))}
                onClick={() => run("setClaimTimelock", "setClaimTimelock", [BigInt(timelockSecs || "0")])}>
                Set timelock
              </button>
            </Card>

            <Card title="Signer rotation (24h)">
              <p className="text-xs text-arc-text-muted">2-step: start, wait 24h, finalize. Cancel anytime before.</p>
              <input className={input} placeholder="0x next signer" value={nextSigner} onChange={(e) => setNextSigner(e.target.value)} />
              <div className="flex flex-wrap gap-2">
                <button className={btn} disabled={!!busy || !isAddress(nextSigner)} onClick={() => run("startSignerRotation", "startSignerRotation", [nextSigner as Address])}>Start</button>
                <button className={btn} disabled={!!busy} onClick={() => run("finalizeSignerRotation", "finalizeSignerRotation", [])}>Finalize</button>
                <button className={btn} disabled={!!busy} onClick={() => run("cancelSignerRotation", "cancelSignerRotation", [])}>Cancel</button>
              </div>
            </Card>

            <Card title="Slot balance lookup">
              <p className="text-xs text-arc-text-muted">Read balances(positionId, slot, token). positionId = uint256(poolId).</p>
              <input className={input} placeholder="positionId (decimal)" value={lookupPos} onChange={(e) => setLookupPos(e.target.value)} />
              <div className="flex gap-2">
                <input className={input} placeholder="slot (0/1)" value={lookupSlot} onChange={(e) => setLookupSlot(e.target.value)} />
                <input className={input} placeholder="token (USDC)" value={lookupToken} onChange={(e) => setLookupToken(e.target.value)} />
              </div>
              <button className={btn} disabled={!lookupPos || !isAddress(lookupToken)}
                onClick={() => setLookupArgs([BigInt(lookupPos), BigInt(lookupSlot || "0"), lookupToken as Address])}>
                Read balance
              </button>
              {balanceQ.data !== undefined && (
                <Row label="Balance" value={`${formatUSDC(balanceQ.data as bigint, USDC_DECIMALS)} (raw ${(balanceQ.data as bigint).toString()})`} />
              )}
            </Card>

            <Card title="Veto a pending claim">
              <p className="text-xs text-arc-text-muted">Cancel a committed claim by its nonce (bytes32).</p>
              <input className={input} placeholder="0x… nonce" value={vetoNonce} onChange={(e) => setVetoNonce(e.target.value)} />
              <button className={btn} disabled={!!busy || !/^0x[0-9a-fA-F]{64}$/.test(vetoNonce)}
                onClick={() => run("veto", "veto", [vetoNonce as `0x${string}`])}>Veto</button>
            </Card>

            <Card title="Forfeit stale slot (180d)">
              <p className="text-xs text-arc-text-muted">Reclaim an unclaimed slot after the forfeit delay.</p>
              <input className={input} placeholder="positionId" value={forfeitPos} onChange={(e) => setForfeitPos(e.target.value)} />
              <div className="flex gap-2">
                <input className={input} placeholder="slot" value={forfeitSlot} onChange={(e) => setForfeitSlot(e.target.value)} />
                <input className={input} placeholder="0x to" value={forfeitTo} onChange={(e) => setForfeitTo(e.target.value)} />
              </div>
              <button className={btn} disabled={!!busy || !forfeitPos || !isAddress(forfeitTo)}
                onClick={() => run("forfeitStaleClaim", "forfeitStaleClaim", [BigInt(forfeitPos), BigInt(forfeitSlot || "0"), forfeitTo as Address])}>
                Forfeit
              </button>
            </Card>

            <Card title="Rescue tokens">
              <p className="text-xs text-arc-text-muted">Sweep un-earmarked tokens (cannot touch credited/pending balances).</p>
              <input className={input} placeholder="0x token" value={rescueToken} onChange={(e) => setRescueToken(e.target.value)} />
              <div className="flex gap-2">
                <input className={input} placeholder="0x to" value={rescueTo} onChange={(e) => setRescueTo(e.target.value)} />
                <input className={input} placeholder="amount (USDC dp)" value={rescueAmt} onChange={(e) => setRescueAmt(e.target.value)} />
              </div>
              <button className={btn} disabled={!!busy || !isAddress(rescueToken) || !isAddress(rescueTo) || !rescueAmt}
                onClick={() => run("rescue", "rescue", [rescueToken as Address, rescueTo as Address, parseUnits(rescueAmt || "0", USDC_DECIMALS)])}>
                Rescue
              </button>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
