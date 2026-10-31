import { describe, expect, test } from "bun:test";
import { payloadHashOf, canonicalJson, sha256Hex } from "../../src/application/shared/canonical-payload-hash";
import { businessSubsetOf, payloadHashOfCommand, type WagerTransactionCommand } from "../../src/application/wagering/process-wager-transaction";

function command(overrides: Partial<WagerTransactionCommand> = {}): WagerTransactionCommand {
	return {
		providerId: "provider-a",
		externalTransactionId: "transaction-123",
		idempotencyKey: "provider-a:transaction-123",
		playerId: "player-1",
		walletId: "wallet-1",
		roundId: "round-987",
		gameId: "fortune-chimp",
		kind: "BET",
		money: { amount: "25.00", currency: "BRL" },
		correlationId: "corr-1",
		...overrides,
	};
}

describe("canonical payload hash", () => {
	test("is insensitive to key ordering", () => {
		expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
		expect(payloadHashOf({ a: "1", b: "2" })).toBe(payloadHashOf({ b: "2", a: "1" }));
	});

	test("hashes only the business subset — transport metadata never enters", () => {
		const base = payloadHashOfCommand(command());
		const withTransport = payloadHashOfCommand(
			command({ messageId: "sqs-message-1", messagePayloadHash: "deadbeef", correlationId: "corr-2" }),
		);
		expect(withTransport).toBe(base);
	});

	test("hash is stable and non-empty", () => {
		expect(payloadHashOfCommand(command())).toMatch(/^[0-9a-f]{64}$/);
		expect(sha256Hex("x")).toMatch(/^[0-9a-f]{64}$/);
	});

	test("any business change produces a different hash", () => {
		const base = payloadHashOfCommand(command());
		expect(payloadHashOfCommand(command({ money: { amount: "25.01", currency: "BRL" } }))).not.toBe(base);
		expect(payloadHashOfCommand(command({ roundId: "round-988" }))).not.toBe(base);
		expect(payloadHashOfCommand(command({ kind: "WIN" }))).not.toBe(base);
		expect(payloadHashOfCommand(command({ playerId: "player-2" }))).not.toBe(base);
	});

	test("omits the reference field entirely when it is absent", () => {
		const subset = businessSubsetOf(command());
		expect(Object.keys(subset)).not.toContain("referenceExternalTransactionId");
		expect(businessSubsetOf(command({ referenceExternalTransactionId: "tx-1" }))).toHaveProperty(
			"referenceExternalTransactionId",
			"tx-1",
		);
	});
});
