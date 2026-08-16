/**
 * In-memory (client SPA session) cache of a freshly-launched token's on-chain
 * metadataURI. The launch page knows the metadataURI it just wrote, so priming
 * this lets the CREATOR see their token's image (a base64 data URI) instantly on
 * the launchpad list -- before the on-chain TokenLaunched scan / the subgraph
 * have indexed the event (~2-3 min).
 *
 * Survives client-side navigation (create -> detail -> launchpad); cleared on a
 * full reload, by which point the indexers have caught up. Client-only; on the
 * server the Map is simply empty. Only helps the launcher's own session -- other
 * viewers still wait on the indexing pipeline.
 */
const fresh = new Map<string, string>();

export function setFreshMeta(address: string, metadataURI: string): void {
    if (address && metadataURI) fresh.set(address.toLowerCase(), metadataURI);
}

export function getFreshMeta(address: string | undefined): string | undefined {
    return address ? fresh.get(address.toLowerCase()) : undefined;
}
