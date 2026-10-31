import { LockMode } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import {
	WagerTransaction,
	type WagerTransactionState,
} from "../../domain/wagering/wager-transaction";
import { WagerTransactionEntity } from "../database/entities/wager-transaction.entity";
import {
	WagerTransactionKind,
	WagerTransactionStatus,
} from "../../domain/wagering/kinds";
import type { FailureCode } from "../../domain/wagering/failure-codes";

export class WagerTransactionRepository {
	constructor(private readonly em: EntityManager) {}

	async findById(id: string): Promise<WagerTransaction | null> {
		const row = await this.em.findOne(WagerTransactionEntity, { id });
		return row ? toDomain(row) : null;
	}

	/** Locks the transaction row itself (SELECT ... FOR UPDATE) — used by the pending-reference worker. */
	async lockById(id: string): Promise<WagerTransaction | null> {
		const row = await this.em.findOne(WagerTransactionEntity, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
		return row ? toDomain(row) : null;
	}

	async hasSuccessfulReversalOf(referenceTransactionId: string, kind: WagerTransactionKind): Promise<boolean> {
		const count = await this.em.count(WagerTransactionEntity, {
			referenceTransactionId,
			kind,
			status: WagerTransactionStatus.Processed,
		});
		return count > 0;
	}

	async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
		const row = await this.em.findOne(WagerTransactionEntity, { idempotencyKey: key });
		return row ? toDomain(row) : null;
	}

	async findByProviderExternal(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
		const row = await this.em.findOne(WagerTransactionEntity, {
			providerId,
			externalTransactionId,
		});
		return row ? toDomain(row) : null;
	}

	/** Locks an existing row FOR UPDATE — used to serialize double-reversal checks. */
	async lockByProviderExternal(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
		const row = await this.em.findOne(
			WagerTransactionEntity,
			{ providerId, externalTransactionId },
			{ lockMode: LockMode.PESSIMISTIC_WRITE },
		);
		return row ? toDomain(row) : null;
	}

	/**
	 * Attempts the first insert of the transaction. Returns "inserted" when this
	 * call won the unique race, "conflict" when a row with the same idempotency key
	 * (or provider external id) already exists and is visible to this transaction
	 * (i.e. the other INSERT has committed).
	 */
	async tryInsert(tx: WagerTransaction): Promise<"inserted" | "conflict"> {
		const row = fromDomain(tx);
		const result = await this.em.execute(
			`INSERT INTO wager_transactions
				(id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
				 player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id,
				 status, reference_transaction_id, failure_code, processed_at, resulting_balance,
				 resulting_version, reference_attempts, reference_next_attempt_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT DO NOTHING`,
			[
				row.id,
				row.providerId,
				row.externalTransactionId,
				row.idempotencyKey,
				row.payloadHash,
				row.walletId,
				row.playerId,
				row.roundId,
				row.gameId,
				row.kind,
				row.amount,
				row.currency,
				row.referenceExternalTransactionId,
				row.status,
				row.referenceTransactionId,
				row.failureCode,
				row.processedAt,
				row.resultingBalance,
				row.resultingVersion,
				row.referenceAttempts,
				row.referenceNextAttemptAt,
				row.createdAt,
			],
			"run",
		);
		const resultWithCount = result as unknown as { rowCount?: number | null };
		const rowCount = resultWithCount.rowCount ?? 0;
		return rowCount > 0 ? "inserted" : "conflict";
	}

	async findExistingByAnyKey(idempotencyKey: string, providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
		return (
			(await this.findByIdempotencyKey(idempotencyKey)) ??
			(await this.findByProviderExternal(providerId, externalTransactionId))
		);
	}

	async findReferenceByExternal(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
		return this.lockByProviderExternal(providerId, externalTransactionId);
	}

	async findSuccessfulReversalOf(referenceTransactionId: string, kind: WagerTransactionKind): Promise<WagerTransaction | null> {
		const row = await this.em.findOne(WagerTransactionEntity, {
			referenceTransactionId,
			kind,
			status: WagerTransactionStatus.Processed,
		});
		return row ? toDomain(row) : null;
	}

	/** Persists the mutable state of a domain transaction (status, refs, failure). */
	async save(tx: WagerTransaction): Promise<void> {
		const row = await this.em.findOneOrFail(WagerTransactionEntity, { id: tx.id });
		row.status = tx.status;
		row.referenceTransactionId = tx.referenceTransactionId ?? null as never;
		row.failureCode = tx.failureCode ?? null as never;
		row.processedAt = tx.processedAt ?? null as never;
		row.referenceAttempts = tx.referenceAttempts;
		row.referenceNextAttemptAt = tx.referenceNextAttemptAt ?? null as never;
		row.resultingBalance = tx.resultingBalance?.amount ?? null as never;
		row.resultingVersion = tx.resultingVersion ?? null as never;
	}
}

export function fromDomain(tx: WagerTransaction): WagerTransactionEntity {
	return {
		id: tx.id,
		providerId: tx.providerId,
		externalTransactionId: tx.externalTransactionId,
		idempotencyKey: tx.idempotencyKey,
		payloadHash: tx.payloadHash,
		walletId: tx.walletId,
		playerId: tx.playerId,
		roundId: tx.roundId,
		gameId: tx.gameId,
		kind: tx.kind,
		amount: tx.money.toJSON().amount,
		currency: tx.money.currency,
		referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null as never,
		status: tx.status,
		referenceTransactionId: null as never,
		failureCode: null as never,
		processedAt: null as never,
		resultingBalance: null as never,
		resultingVersion: null as never,
		referenceAttempts: tx.referenceAttempts,
		referenceNextAttemptAt: null as never,
		createdAt: tx.createdAt,
	} as WagerTransactionEntity;
}

export function toDomain(row: WagerTransactionEntity): WagerTransaction {
	const state: WagerTransactionState = {
		id: row.id,
		providerId: row.providerId,
		externalTransactionId: row.externalTransactionId,
		idempotencyKey: row.idempotencyKey,
		payloadHash: row.payloadHash,
		walletId: row.walletId,
		playerId: row.playerId,
		roundId: row.roundId,
		gameId: row.gameId,
		kind: row.kind as WagerTransactionKind,
		money: { amount: row.amount, currency: row.currency },
		referenceExternalTransactionId: row.referenceExternalTransactionId ?? undefined,
		createdAt: row.createdAt,
		status: row.status as WagerTransactionStatus,
		referenceTransactionId: row.referenceTransactionId ?? undefined,
		failureCode: (row.failureCode ?? undefined) as FailureCode | undefined,
		processedAt: row.processedAt ?? undefined,
		referenceAttempts: row.referenceAttempts,
		referenceNextAttemptAt: row.referenceNextAttemptAt ?? undefined,
		resultingBalance: row.resultingBalance
			? { amount: row.resultingBalance, currency: row.currency }
			: undefined,
		resultingVersion: row.resultingVersion ?? undefined,
	};
	return WagerTransaction.rehydrate(state);
}
