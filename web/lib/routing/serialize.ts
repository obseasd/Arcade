/**
 * Lossless JSON transport for RouteQuote objects.
 *
 * A quote is pure data (amounts, an ABI, pre-built executor args) but it is
 * riddled with bigints at arbitrary depth: executor.args holds structs, arrays
 * and tuples straight out of the provider, so a shallow conversion would miss
 * them and a naive "every all-digit string becomes a bigint" reviver would
 * corrupt legitimate string args (a token symbol like "123", a decimal string,
 * a bytes value). Bigints are therefore TAGGED on the way out and only tagged
 * values are revived, which is unambiguous in both directions.
 *
 * The tag key is deliberately obscure so it can never collide with a real ABI
 * field name.
 */

const TAG = "$bigint__";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** Deep-convert bigints to `{ $bigint__: "123" }`. Safe on cyclic-free data. */
export function encodeBigints(value: Json): Json {
    if (typeof value === "bigint") return { [TAG]: value.toString() };
    if (Array.isArray(value)) return value.map(encodeBigints);
    if (value && typeof value === "object") {
        const out: Record<string, Json> = {};
        for (const [k, v] of Object.entries(value)) out[k] = encodeBigints(v);
        return out;
    }
    return value;
}

/** Inverse of {@link encodeBigints}. Untagged values pass through untouched. */
export function decodeBigints(value: Json): Json {
    if (Array.isArray(value)) return value.map(decodeBigints);
    if (value && typeof value === "object") {
        const tagged = (value as Record<string, unknown>)[TAG];
        if (typeof tagged === "string" && Object.keys(value).length === 1) {
            try {
                return BigInt(tagged);
            } catch {
                return 0n;
            }
        }
        const out: Record<string, Json> = {};
        for (const [k, v] of Object.entries(value)) out[k] = decodeBigints(v);
        return out;
    }
    return value;
}
