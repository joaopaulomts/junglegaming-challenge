import { IdempotencyConflictError, InvalidPayloadError } from "../../application/errors";
import { InvalidMoneyError } from "../../domain/shared/errors";

/** Squashes a consumer error into a retry class: transient (re-delivery) or permanent (DLQ). */
export function errorClassOf(error: unknown): "transient" | "permanent" {
	const name = error instanceof Error ? error.name : String(error);
	const message = error instanceof Error ? error.message : String(error);
	const record = error as Record<string, unknown>;
	const nested = record?.cause as Record<string, unknown> | undefined;
	const code = (record?.code as string | undefined) ?? (nested?.code as string | undefined);

	const transientCodes = new Set([
		"ECONNREFUSED",
		"ECONNRESET",
		"ENOTFOUND",
		"ETIMEDOUT",
		"EPIPE",
		"EAI_AGAIN",
		"53300", // too many connections
		"08001", // connection exception
		"08006", // connection failure
		"40P01", // deadlock
		"40001", // serialization failure
		"57014", // lock timeout
	]);

	if (code !== undefined && transientCodes.has(code)) return "transient";
	if (/Throttling|ServiceUnavailable|InternalError|RequestTimeout/i.test(name)) return "transient";
	if (/TooManyRequestsException|ServiceFailureException|InternalFailure/i.test(message)) return "transient";
	if (/connection|stream ended|Connection terminated/i.test(message) && !/constraint/i.test(message)) return "transient";

	if (error instanceof IdempotencyConflictError) return "permanent";
	if (error instanceof InvalidMoneyError || error instanceof InvalidPayloadError) return "permanent";

	return "transient";
}
