import Decimal from "decimal.js";
import { CurrencyMismatchError, InvalidMoneyError } from "./errors";

export interface MoneyProps {
	amount: string;
	currency: string;
}

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

const CURRENCY_CODE = /^[A-Z]{3}$/;
const CANONICAL_AMOUNT = /^-?\d+\.\d{2}$/;

export const MAX_AMOUNT = "999999999999.99";

export class Money {
	private constructor(
		private readonly value: Decimal,
		public readonly currency: string,
	) {}

	static from(props: MoneyProps): Money {
		if (typeof props.amount !== "string") {
			throw new InvalidMoneyError("amount must be a decimal string");
		}
		if (typeof props.currency !== "string" || !CURRENCY_CODE.test(props.currency)) {
			throw new InvalidMoneyError(`currency must be an ISO-4217 code, got "${String(props.currency)}"`);
		}
		const amount = props.amount.trim();
		if (amount.length === 0) {
			throw new InvalidMoneyError("amount must not be empty");
		}
		if (!CANONICAL_AMOUNT.test(amount)) {
			throw new InvalidMoneyError(`amount must be a decimal string with exactly 2 fractional digits, got "${props.amount}"`);
		}
		const value = new Decimal(amount);
		if (!value.isFinite()) {
			throw new InvalidMoneyError(`amount must be finite, got "${props.amount}"`);
		}
		if (value.abs().greaterThan(MAX_AMOUNT)) {
			throw new InvalidMoneyError(`amount exceeds maximum ${MAX_AMOUNT}, got "${props.amount}"`);
		}
		if (value.isNegative()) {
			throw new InvalidMoneyError(`amount must not be negative in an input contract, got "${props.amount}"`);
		}
		return new Money(value, props.currency);
	}

	static zero(currency: string): Money {
		return Money.from({ amount: "0.00", currency });
	}

	isZero(): boolean {
		return this.value.isZero();
	}

	isPositive(): boolean {
		return this.value.isPositive() && !this.value.isZero();
	}

	isNegative(): boolean {
		return this.value.isNegative() && !this.value.isZero();
	}

	add(other: Money): Money {
		this.assertSameCurrency(other);
		return new Money(this.value.plus(other.value), this.currency);
	}

	subtract(other: Money): Money {
		this.assertSameCurrency(other);
		return new Money(this.value.minus(other.value), this.currency);
	}

	negate(): Money {
		return new Money(this.value.negated(), this.currency);
	}

	isLessThan(other: Money): boolean {
		this.assertSameCurrency(other);
		return this.value.lessThan(other.value);
	}

	equals(other: Money): boolean {
		if (this.currency !== other.currency) return false;
		return this.value.eq(other.value);
	}

	toJSON(): MoneyProps {
		return { amount: this.value.toFixed(2), currency: this.currency };
	}

	toString(): string {
		return `${this.value.toFixed(2)} ${this.currency}`;
	}

	private assertSameCurrency(other: Money): void {
		if (this.currency !== other.currency) {
			throw new CurrencyMismatchError(this.currency, other.currency);
		}
	}
}
