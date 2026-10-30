import type { FailureCode } from "../domain/wagering/failure-codes";

export class ApplicationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ApplicationError";
	}
}

/** Same idempotency key, different payload — a conflict, never a replay. */
export class IdempotencyConflictError extends ApplicationError {
	constructor(public readonly idempotencyKey: string) {
		super(`idempotency key ${idempotencyKey} already used with a different payload`);
		this.name = "IdempotencyConflictError";
	}
}

/** Structurally invalid input that cannot be persisted as a domain record. */
export class InvalidPayloadError extends ApplicationError {
	constructor(
		public readonly issues: string[],
	) {
		super(issues.join("; "));
		this.name = "InvalidPayloadError";
	}
}

export class WalletAlreadyExistsError extends ApplicationError {
	constructor(
		public readonly playerId: string,
		public readonly currency: string,
	) {
		super(`wallet for player ${playerId} in ${currency} already exists`);
		this.name = "WalletAlreadyExistsError";
	}
}

export class AggregateNotFoundError extends ApplicationError {
	constructor(
		public readonly aggregate: string,
		public readonly id: string,
	) {
		super(`${aggregate} ${id} not found`);
		this.name = "AggregateNotFoundError";
	}
}

export class WagerConversionError extends ApplicationError {
	constructor(public readonly code: FailureCode, message: string) {
		super(message);
		this.name = "WagerConversionError";
	}
}

/** Transient infrastructure failure — caller must retry with backoff. */
export class TransientInfraError extends ApplicationError {
	constructor(
		message: string,
		public readonly underlying?: unknown,
	) {
		super(message);
		if (underlying !== undefined) {
			this.cause = underlying;
		}
		this.name = "TransientInfraError";
	}
}
