import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

/**
 * Thin wrapper around @neondatabase/serverless that fails soft when the
 * database is not provisioned. The /stats page must keep rendering even
 * on a fresh deploy where DATABASE_URL has not been set yet, so callers
 * always guard with isDbConfigured() and gracefully fall back to the
 * live RPC scan path.
 *
 * Naming convention: Neon's Vercel integration injects DATABASE_URL
 * (pooled connection through pgbouncer). The legacy POSTGRES_URL name
 * used by the deprecated @vercel/postgres SDK is checked as a fallback
 * so an older env-var naming still works without manual rewiring.
 *
 * Lock-step contract with statsPersistence.ts: this file is the ONLY
 * place that touches the Neon driver directly. Every other module
 * imports the typed helpers there so the DB can be swapped (Neon
 * direct, Supabase, raw pg) without rippling through the codebase.
 */

function resolveConnectionString(): string | null {
    const fromNeon = process.env.DATABASE_URL;
    if (fromNeon && fromNeon.length > 0) return fromNeon;
    const legacy = process.env.POSTGRES_URL;
    if (legacy && legacy.length > 0) return legacy;
    return null;
}

export function isDbConfigured(): boolean {
    return resolveConnectionString() !== null;
}

// Lazily build a sql() per process. neon() opens an HTTP connection
// pool keyed on the URL so re-creating it on every request would waste
// the pgbouncer-side keep-alive. We cache on the module scope; Vercel
// reuses the function instance across warm invocations.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedSql: NeonQueryFunction<any, any> | null = null;

/** Returns a typed `sql` tagged-template function. Throws when the DB
 *  is not configured, so callers MUST guard with isDbConfigured() to
 *  honour the soft-fail contract documented above. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getSql(): NeonQueryFunction<any, any> {
    if (cachedSql) return cachedSql;
    const url = resolveConnectionString();
    if (!url) {
        throw new Error(
            "DATABASE_URL not configured. Attach Neon (Vercel Storage → Neon) or set the env var manually.",
        );
    }
    cachedSql = neon(url);
    return cachedSql;
}
