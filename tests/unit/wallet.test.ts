import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/shared/money";
import { BusinessRuleViolationError, InvalidEntityStateError } from "../../src/domain/shared/errors";
import { Wallet, type WalletApplyProps } from "../../src/domain/wallet/wallet";
import { LedgerDirection } from "../../src/domain/wallet/ledger-direction";
import { FailureCode } from "../../src/domain/wagering/failure-codes";

function openWallet(amount = "100.00", currency = "BRL", playerId = "player-1"): Wallet {
	return Wallet.open({
		id: "wallet-1",
		playerId,
		initialBalance: Money.from({ amount, currency }),
	});
}

function applyProps(wallet: Wallet, amount: string, entryId = "entry-1", transactionId = "tx-1"): WalletApplyProps {
	return {
		transactionId,
		entryId,
		money: Money.from({ amount, currency: wallet.currency }),
		occurredAt: new Date("2026-01-01T00:00:00.000Z"),
	};
}

describe("Wallet", () => {
	test("open starts at version 1 with the initial balance", () => {
		const wallet = openWallet("100.00");
		expect(wallet.version).toBe(1);
		expect(wallet.balance.toJSON()).toEqual({ amount: "100.00", currency: "BRL" });
		expect(wallet.id).toBe("wallet-1");
		expect(wallet.playerId).toBe("player-1");
		expect(wallet.currency).toBe("BRL");
	});

	test("open allows a zero initial balance", () => {
		const wallet = openWallet("0.00");
		expect(wallet.balance.toString()).toBe("0.00 BRL");
		expect(wallet.version).toBe(1);
	});

	test("credit returns the generated ledger entry and mutates balance and version", () => {
		const wallet = openWallet("100.00");
		const result = wallet.credit(applyProps(wallet, "50.00"));
		expect(result.direction).toBe(LedgerDirection.Credit);
		expect(result.balanceBefore.toJSON().amount).toBe("100.00");
		expect(result.balanceAfter.toJSON().amount).toBe("150.00");
		expect(result.walletVersion).toBe(2);
		expect(wallet.balance.toJSON().amount).toBe("150.00");
		expect(wallet.version).toBe(2);
		expect(wallet.updatedAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");

		expect(result.entry.id).toBe("entry-1");
		expect(result.entry.walletId).toBe(wallet.id);
		expect(result.entry.transactionId).toBe("tx-1");
		expect(result.entry.direction).toBe(LedgerDirection.Credit);
		expect(result.entry.money.toJSON()).toEqual({ amount: "50.00", currency: "BRL" });
		expect(result.entry.balanceBefore.toJSON().amount).toBe("100.00");
		expect(result.entry.balanceAfter.toJSON().amount).toBe("150.00");
		expect(result.entry.isBalanced()).toBe(true);
	});

	test("debit returns the generated ledger entry and mutates balance and version", () => {
		const wallet = openWallet("100.00");
		const result = wallet.debit(applyProps(wallet, "30.00"));
		expect(result.direction).toBe(LedgerDirection.Debit);
		expect(result.balanceAfter.toJSON().amount).toBe("70.00");
		expect(result.walletVersion).toBe(2);
		expect(wallet.balance.toJSON().amount).toBe("70.00");
		expect(wallet.version).toBe(2);
		expect(result.entry.direction).toBe(LedgerDirection.Debit);
		expect(result.entry.balanceBefore.toJSON().amount).toBe("100.00");
		expect(result.entry.balanceAfter.toJSON().amount).toBe("70.00");
		expect(result.entry.isBalanced()).toBe(true);
	});

	test("version increments only when the balance actually changes", () => {
		const wallet = openWallet("100.00");
		wallet.credit(applyProps(wallet, "10.00", "entry-1"));
		expect(() => wallet.debit(applyProps(wallet, "500.00", "entry-2"))).toThrow(BusinessRuleViolationError);
		expect(() => wallet.debit(applyProps(wallet, "0.00", "entry-3"))).toThrow(InvalidEntityStateError);
		expect(() => wallet.credit(applyProps(wallet, "0.00", "entry-4"))).toThrow(InvalidEntityStateError);
		expect(wallet.version).toBe(2);
		expect(wallet.balance.toJSON().amount).toBe("110.00");
	});

	test("debit beyond balance throws INSUFFICIENT_BALANCE and keeps state untouched", () => {
		const wallet = openWallet("100.00");
		let thrown: unknown;
		try {
			wallet.debit(applyProps(wallet, "100.01", "entry-1"));
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(BusinessRuleViolationError);
		expect((thrown as BusinessRuleViolationError).failureCode).toBe(FailureCode.INSUFFICIENT_BALANCE);
		expect(wallet.balance.toJSON().amount).toBe("100.00");
		expect(wallet.version).toBe(1);
	});

	test("debit can reach exactly zero, but not below", () => {
		const wallet = openWallet("50.00");
		const result = wallet.debit(applyProps(wallet, "50.00"));
		expect(result.balanceAfter.toString()).toBe("0.00 BRL");
		expect(() => wallet.debit(applyProps(wallet, "0.01", "entry-2"))).toThrow(BusinessRuleViolationError);
	});

	test("currency mismatch fails before any mutation", () => {
		const wallet = openWallet("100.00");
		let thrown: unknown;
		try {
			wallet.credit({
				transactionId: "tx-1",
				entryId: "entry-1",
				money: Money.from({ amount: "10.00", currency: "USD" }),
				occurredAt: new Date(),
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(BusinessRuleViolationError);
		expect((thrown as BusinessRuleViolationError).failureCode).toBe(FailureCode.WALLET_CURRENCY_MISMATCH);
		expect(wallet.balance.toJSON().amount).toBe("100.00");
		expect(wallet.version).toBe(1);
	});

	test("non-positive amounts are rejected for both directions", () => {
		const wallet = openWallet("100.00");
		expect(() => wallet.debit(applyProps(wallet, "0.00"))).toThrow(InvalidEntityStateError);
		expect(() => wallet.credit(applyProps(wallet, "0.00"))).toThrow(InvalidEntityStateError);
	});

	test("rehydrate restores the persisted state without revalidation", () => {
		const wallet = openWallet("42.00", "EUR");
		const rehydrated = Wallet.rehydrate({
			id: "wallet-9",
			playerId: "player-9",
			currency: "EUR",
			balance: { amount: "7.25", currency: "EUR" },
			version: 5,
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
			updatedAt: new Date("2026-01-02T00:00:00.000Z"),
		});
		expect(rehydrated.balance.toString()).toBe("7.25 EUR");
		expect(rehydrated.version).toBe(5);
		expect(rehydrated.id).toBe("wallet-9");
		expect(rehydrated.currency).toBe("EUR");
		expect(wallet.balance.toString()).toBe("42.00 EUR");
	});
});
