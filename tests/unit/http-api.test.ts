import { describe, expect, test } from "bun:test";
import { BadRequestException } from "@nestjs/common";
import { ValidationPipe } from "@nestjs/common";
import { ApiExceptionFilter } from "../../src/presentation/filters/api-exception.filter";
import { SubmitTransactionRequest, CreateWalletRequest } from "../../src/presentation/dtos/wallet.dto";
import { httpStatusOf, serialize } from "../../src/presentation/controllers/wagering.controller";
import { encodeLedgerCursor, decodeLedgerCursor } from "../../src/application/queries/query-service";
import { BusinessRuleViolationError } from "../../src/domain/shared/errors";
import { IdempotencyConflictError, InvalidPayloadError, WalletAlreadyExistsError, AggregateNotFoundError, TransientInfraError } from "../../src/application/errors";
import { NoopProviderIdentityPort, ProviderIdentityMismatchError } from "../../src/application/ports/provider-identity.port";
import type { WagerProcessingOutcome } from "../../src/application/wagering/process-wager-transaction";

const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

function validSubmitPayload(): Record<string, unknown> {
	return {
		providerId: "provider-a",
		externalTransactionId: "transaction-123",
		playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
		walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
		roundId: "round-987",
		gameId: "fortune-chimp",
		kind: "BET",
		money: { amount: "25.00", currency: "BRL" },
	};
}

interface Captured {
	status: number;
	body: unknown;
}

function captureFilter(): { throw: (error: unknown) => Captured } {
	const filter = new ApiExceptionFilter();
	return {
		throw: (error: unknown) => {
			let status = 0;
			let body: unknown;
			const response = {
				status: (code: number) => ({
					json: (payload: unknown) => {
						status = code;
						body = payload;
						return {};
					},
				}),
			};
			const host = {
				switchToHttp: () => ({ getResponse: () => response }),
			} as never;
			filter.catch(error, host);
			return { status, body };
		},
	};
}

describe("POST /wagering/transactions payload validation", () => {
	test("accepts a well-formed payload", async () => {
		const result = await pipe.transform(validSubmitPayload(), { type: "body", metatype: SubmitTransactionRequest });
		expect(result).toBeInstanceOf(SubmitTransactionRequest);
		expect(result.kind).toBe("BET");
	});

	test("rejects an amount that is not a 2-decimal non-negative string", async () => {
		for (const amount of ["25", "25.001", "-1.00", "", "1e2"]) {
			const payload = { ...validSubmitPayload(), money: { amount, currency: "BRL" } };
			await expect(pipe.transform(payload, { type: "body", metatype: SubmitTransactionRequest })).rejects.toBeInstanceOf(
				BadRequestException,
			);
		}
	});

	test("rejects a malformed currency code", async () => {
		const payload = { ...validSubmitPayload(), money: { amount: "1.00", currency: "brl" } };
		await expect(pipe.transform(payload, { type: "body", metatype: SubmitTransactionRequest })).rejects.toBeInstanceOf(
			BadRequestException,
		);
	});

	test("rejects missing required fields", async () => {
		const { walletId: _walletId, ...missingWallet } = validSubmitPayload();
		await expect(pipe.transform(missingWallet, { type: "body", metatype: SubmitTransactionRequest })).rejects.toBeInstanceOf(
			BadRequestException,
		);
	});

	test("rejects unknown properties instead of silently dropping them", async () => {
		const payload = { ...validSubmitPayload(), tamperedField: "1" };
		await expect(pipe.transform(payload, { type: "body", metatype: SubmitTransactionRequest })).rejects.toBeInstanceOf(
			BadRequestException,
		);
	});
});

describe("POST /wallets payload validation", () => {
	test("accepts a well-formed payload", async () => {
		const payload = { playerId: "player-1", initialBalance: { amount: "1000.00", currency: "BRL" } };
		const result = await pipe.transform(payload, { type: "body", metatype: CreateWalletRequest });
		expect(result).toBeInstanceOf(CreateWalletRequest);
	});

	test("rejects a negative initial balance", async () => {
		const payload = { playerId: "player-1", initialBalance: { amount: "-1.00", currency: "BRL" } };
		await expect(pipe.transform(payload, { type: "body", metatype: CreateWalletRequest })).rejects.toBeInstanceOf(
			BadRequestException,
		);
	});
});

describe("HTTP status mapping", () => {
	test("distinguishes processed, pending and rejected", () => {
		expect(httpStatusOf("PROCESSED")).toBe(200);
		expect(httpStatusOf("PENDING_REFERENCE")).toBe(202);
		expect(httpStatusOf("REJECTED")).toBe(422);
	});

	test("serializes each outcome shape", () => {
		const processed: WagerProcessingOutcome = {
			type: "PROCESSED",
			transactionId: "tx-1",
			providerId: "provider-a",
			externalTransactionId: "ext-1",
			balanceAfter: { amount: "975.00", currency: "BRL" },
			walletVersion: 3,
			ledgerEntryId: "ledger-1",
			idempotentReplay: false,
		};
		expect(serialize(processed)).toEqual({
			transactionId: "tx-1",
			status: "PROCESSED",
			balance: { amount: "975.00", currency: "BRL" },
			walletVersion: 3,
			idempotentReplay: false,
		});

		const rejected: WagerProcessingOutcome = {
			type: "REJECTED",
			transactionId: "tx-2",
			providerId: "provider-a",
			externalTransactionId: "ext-2",
			failureCode: "INSUFFICIENT_BALANCE",
			idempotentReplay: true,
		};
		expect(serialize(rejected)).toEqual({
			transactionId: "tx-2",
			status: "REJECTED",
			failureCode: "INSUFFICIENT_BALANCE",
			idempotentReplay: true,
		});

		const pending: WagerProcessingOutcome = {
			type: "PENDING_REFERENCE",
			transactionId: "tx-3",
			providerId: "provider-a",
			externalTransactionId: "ext-3",
			idempotentReplay: false,
		};
		expect(serialize(pending)).toEqual({ transactionId: "tx-3", status: "PENDING_REFERENCE", idempotentReplay: false });
	});
});

describe("error → HTTP status mapping (consistent across endpoints)", () => {
	const filter = captureFilter();

	test("invalid payload is 400", () => {
		const captured = filter.throw(new InvalidPayloadError(["money.amount is malformed"]));
		expect(captured.status).toBe(400);
		expect(captured.body).toMatchObject({ error: { code: "INVALID_PAYLOAD", payloadFixable: true } });
	});

	test("idempotency conflict is 409 and never a replay", () => {
		const captured = filter.throw(new IdempotencyConflictError("provider-a:transaction-123"));
		expect(captured.status).toBe(409);
		expect(captured.body).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
	});

	test("duplicate wallet is 409", () => {
		const captured = filter.throw(new WalletAlreadyExistsError("player-1", "BRL"));
		expect(captured.status).toBe(409);
		expect(captured.body).toMatchObject({ error: { code: "WALLET_ALREADY_EXISTS" } });
	});

	test("missing aggregate is 404", () => {
		const captured = filter.throw(new AggregateNotFoundError("wallet", "wallet-1"));
		expect(captured.status).toBe(404);
		expect(captured.body).toMatchObject({ error: { code: "NOT_FOUND" } });
	});

	test("business rule rejection is 422 with its failureCode", () => {
		const captured = filter.throw(new BusinessRuleViolationError("INSUFFICIENT_BALANCE", "not enough funds"));
		expect(captured.status).toBe(422);
		expect(captured.body).toMatchObject({ error: { code: "INSUFFICIENT_BALANCE" } });
	});

	test("an overdraw-causing rollback gets a different failureCode at the same status", () => {
		const overdraw = filter.throw(new BusinessRuleViolationError("REVERSAL_WOULD_OVERDRAW", "x"));
		const insufficient = filter.throw(new BusinessRuleViolationError("INSUFFICIENT_BALANCE", "x"));
		expect(overdraw.status).toBe(422);
		expect(insufficient.status).toBe(422);
		expect((overdraw.body as { error: { code: string } }).error.code).not.toBe(
			(insufficient.body as { error: { code: string } }).error.code,
		);
	});

	test("transient infrastructure failure is 503 and marked retryable", () => {
		const captured = filter.throw(new TransientInfraError("connection reset"));
		expect(captured.status).toBe(503);
		expect(captured.body).toMatchObject({ error: { code: "SERVICE_UNAVAILABLE", retryable: true } });
	});

	test("a contradicting transport identity is 400, not a silent override", () => {
		const captured = filter.throw(new ProviderIdentityMismatchError("provider-a", "provider-b"));
		expect(captured.status).toBe(400);
		expect(captured.body).toMatchObject({ error: { code: "PROVIDER_IDENTITY_MISMATCH" } });
	});
});

describe("ProviderIdentityPort (no IdP — documented extension point)", () => {
	const port = new NoopProviderIdentityPort();

	test("passes through the claimed provider when no credential is presented", () => {
		expect(port.authenticate({ transportProviderId: undefined, claimedProviderId: "provider-a" })).toEqual({
			providerId: "provider-a",
		});
	});

	test("accepts a transport identity that agrees with the payload", () => {
		expect(port.authenticate({ transportProviderId: "provider-a", claimedProviderId: "provider-a" })).toEqual({
			providerId: "provider-a",
		});
	});

	test("rejects a transport identity that contradicts the payload", () => {
		expect(() => port.authenticate({ transportProviderId: "provider-a", claimedProviderId: "provider-b" })).toThrow(
			ProviderIdentityMismatchError,
		);
	});
});

describe("opaque ledger cursor", () => {
	test("round-trips a stable, opaque cursor", () => {
		const entry = { createdAt: new Date("2026-10-30T12:00:00.000Z"), id: "0192f291-27dd-7d3f-8071-5f8685deef37" };
		const cursor = encodeLedgerCursor(entry);
		expect(cursor).not.toContain("2026");
		expect(decodeLedgerCursor(cursor)).toEqual(entry);
		expect(decodeLedgerCursor(encodeLedgerCursor(entry))).toEqual(decodeLedgerCursor(cursor));
	});

	test("treats a tampered or absent cursor as no cursor", () => {
		expect(decodeLedgerCursor(undefined)).toBeUndefined();
		expect(decodeLedgerCursor("")).toBeUndefined();
		expect(decodeLedgerCursor("!!!not-base64json!!!")).toBeUndefined();
	});
});
