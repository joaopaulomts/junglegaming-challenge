import { Money, type MoneyProps } from "../shared/money";
import { InvalidEntityStateError } from "../shared/errors";
import { LedgerDirection } from "./ledger-direction";

export interface LedgerEntryState {
	id: string;
	walletId: string;
	transactionId: string;
	direction: LedgerDirection;
	money: MoneyProps;
	balanceBefore: MoneyProps;
	balanceAfter: MoneyProps;
	createdAt: Date;
}

export interface CreateLedgerEntryProps {
	id: string;
	walletId: string;
	transactionId: string;
	direction: LedgerDirection;
	money: Money;
	balanceBefore: Money;
	balanceAfter: Money;
	createdAt: Date;
}

export class WalletLedgerEntry {
	private constructor(
		public readonly id: string,
		public readonly walletId: string,
		public readonly transactionId: string,
		public readonly direction: LedgerDirection,
		public readonly money: Money,
		public readonly balanceBefore: Money,
		public readonly balanceAfter: Money,
		public readonly createdAt: Date,
	) {}

	static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
		const entry = new WalletLedgerEntry(
			props.id,
			props.walletId,
			props.transactionId,
			props.direction,
			Money.from(props.money.toJSON()),
			Money.from(props.balanceBefore.toJSON()),
			Money.from(props.balanceAfter.toJSON()),
			props.createdAt,
		);
		if (!entry.isBalanced()) {
			throw new InvalidEntityStateError(
				`ledger entry arithmetic mismatch: ${props.balanceBefore.toJSON().amount} ${props.direction} ${props.money.toJSON().amount} != ${props.balanceAfter.toJSON().amount}`,
			);
		}
		if (!entry.money.isPositive()) {
			throw new InvalidEntityStateError("ledger entry amount must be positive");
		}
		if (entry.balanceAfter.isNegative()) {
			throw new InvalidEntityStateError("ledger entry must not carry the balance below zero");
		}
		return entry;
	}

	static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
		return new WalletLedgerEntry(
			state.id,
			state.walletId,
			state.transactionId,
			state.direction,
			Money.from(state.money),
			Money.from(state.balanceBefore),
			Money.from(state.balanceAfter),
			state.createdAt,
		);
	}

	isBalanced(): boolean {
		if (this.direction === LedgerDirection.Debit) {
			return this.balanceBefore.subtract(this.money).equals(this.balanceAfter);
		}
		return this.balanceBefore.add(this.money).equals(this.balanceAfter);
	}
}
