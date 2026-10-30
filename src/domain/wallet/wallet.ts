import { Money, type MoneyProps } from "../shared/money";
import { BusinessRuleViolationError, InvalidEntityStateError } from "../shared/errors";
import { LedgerDirection } from "./ledger-direction";

export interface WalletState {
	id: string;
	playerId: string;
	currency: string;
	balance: MoneyProps;
	version: number;
	createdAt: Date;
	updatedAt: Date;
}

export interface OpenWalletProps {
	id: string;
	playerId: string;
	initialBalance: Money;
}

export interface WalletApplyProps {
	money: Money;
	occurredAt: Date;
}

export interface WalletMutationResult {
	direction: LedgerDirection;
	balanceBefore: Money;
	balanceAfter: Money;
	walletVersion: number;
}

export const WALLET_FAILURE_CODES = {
	INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
	CURRENCY_MISMATCH: "CURRENCY_MISMATCH",
} as const;

export class Wallet {
	private constructor(
		public readonly id: string,
		public readonly playerId: string,
		public readonly currency: string,
		private _balance: Money,
		private _version: number,
		public readonly createdAt: Date,
		private _updatedAt: Date,
	) {}

	static open(props: OpenWalletProps): Wallet {
		const { id, playerId, initialBalance } = props;
		if (initialBalance.isNegative()) {
			throw new InvalidEntityStateError("initial balance must not be negative");
		}
		return new Wallet(
			id,
			playerId,
			initialBalance.currency,
			Money.from(initialBalance.toJSON()),
			1,
			new Date(),
			new Date(),
		);
	}

	static rehydrate(state: WalletState): Wallet {
		return new Wallet(
			state.id,
			state.playerId,
			state.currency,
			Money.from(state.balance),
			state.version,
			state.createdAt,
			state.updatedAt,
		);
	}

	get balance(): Money {
		return this._balance;
	}

	get version(): number {
		return this._version;
	}

	get updatedAt(): Date {
		return this._updatedAt;
	}

	debit(props: WalletApplyProps): WalletMutationResult {
		this.assertOperationCurrency(props.money);
		if (!props.money.isPositive()) {
			throw new InvalidEntityStateError("debit amount must be positive");
		}
		const balanceBefore = this._balance;
		if (balanceBefore.isLessThan(props.money)) {
			throw new BusinessRuleViolationError(
				WALLET_FAILURE_CODES.INSUFFICIENT_BALANCE,
				`wallet ${this.id} balance ${balanceBefore.toString()} is less than ${props.money.toString()}`,
			);
		}
		return {
			direction: LedgerDirection.Debit,
			...this.applyChange(balanceBefore, balanceBefore.subtract(props.money), props.occurredAt),
		};
	}

	credit(props: WalletApplyProps): WalletMutationResult {
		this.assertOperationCurrency(props.money);
		if (!props.money.isPositive()) {
			throw new InvalidEntityStateError("credit amount must be positive");
		}
		const balanceBefore = this._balance;
		return {
			direction: LedgerDirection.Credit,
			...this.applyChange(balanceBefore, balanceBefore.add(props.money), props.occurredAt),
		};
	}

	private applyChange(balanceBefore: Money, balanceAfter: Money, at: Date): Omit<WalletMutationResult, "direction"> {
		this._balance = balanceAfter;
		this._version += 1;
		this._updatedAt = at;
		return { balanceBefore, balanceAfter, walletVersion: this._version };
	}

	private assertOperationCurrency(money: Money): void {
		if (money.currency !== this.currency) {
			throw new BusinessRuleViolationError(
				WALLET_FAILURE_CODES.CURRENCY_MISMATCH,
				`wallet ${this.id} is ${this.currency}, got ${money.currency}`,
			);
		}
	}
}
