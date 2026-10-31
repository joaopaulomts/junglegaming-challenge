import { describe, expect, test } from "bun:test";
import { Money, type MoneyProps } from "../../src/domain/shared/money";
import { BusinessRuleViolationError, InvalidTransactionStateError } from "../../src/domain/shared/errors";
import { WagerTransaction } from "../../src/domain/wagering/wager-transaction";
import { WagerTransactionKind, WagerTransactionStatus } from "../../src/domain/wagering/kinds";
import { LedgerDirection } from "../../src/domain/wallet/ledger-direction";
import { FailureCode } from "../../src/domain/wagering/failure-codes";

const money = (amount: string, currency = "BRL"): Money => Money.from({ amount, currency });
const balance = (amount: string, currency = "BRL"): MoneyProps => ({ amount, currency });

interface StateOverrides {
	kind?: WagerTransactionKind;
	id?: string;
	externalTransactionId?: string;
	referenceExternalTransactionId?: string | undefined;
}

function tx(props: StateOverrides = {}): WagerTransaction {
	const kind = props.kind ?? WagerTransactionKind.Bet;
	return WagerTransaction.create({
		id: props.id ?? "tx-1",
		providerId: "provider-1",
		externalTransactionId: props.externalTransactionId ?? "ext-1",
		idempotencyKey: "provider-1:ext-1",
		payloadHash: "hash",
		walletId: "wallet-1",
		playerId: "player-1",
		roundId: "round-1",
		gameId: "game-1",
		kind,
		money: money("10.00"),
		referenceExternalTransactionId: props.referenceExternalTransactionId,
	});
}

function fromState(kind: WagerTransactionKind, status: WagerTransactionStatus, id: string = "tx-state"): WagerTransaction {
	return WagerTransaction.rehydrate({
		id,
		providerId: "provider-1",
		externalTransactionId: "ext-" + id,
		idempotencyKey: "provider-1:ext-" + id,
		payloadHash: "hash",
		walletId: "wallet-1",
		playerId: "player-1",
		roundId: "round-1",
		gameId: "game-1",
		kind,
		money: balance("10.00"),
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		status,
		referenceAttempts: 0,
	});
}

function pendingReferenceTx(kind: WagerTransactionKind.Refund | WagerTransactionKind.Rollback): WagerTransaction {
	const t = tx({ kind, referenceExternalTransactionId: "ext-ref" });
	t.markPendingReference(new Date("2026-01-01T00:01:00.000Z"));
	return t;
}

describe("WagerTransaction — ledger direction rules", () => {
	test("opening credits, bet debits, win and refund credit", () => {
		expect(tx({ kind: WagerTransactionKind.Opening }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
		expect(tx({ kind: WagerTransactionKind.Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
		expect(tx({ kind: WagerTransactionKind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
		expect(tx({ kind: WagerTransactionKind.Refund }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
	});

	test("rollback inverts the direction of its reference", () => {
		const rollback = tx({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: "ext-ref" });
		expect(rollback.ledgerDirectionFor(tx({ kind: WagerTransactionKind.Bet }))).toBe(LedgerDirection.Credit);
		expect(rollback.ledgerDirectionFor(tx({ kind: WagerTransactionKind.Win }))).toBe(LedgerDirection.Debit);
		expect(rollback.ledgerDirectionFor(tx({ kind: WagerTransactionKind.Refund }))).toBe(LedgerDirection.Debit);
	});

	test("rollback requires a reference to determine its ledger direction", () => {
		expect(() => tx({ kind: WagerTransactionKind.Rollback }).ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
	});

	test("loss never produces a ledger entry", () => {
		expect(tx({ kind: WagerTransactionKind.Loss }).affectsBalance()).toBe(false);
		expect(() => tx({ kind: WagerTransactionKind.Loss }).ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
	});

	test("opening affects the balance", () => {
		expect(tx({ kind: WagerTransactionKind.Opening }).affectsBalance()).toBe(true);
	});
});

describe("WagerTransaction — reference kinds", () => {
	test("refund may only reference bet", () => {
		expect(WagerTransaction.allowedReferenceKinds(WagerTransactionKind.Refund)).toEqual([WagerTransactionKind.Bet]);
		expect(tx({ kind: WagerTransactionKind.Refund }).assertReferenceKind(WagerTransactionKind.Bet)).toBeUndefined();
	});

	test("rollback may reference bet, win and refund", () => {
		expect(WagerTransaction.allowedReferenceKinds(WagerTransactionKind.Rollback)).toEqual([
			WagerTransactionKind.Bet,
			WagerTransactionKind.Win,
			WagerTransactionKind.Refund,
		]);
		const rollback = tx({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: "ext-ref" });
		expect(rollback.assertReferenceKind(WagerTransactionKind.Bet)).toBeUndefined();
		expect(rollback.assertReferenceKind(WagerTransactionKind.Win)).toBeUndefined();
		expect(rollback.assertReferenceKind(WagerTransactionKind.Refund)).toBeUndefined();
	});

	test("other kinds never reference anything", () => {
		for (const kind of [WagerTransactionKind.Opening, WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Loss]) {
			expect(() => WagerTransaction.allowedReferenceKinds(kind)).toThrow(InvalidTransactionStateError);
		}
	});

	test("forbidden reference kinds fail with REFERENCE_KIND_NOT_ALLOWED", () => {
		const refund = tx({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "ext-ref" });
		let thrown: unknown;
		try {
			refund.assertReferenceKind(WagerTransactionKind.Win);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(BusinessRuleViolationError);
		expect((thrown as BusinessRuleViolationError).failureCode).toBe(FailureCode.REFERENCE_KIND_NOT_ALLOWED);

		const rollback = tx({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: "ext-ref" });
		expect(() => rollback.assertReferenceKind(WagerTransactionKind.Loss)).toThrow(BusinessRuleViolationError);
	});
});

describe("WagerTransaction — transition table", () => {
	test("create starts PENDING", () => {
		expect(tx().status).toBe(WagerTransactionStatus.Pending);
		expect(tx().isTerminal()).toBe(false);
	});

	test("PENDING -> PROCESSED is terminal", () => {
		const t = tx();
		t.markProcessed(undefined, new Date(), balance("90.00"), 2);
		expect(t.status).toBe(WagerTransactionStatus.Processed);
		expect(t.isTerminal()).toBe(true);
		expect(t.resultingBalance).toEqual(balance("90.00"));
		expect(t.resultingVersion).toBe(2);
		expect(t.processedAt).toBeInstanceOf(Date);
	});

	test("PENDING -> PENDING_REFERENCE accumulates attempts until resolution", () => {
		const t = pendingReferenceTx(WagerTransactionKind.Refund);
		expect(t.status).toBe(WagerTransactionStatus.PendingReference);
		expect(t.isTerminal()).toBe(false);
		t.scheduleReferenceRetry(new Date("2026-01-01T00:02:00.000Z"));
		expect(t.referenceAttempts).toBe(1);
		t.scheduleReferenceRetry(new Date("2026-01-01T00:03:00.000Z"));
		expect(t.referenceAttempts).toBe(2);
		t.markProcessed("tx-ref", new Date(), balance("110.00"), 3);
		expect(t.status).toBe(WagerTransactionStatus.Processed);
	});

	test("PENDING -> REJECTED and PENDING -> FAILED are terminal", () => {
		const rejected = tx();
		rejected.reject(FailureCode.INSUFFICIENT_BALANCE);
		expect(rejected.status).toBe(WagerTransactionStatus.Rejected);
		expect(rejected.failureCode).toBe(FailureCode.INSUFFICIENT_BALANCE);
		expect(rejected.isTerminal()).toBe(true);

		const failed = tx();
		failed.fail(FailureCode.INTERNAL_ERROR);
		expect(failed.status).toBe(WagerTransactionStatus.Failed);
		expect(failed.failureCode).toBe(FailureCode.INTERNAL_ERROR);
		expect(failed.isTerminal()).toBe(true);
	});

	test("PENDING_REFERENCE -> REJECTED / FAILED", () => {
		const rejected = pendingReferenceTx(WagerTransactionKind.Refund);
		rejected.reject(FailureCode.REFERENCED_TRANSACTION_NOT_FOUND);
		expect(rejected.status).toBe(WagerTransactionStatus.Rejected);

		const failed = pendingReferenceTx(WagerTransactionKind.Refund);
		failed.fail(FailureCode.INTERNAL_ERROR);
		expect(failed.status).toBe(WagerTransactionStatus.Failed);
	});

	test("markPendingReference is only valid from PENDING", () => {
		const fromPendingReference = pendingReferenceTx(WagerTransactionKind.Refund);
		expect(() => fromPendingReference.markPendingReference(new Date())).toThrow(InvalidTransactionStateError);
	});

	test("scheduleReferenceRetry is only valid from PENDING_REFERENCE", () => {
		expect(() => tx().scheduleReferenceRetry(new Date())).toThrow(InvalidTransactionStateError);
	});

	test("terminal states reject every transition", () => {
		const processed = fromState(WagerTransactionKind.Bet, WagerTransactionStatus.Processed);
		const rejected = fromState(WagerTransactionKind.Bet, WagerTransactionStatus.Rejected);
		const failed = fromState(WagerTransactionKind.Bet, WagerTransactionStatus.Failed);
		const invalidState = fromState(WagerTransactionKind.Loss, WagerTransactionStatus.Processed);
		const at = new Date();
		for (const t of [processed, rejected, failed, invalidState]) {
			expect(() => t.markProcessed(undefined, at)).toThrow(InvalidTransactionStateError);
			expect(() => t.reject(FailureCode.INTERNAL_ERROR)).toThrow(InvalidTransactionStateError);
			expect(() => t.fail(FailureCode.INTERNAL_ERROR)).toThrow(InvalidTransactionStateError);
			expect(() => t.markPendingReference(at)).toThrow(InvalidTransactionStateError);
			expect(() => t.scheduleReferenceRetry(at)).toThrow(InvalidTransactionStateError);
			expect(t.isTerminal()).toBe(true);
		}
	});

	test("requiresReference matches REFUND and ROLLBACK only", () => {
		expect(tx({ kind: WagerTransactionKind.Refund }).requiresReference()).toBe(true);
		expect(tx({ kind: WagerTransactionKind.Rollback }).requiresReference()).toBe(true);
		expect(tx({ kind: WagerTransactionKind.Bet }).requiresReference()).toBe(false);
		expect(tx({ kind: WagerTransactionKind.Win }).requiresReference()).toBe(false);
		expect(tx({ kind: WagerTransactionKind.Loss }).requiresReference()).toBe(false);
		expect(tx({ kind: WagerTransactionKind.Opening }).requiresReference()).toBe(false);
	});
});

describe("WagerTransaction — rehydrate", () => {
	test("rebuilds terminal and retry state without revalidating transitions", () => {
		const restored = WagerTransaction.rehydrate({
			id: "tx-2",
			providerId: "provider-1",
			externalTransactionId: "ext-2",
			idempotencyKey: "provider-1:ext-2",
			payloadHash: "hash",
			walletId: "wallet-1",
			playerId: "player-1",
			roundId: "round-1",
			gameId: "game-1",
			kind: WagerTransactionKind.Loss,
			money: balance("10.00"),
			referenceExternalTransactionId: undefined,
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
			status: WagerTransactionStatus.Processed,
			referenceAttempts: 3,
			referenceNextAttemptAt: new Date("2026-01-01T00:01:00.000Z"),
			referenceTransactionId: "tx-ref",
			processedAt: new Date("2026-01-01T00:02:00.000Z"),
			resultingBalance: balance("90.00"),
			resultingVersion: 4,
		});
		expect(restored.status).toBe(WagerTransactionStatus.Processed);
		expect(restored.referenceAttempts).toBe(3);
		expect(restored.resultingBalance).toEqual(balance("90.00"));
		expect(restored.resultingVersion).toBe(4);
		expect(restored.referenceTransactionId).toBe("tx-ref");
		expect(restored.money.toString()).toBe("10.00 BRL");
		expect(() => restored.markProcessed(undefined, new Date())).toThrow(InvalidTransactionStateError);
	});
});

describe("WagerTransaction — payload matching", () => {
	test("matchesPayload compares the persisted hash", () => {
		const t = tx();
		expect(t.matchesPayload("hash")).toBe(true);
		expect(t.matchesPayload("other")).toBe(false);
	});
});
