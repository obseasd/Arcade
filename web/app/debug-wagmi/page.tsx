"use client";

import { useEffect, useState } from "react";
import { useAccount, useChainId, usePublicClient, useReadContract, useConfig } from "wagmi";
import { erc20Abi, createPublicClient, http, encodeFunctionData } from "viem";
import { arcTestnet } from "@/lib/chains";

const USDC = (process.env.NEXT_PUBLIC_USDC_ADDRESS || "0x3600000000000000000000000000000000000000") as `0x${string}`;
const ARC_RPC = arcTestnet.rpcUrls.default.http[0];

// Install fetch interceptor BEFORE wagmi mounts so we catch every eth_call.
// We log only requests to the Arc RPC to keep the noise down.
const rpcLog: Array<{ time: string; body: string; resp: string }> = [];
let interceptorInstalled = false;
function installInterceptor() {
    if (interceptorInstalled || typeof window === "undefined") return;
    interceptorInstalled = true;
    const origFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const isArc = url.includes("arc.network") || url.includes("rpc.testnet.arc");
        let bodyStr = "";
        if (isArc && init?.body) {
            try {
                bodyStr = typeof init.body === "string" ? init.body : "[non-string body]";
            } catch {
                bodyStr = "[unreadable]";
            }
        }
        const r = await origFetch(input, init);
        if (isArc && bodyStr) {
            try {
                const cloned = r.clone();
                const txt = await cloned.text();
                const t = new Date().toISOString().split("T")[1].slice(0, 12);
                rpcLog.push({
                    time: t,
                    body: bodyStr.slice(0, 500),
                    resp: txt.slice(0, 500),
                });
            } catch {}
        }
        return r;
    };
}
if (typeof window !== "undefined") installInterceptor();

export default function DebugWagmiPage() {
    const { address, isConnected, status: accountStatus, connector } = useAccount();
    const chainId = useChainId();
    const publicClient = usePublicClient();
    const config = useConfig();
    const [logs, setLogs] = useState<string[]>([]);
    const [arcDirectResult, setArcDirectResult] = useState<string>("(not yet)");
    const [mainDirectResult, setMainDirectResult] = useState<string>("(not yet)");
    const [walletChainId, setWalletChainId] = useState<string>("(not yet)");
    const [eip6963Providers, setEip6963Providers] = useState<string[]>([]);
    const [pcReadContractResult, setPcReadContractResult] = useState<string>("(not yet)");
    const [pcEthCallResult, setPcEthCallResult] = useState<string>("(not yet)");
    const [rpcCalls, setRpcCalls] = useState<typeof rpcLog>([]);

    const log = (msg: string) => {
        const t = new Date().toISOString().split("T")[1].slice(0, 12);
        setLogs((prev) => [...prev, `${t}  ${msg}`]);
    };

    const balanceQ = useReadContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: address ? [address] : undefined,
        query: { enabled: !!address },
    });

    useEffect(() => {
        log(`mount: addr=${address ?? "none"} connected=${isConnected} chain=${chainId} USDC=${USDC}`);
    }, []);

    useEffect(() => {
        log(`account: addr=${address ?? "none"} connected=${isConnected} status=${accountStatus} connector=${connector?.name ?? "none"}`);
    }, [address, isConnected, accountStatus, connector]);

    useEffect(() => {
        log(`balanceQ: status=${balanceQ.status} fetchStatus=${balanceQ.fetchStatus} error=${(balanceQ.error?.message ?? "none").slice(0, 200)} data=${balanceQ.data?.toString() ?? "undefined"}`);
    }, [balanceQ.status, balanceQ.fetchStatus, balanceQ.error, balanceQ.data]);

    useEffect(() => {
        const id = setInterval(() => setRpcCalls([...rpcLog]), 1000);
        return () => clearInterval(id);
    }, []);

    useEffect(() => {
        async function diag() {
            const providers: { info: { name: string; uuid: string; rdns: string } }[] = [];
            const handler = (e: Event) => {
                providers.push((e as CustomEvent).detail);
            };
            window.addEventListener("eip6963:announceProvider", handler as EventListener);
            window.dispatchEvent(new Event("eip6963:requestProvider"));
            await new Promise((r) => setTimeout(r, 800));
            window.removeEventListener("eip6963:announceProvider", handler as EventListener);
            setEip6963Providers(providers.map((p) => `${p.info.name} (${p.info.rdns})`));

            if (window.ethereum) {
                try {
                    const cid = await window.ethereum.request({ method: "eth_chainId" });
                    setWalletChainId(String(cid));
                } catch (e) {
                    setWalletChainId(`ERROR: ${(e as Error).message}`);
                }
            }

            try {
                const r = await fetch(ARC_RPC, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
                });
                const j = await r.json();
                setArcDirectResult(`OK block=${j.result}`);
            } catch (e) {
                setArcDirectResult(`ERROR: ${(e as Error).message}`);
            }

            try {
                const r = await fetch("https://ethereum-rpc.publicnode.com", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
                });
                const j = await r.json();
                setMainDirectResult(`OK block=${j.result}`);
            } catch (e) {
                setMainDirectResult(`ERROR: ${(e as Error).message}`);
            }

            try {
                const c = createPublicClient({ chain: arcTestnet, transport: http() });
                const block = await c.getBlockNumber();
                log(`bypass viem getBlockNumber: ${block}`);
                if (address) {
                    const bal = await c.readContract({
                        address: USDC,
                        abi: erc20Abi,
                        functionName: "balanceOf",
                        args: [address],
                    });
                    log(`bypass viem balanceOf: ${bal} on USDC=${USDC}`);
                }
            } catch (e) {
                log(`bypass viem FAILED: ${(e as Error).message}`);
            }

            if (publicClient) {
                try {
                    const block = await publicClient.getBlockNumber();
                    log(`wagmi publicClient getBlockNumber: ${block}`);
                } catch (e) {
                    log(`wagmi publicClient getBlockNumber FAILED: ${(e as Error).message}`);
                }
                // Try the same readContract through wagmi's publicClient
                if (address) {
                    try {
                        const bal = await publicClient.readContract({
                            address: USDC,
                            abi: erc20Abi,
                            functionName: "balanceOf",
                            args: [address],
                        });
                        setPcReadContractResult(`OK ${bal}`);
                        log(`wagmi publicClient.readContract balanceOf: ${bal}`);
                    } catch (e) {
                        setPcReadContractResult(`ERROR: ${(e as Error).message.slice(0, 200)}`);
                        log(`wagmi publicClient.readContract FAILED: ${(e as Error).message.slice(0, 200)}`);
                    }
                    // Also try raw eth_call through publicClient
                    try {
                        const data = encodeFunctionData({
                            abi: erc20Abi,
                            functionName: "balanceOf",
                            args: [address],
                        });
                        const res = await publicClient.call({ to: USDC, data });
                        setPcEthCallResult(`OK ${res.data}`);
                        log(`wagmi publicClient.call raw eth_call: ${res.data}`);
                    } catch (e) {
                        setPcEthCallResult(`ERROR: ${(e as Error).message.slice(0, 200)}`);
                        log(`wagmi publicClient.call FAILED: ${(e as Error).message.slice(0, 200)}`);
                    }
                }
            }
        }
        diag();
    }, [address, publicClient]);

    return (
        <div className="mx-auto max-w-5xl space-y-4 p-6 text-sm font-mono">
            <h1 className="text-2xl font-bold">wagmi debug</h1>

            <section className="rounded border border-arc-border bg-arc-bg-elevated p-4">
                <h2 className="mb-2 text-lg font-semibold">State</h2>
                <div>USDC constant: {USDC}</div>
                <div>USDC env raw: {String(process.env.NEXT_PUBLIC_USDC_ADDRESS)}</div>
                <div>account address: {address ?? "(none)"}</div>
                <div>account isConnected: {String(isConnected)}</div>
                <div>account status: {accountStatus}</div>
                <div>connector name: {connector?.name ?? "(none)"}</div>
                <div>wagmi useChainId(): {chainId}</div>
                <div>wallet eth_chainId: {walletChainId}</div>
                <div>publicClient defined: {String(!!publicClient)}</div>
                <div>publicClient chain: {publicClient?.chain?.id}</div>
                <div>config chains: {config.chains.map((c) => c.id).join(",")}</div>
            </section>

            <section className="rounded border border-arc-border bg-arc-bg-elevated p-4">
                <h2 className="mb-2 text-lg font-semibold">EIP-6963 providers ({eip6963Providers.length})</h2>
                {eip6963Providers.map((p) => <div key={p}>{p}</div>)}
            </section>

            <section className="rounded border border-arc-border bg-arc-bg-elevated p-4">
                <h2 className="mb-2 text-lg font-semibold">Direct RPC probes</h2>
                <div>Arc fetch: {arcDirectResult}</div>
                <div>Mainnet fetch: {mainDirectResult}</div>
            </section>

            <section className="rounded border border-arc-border bg-arc-bg-elevated p-4">
                <h2 className="mb-2 text-lg font-semibold">wagmi publicClient (via usePublicClient)</h2>
                <div>publicClient.readContract balanceOf: {pcReadContractResult}</div>
                <div>publicClient.call raw eth_call: {pcEthCallResult}</div>
            </section>

            <section className="rounded border border-arc-border bg-arc-bg-elevated p-4">
                <h2 className="mb-2 text-lg font-semibold">wagmi useReadContract USDC.balanceOf</h2>
                <div>status: {balanceQ.status}</div>
                <div>fetchStatus: {balanceQ.fetchStatus}</div>
                <div>isLoading: {String(balanceQ.isLoading)}</div>
                <div>isFetching: {String(balanceQ.isFetching)}</div>
                <div>isError: {String(balanceQ.isError)}</div>
                <div>data: {balanceQ.data?.toString() ?? "(undefined)"}</div>
                <div className="break-all">error: {balanceQ.error?.message ?? "(none)"}</div>
            </section>

            <section className="rounded border border-arc-border bg-arc-bg-elevated p-4">
                <h2 className="mb-2 text-lg font-semibold">Intercepted RPC calls to Arc ({rpcCalls.length})</h2>
                <div className="space-y-2">
                    {rpcCalls.map((c, i) => (
                        <div key={i} className="rounded bg-arc-bg p-2 text-xs">
                            <div className="text-arc-text-muted">{c.time}</div>
                            <div className="break-all">→ {c.body}</div>
                            <div className="break-all text-arc-text-muted">← {c.resp}</div>
                        </div>
                    ))}
                </div>
            </section>

            <section className="rounded border border-arc-border bg-arc-bg-elevated p-4">
                <h2 className="mb-2 text-lg font-semibold">Logs ({logs.length})</h2>
                <pre className="overflow-x-auto whitespace-pre-wrap text-xs">{logs.join("\n")}</pre>
            </section>
        </div>
    );
}
