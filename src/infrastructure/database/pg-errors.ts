interface UniqueViolationShape {
	code?: string | undefined;
	constraint?: string | undefined;
}

/**
 * Extracts a Postgres constraint name out of any thrown error shaped like a
 * `unique_violation` (23505) — a driver error, nested error or plain object
 * may carry it depending on where the throw surfaced.
 */
export function uniqueViolatorOf(error: unknown): string | null {
	if (error === null || typeof error !== "object") return null;
	const direct = error as UniqueViolationShape;
	if (direct.code === "23505" && typeof direct.constraint === "string") return direct.constraint;
	for (const key of ["cause", "driverError", "originalError", "error"]) {
		const nested = uniqueViolatorOf((direct as unknown as Record<string, unknown>)[key]);
		if (nested !== null) return nested;
	}
	return null;
}
