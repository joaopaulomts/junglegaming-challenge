import { createHash } from "node:crypto";

/**
 * Canonical JSON: object keys are recursively sorted lexicographically, arrays keep
 * their order, only the value's own business namespace is hashed. Numbers are not
 * produced by this function (money amounts are decimal strings, dates ISO strings),
 * so the encoding has no float surprises.
 *
 * Algorithm: sha256(canonicalJson(businessSubset)) — transport metadata and headers
 * are excluded by construction, the caller passes only the business subset.
 */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(sortValue);
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return Object.fromEntries(entries.map(([k, v]) => [k, sortValue(v)]));
}

export function sha256Hex(canonical: string): string {
	return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function payloadHashOf(businessSubset: Record<string, unknown>): string {
	return sha256Hex(canonicalJson(businessSubset));
}
