# Arc mainnet switch runbook

Goal: make the testnet to mainnet cutover a few mechanical steps, not a code
project. The app is wired for a SOFT SWITCH driven by one env var plus the
address envs. This supersedes the chain/RPC/CCTP parts of `MAINNET_CHECKLIST.md`.

## Known Arc mainnet values (verified on-chain 2026-07-17 / -2x)

| Item | Value |
|---|---|
| chainId | `5042` (0x13b2) |
| Native gas / USDC | `0x3600000000000000000000000000000000000000` (symbol "USDC", 6 dec, SAME as testnet) |
| Default RPC | `https://5042.rpc.thirdweb.com` (override with `NEXT_PUBLIC_ARC_MAINNET_RPC_URL`) |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` (canonical, deployed) |
| Block explorer | UNKNOWN yet (arcscan.app / explorer.arc.network do not resolve for mainnet). Set `NEXT_PUBLIC_ARC_MAINNET_EXPLORER_URL` when it exists; empty is handled gracefully. |
| CCTP V2 domain | `26` (read off MessageTransmitter.localDomain()) |
| CCTP TokenMessenger | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` |
| CCTP MessageTransmitter | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` |
| Iris attestation host | `https://iris-api.circle.com` |

All of the above are ALREADY in the code (`web/lib/cctp.ts`, `web/lib/chains.ts`),
gated so they stay inert until the switch.

## How the soft switch works

- `lib/chains.ts` exports `arcActive`, selected by `NEXT_PUBLIC_ARC_ENV`. The name
  `arcTestnet` is an alias of `arcActive`, so all ~24 call sites (wagmi, guards,
  clients, explorer links) move on one env flip with no code change.
- The keeper (`app/api/keeper/cron/route.ts`) reads the same var for its chain +
  RPCs.
- CCTP moves on `NEXT_PUBLIC_CCTP_NETWORK=mainnet`.
- All contract addresses already resolve from `NEXT_PUBLIC_*` envs (see
  `lib/constants.ts`), so re-pointing them to the mainnet generation is env-only.

## Decision B outcome (baked)

- H-02 escrow withdrawal timelock: NO (kept 0). Instant-claim UX prioritised for
  creator attraction; revisit if abuse appears.
- H-02 bis escrow signer 2-of-N: NO for launch. Instead run the mainnet claim
  signer from a KMS (key never in cleartext), which removes the "compromised key"
  class without the 2-of-N contract complexity. 2-of-N stays a v2 option.

## Switch procedure (the actual cutover)

1. DEPLOY THE MAINNET GENERATION (deployer key, chain 5042)
   - Broadcast the current Safe-governed gen with mainnet params
     (`TREASURY_ADDRESS`=Safe, USDC=`0x3600...`). Existing testnet positions are
     not migratable; nothing is carried over.
   - From the Safe: `acceptOwnership()` on the escrow (2-of-3).
   - Record every deployed address (they land in the broadcast + should be
     written into `web/public/deployments.json` under a mainnet section).

2. SET VERCEL ENVS (Production) - the `.env.mainnet` template below
   - `NEXT_PUBLIC_ARC_ENV=mainnet` (the master switch)
   - `NEXT_PUBLIC_CCTP_NETWORK=mainnet`
   - Every `NEXT_PUBLIC_*_ADDRESS` re-pointed to the mainnet gen address.
   - Optionally `NEXT_PUBLIC_ARC_MAINNET_RPC_URL` (a dedicated Canteen/paid RPC)
     and `NEXT_PUBLIC_ARC_MAINNET_EXPLORER_URL` once known.
   - The keeper: same `NEXT_PUBLIC_ARC_ENV` + point `NEXT_PUBLIC_ARC_RPC_URL` at a
     mainnet dedicated RPC; the keeper wallet must hold mainnet USDC for gas.
   - Signer/secret envs (KEEPER_OPERATOR_PRIVATE_KEY, the escrow signer via KMS,
     REFERRAL_PAYOUT_PRIVATE_KEY, CRON secrets) are environment-independent but
     should be FRESH mainnet keys, not the testnet ones.

3. REDEPLOY THE FRONTEND (Vercel) so the NEXT_PUBLIC_* bake in.

4. DEPLOY THE MAINNET SUBGRAPH
   - Take `subgraph/subgraph.yaml`, change `network: arc-testnet` -> `arc-mainnet`
     on every data source, replace each `address:` with the mainnet gen address,
     and set each `startBlock:` to the mainnet deploy block (or the gen's first
     block). USDC stays `0x3600...`.
   - `npm run codegen && npm run build && goldsky subgraph deploy arcade-charts/<mainnet-version> --path .`
   - Wait Synced 100%, then point `NEXT_PUBLIC_GOLDSKY_URL` at that subgraph's
     endpoint (a separate mainnet subgraph, not the `prod` testnet tag).

5. SEED LIQUIDITY with real mainnet USDC (V2/V3 pools for the base pairs).

6. VERIFY CCTP ACTUALLY ATTESTS ON ARC MAINNET (the one external unknown): do a
   small real burn to Arc and confirm `iris-api.circle.com` returns an
   attestation. If Circle does not yet attest Arc mainnet burns, the Bridge leg
   stays "waiting for attestation" - launch the rest and gate Bridge on it.

## What is genuinely irreducible at cutover (cannot pre-do)

- The gen broadcast + Safe acceptOwnership.
- Filling the mainnet addresses into the envs + `deployments.json`.
- Seeding liquidity.
- Confirming CCTP attestation (external, Circle).
- The mainnet block explorer URL (does not exist yet).
- The external audit sign-off (the hard gate; start it early, it is calendar time).

## Still to prepare (optional hardening, do anytime before switch)

- Move the escrow claim signer to a KMS (Decision B).
- Rotate WalletConnect Project ID for the mainnet domain.
- USYC /earn: rebuild once the treasury is KYC-approved by Hashnote/Circle.
