"use client";

import { useEffect, useState } from "react";
import { useAccount, useChainId, usePublicClient, useReadContract, useConfig } from "wagmi";
import { erc20Abi, createPublicClient, http } from "viem";
import { arcTestnet } from "@/lib/chains";

const USDC = (process.env.NEXT_PUBLIC_USDC_ADDRESS || "0x36000000000000000000000000000000000000c2") as `0x${string}`;

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
        log(`mount: address=${address ?? "none"} isConnected=${isConnected} chainId=${chainId}`);
    }, []);

    useEffect(() => {
        log(`account changed: address=${address ?? "none"} isConnected=${isConnected} status=${accountStatus} connector=${connector?.name ?? "none"}`);
    }, [address, isConnected, accountStatus, connector]);

    useEffect(() => {
        log(`chainId from wagmi useChainId(): ${chainId} (expect ${arcTestnet.id})`);
    }, [chainId]);

    useEffect(() => {
        log(`balanceQ: status=${balanceQ.status} fetchStatus=${balanceQ.fetchStatus} error=${balanceQ.error?.message ?? "none"} data=${balanceQ.data?.toString() ?? "undefined"}`);
    }, [balanceQ.status, balanceQ.fetchStatus, balanceQ.error, balanceQ.data]);

    useEffect(() => {
        async function diag() {
            // EIP-6963 enum
            const providers: { info: { name: string; uuid: string; rdns: string } }[] = [];
            const handler = (e: Event) => {
                providers.push((e as CustomEvent).detail);
            };
            window.addEventListener("eip6963:announceProvider", handler as EventListener);
            window.dispatchEvent(new Event("eip6963:requestProvider"));
            await new Promise((r) => setTimeout(r, 800));
            window.removeEventListener("eip6963:announceProvider", handler as EventListener);
            setEip6963Providers(providers.map((p) => `${p.info.name} (${p.info.rdns})`));
            log(`EIP-6963 announce: ${providers.length} providers`);

            // Wallet eth_chainId
            if (window.ethereum) {
                try {
                    const cid = await window.ethereum.request({ method: "eth_chainId" });
                    setWalletChainId(String(cid));
                    log(`wallet eth_chainId: ${cid}`);
                } catch (e) {
                    setWalletChainId(`ERROR: ${(e as Error).message}`);
                    log(`wallet eth_chainId FAILED: ${(e as Error).message}`);
                }
            } else {
                setWalletChainId("(no window.ethereum)");
            }

            // Direct Arc RPC
            try {
                const r = await fetch(arcTestnet.rpcUrls.default.http[0], {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
                });
                const j = await r.json();
                setArcDirectResult(`OK block=${j.result}`);
                log(`direct Arc RPC: OK block=${j.result}`);
            } catch (e) {
                setArcDirectResult(`ERROR: ${(e as Error).message}`);
                log(`direct Arc RPC FAILED: ${(e as Error).message}`);
            }

            // Direct mainnet RPC (publicnode)
            try {
                const r = await fetch("https://ethereum-rpc.publicnode.com", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
                });
                const j = await r.json();
                setMainDirectResult(`OK block=${j.result}`);
                log(`direct mainnet RPC: OK block=${j.result}`);
            } catch (e) {
                setMainDirectResult(`ERROR: ${(e as Error).message}`);
                log(`direct mainnet RPC FAILED: ${(e as Error).message}`);
            }

            // Bypass viem client - prove a direct viem call works
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
                    log(`bypass viem balanceOf(${address}): ${bal}`);
                }
            } catch (e) {
                log(`bypass viem FAILED: ${(e as Error).message}`);
            }

            // wagmi publicClient probe
            if (publicClient) {
                try {
                    const block = await publicClient.getBlockNumber();
                    log(`wagmi publicClient getBlockNumber: ${block}`);
                } catch (e) {
                    log(`wagmi publicClient FAILED: ${(e as Error).message}`);
                }
            } else {
                log(`wagmi publicClient: undefined`);
            }
        }
        diag();
    }, [address, publicClient]);

    return (
        <div className="mx-auto max-w-4xl space-y-4 p-6 text-sm font-mono">
            <h1 className="text-2xl font-bold">wagmi debug</h1>

            <section className="rounded border border-arc-border bg-arc-bg-elevated p-4">
                <h2 className="mb-2 text-lg font-semibold">State</h2>
                <div>account address: {address ?? "(none)"}</div>
                <div>account isConnected: {String(isConnected)}</div>
                <div>account status: {accountStatus}</div>
                <div>connector name: {connector?.name ?? "(none)"}</div>
                <div>wagmi useChainId(): {chainId}</div>
                <div>wallet eth_chainId: {walletChainId}</div>
                <div>publicClient defined: {String(!!publicClient)}</div>
                <div>config chains: {config.chains.map((c) => c.id).join(",")}</div>
            </section>

            <section className="rounded border border-arc-border bg-arc-bg-elevated p-4">
                <h2 className="mb-2 text-lg font-semibold">EIP-6963 providers ({eip6963Providers.length})</h2>
                {eip6963Providers.map((p) => <div key={p}>{p}</div>)}
            </section>

            <section className="rounded border border-arc-border bg-arc-bg-elevated p-4">
                <h2 className="mb-2 text-lg font-semibold">Direct RPC probes</h2>
                <div>Arc ({arcTestnet.rpcUrls.default.http[0]}): {arcDirectResult}</div>
                <div>Mainnet (publicnode): {mainDirectResult}</div>
            </section>

            <section className="rounded border border-arc-border bg-arc-bg-elevated p-4">
                <h2 className="mb-2 text-lg font-semibold">wagmi useReadContract USDC.balanceOf({address?.slice(0, 8) ?? "—"}…)</h2>
                <div>status: {balanceQ.status}</div>
                <div>fetchStatus: {balanceQ.fetchStatus}</div>
                <div>isLoading: {String(balanceQ.isLoading)}</div>
                <div>isFetching: {String(balanceQ.isFetching)}</div>
                <div>isError: {String(balanceQ.isError)}</div>
                <div>data: {balanceQ.data?.toString() ?? "(undefined)"}</div>
                <div>error: {balanceQ.error?.message ?? "(none)"}</div>
            </section>

            <section className="rounded border border-arc-border bg-arc-bg-elevated p-4">
                <h2 className="mb-2 text-lg font-semibold">Logs ({logs.length})</h2>
                <pre className="overflow-x-auto whitespace-pre-wrap text-xs">{logs.join("\n")}</pre>
            </section>
        </div>
    );
}
