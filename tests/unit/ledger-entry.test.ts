import { describe, expect, test } from "bun:test";
import { Money, type MoneyProps } from "../../src/domain/shared/money";
import { InvalidEntityStateError } from "../../src/domain/shared/errors";
import { WalletLedgerEntry, type CreateLedgerEntryProps } from "../../src/domain/wallet/ledger-entry";
import { LedgerDirection } from "../../src/domain/wallet/ledger-direction";

type LedgerOverrides = {
	direction: LedgerDirection;
	amount: string;
	balanceBefore: string;
	balanceAfter: string;
};

function props(overrides: LedgerOverrides): CreateLedgerEntryProps {
	return {
		id: "entry-1",
		walletId: "wallet-1",
		transactionId: "tx-1",
		direction: overrides.direction,
		money: Money.from({ amount: overrides.amount, currency: "BRL" }),
		balanceBefore: Money.from({ amount: overrides.balanceBefore, currency: "BRL" }),
		balanceAfter: Money.from({ amount: overrides.balanceAfter, currency: "BRL" }),
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
	};
}

function snapshotOf(entry: WalletLedgerEntry): Record<string, unknown> {
	return {
		id: entry.id,
		walletId: entry.walletId,
		transactionId: entry.transactionId,
		direction: entry.direction,
		money: entry.money.toJSON(),
		balanceBefore: entry.balanceBefore.toJSON(),
		balanceAfter: entry.balanceAfter.toJSON(),
		createdAt: entry.createdAt,
	};
}

describe("WalletLedgerEntry", () => {
	test("creates a balanced debit entry", () => {
		const entry = WalletLedgerEntry.create(
			props({ direction: LedgerDirection.Debit, amount: "30.00", balanceBefore: "100.00", balanceAfter: "70.00" }),
		);
		expect(entry.isBalanced()).toBe(true);
		expect(entry.money.toString()).toBe("30.00 BRL");
		expect(entry.balanceBefore.toString()).toBe("100.00 BRL");
		expect(entry.balanceAfter.toString()).toBe("70.00 BRL");
		expect(entry.transactionId).toBe("tx-1");
		expect(entry.walletId).toBe("wallet-1");
	});

	test("creates a balanced credit entry", () => {
		const entry = WalletLedgerEntry.create(
			props({ direction: LedgerDirection.Credit, amount: "30.00", balanceBefore: "70.00", balanceAfter: "100.00" }),
		);
		expect(entry.isBalanced()).toBe(true);
	});

	test("rejects an unbalanced debit entry", () => {
		expect(() =>
			WalletLedgerEntry.create(
				props({ direction: LedgerDirection.Debit, amount: "30.00", balanceBefore: "100.00", balanceAfter: "60.00" }),
			),
		).toThrow(InvalidEntityStateError);
	});

	test("rejects an unbalanced credit entry", () => {
		expect(() =>
			WalletLedgerEntry.create(
				props({ direction: LedgerDirection.Credit, amount: "30.00", balanceBefore: "70.00", balanceAfter: "90.00" }),
			),
		).toThrow(InvalidEntityStateError);
	});

	test("rejects a non-positive amount", () => {
		expect(() =>
			WalletLedgerEntry.create(
				props({ direction: LedgerDirection.Debit, amount: "0.00", balanceBefore: "100.00", balanceAfter: "100.00" }),
			),
		).toThrow(InvalidEntityStateError);
	});

	test("a negative balanceAfter cannot even be constructed — Money rejects negative inputs", () => {
		expect(() => Money.from({ amount: "-50.00", currency: "BRL" })).toThrow();
	});

	test("rehydrate restores the persisted entry without revalidation", () => {
		const state = {
			id: "entry-2",
			walletId: "wallet-1",
			transactionId: "tx-2",
			direction: LedgerDirection.Debit,
			money: { amount: "50.00", currency: "BRL" } as MoneyProps,
			balanceBefore: { amount: "100.00", currency: "BRL" } as MoneyProps,
			balanceAfter: { amount: "50.00", currency: "BRL" } as MoneyProps,
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
		};
		const restored = WalletLedgerEntry.rehydrate(state);
		expect(restored.id).toBe("entry-2");
		expect(restored.isBalanced()).toBe(true);
	});

	test("rehydrate does not revalidate a deliberately unbalanced persisted row", () => {
		const state = {
			id: "entry-3",
			walletId: "wallet-1",
			transactionId: "tx-3",
			direction: LedgerDirection.Credit,
			money: { amount: "10.00", currency: "BRL" },
			balanceBefore: { amount: "100.00", currency: "BRL" },
			balanceAfter: { amount: "500.00", currency: "BRL" },
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
		};
		const restored = WalletLedgerEntry.rehydrate(state);
		expect(restored.isBalanced()).toBe(false);
	});

	test("serialized state round-trips through rehydrate", () => {
		const entry = WalletLedgerEntry.create(
			props({ direction: LedgerDirection.Credit, amount: "12.34", balanceBefore: "20.00", balanceAfter: "32.34" }),
		);
		const snapshots = snapshotOf(entry);
		expect(snapshots["money"]).toEqual({ amount: "12.34", currency: "BRL" });
		expect(snapshots["balanceAfter"]).toEqual({ amount: "32.34", currency: "BRL" });
	});
});
