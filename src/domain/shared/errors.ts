export abstract class DomainError extends Error {}

export class InvalidMoneyError extends DomainError {
	constructor(public readonly reason: string) {
		super(`Invalid money: ${reason}`);
		this.name = "InvalidMoneyError";
	}
}

export class CurrencyMismatchError extends DomainError {
	constructor(expected: string, actual: string) {
		super(`Currency mismatch: expected ${expected}, got ${actual}`);
		this.name = "CurrencyMismatchError";
	}
}

export class InvalidEntityStateError extends DomainError {
	constructor(detail: string) {
		super(detail);
		this.name = "InvalidEntityStateError";
	}
}

export class InvalidTransactionStateError extends DomainError {
	constructor(detail: string) {
		super(detail);
		this.name = "InvalidTransactionStateError";
	}
}

export class BusinessRuleViolationError extends DomainError {
	constructor(
		public readonly failureCode: string,
		message: string,
	) {
		super(message);
		this.name = "BusinessRuleViolationError";
	}
}
