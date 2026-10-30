import { Money, type MoneyProps } from "../../domain/shared/money";
import { BusinessRuleViolationError } from "../../domain/shared/errors";
import { Wallet } from "../../domain/wallet/wallet";
import { WalletLedgerEntry } from "../../domain/wallet/ledger-entry";
import { LedgerDirection } from "../../domain/wallet/ledger-direction";
import { WagerTransaction } from "../../domain/wagering/wager-transaction";
import { WagerTransactionKind, WagerTransactionStatus } from "../../domain/wagering/kinds";
import { FailureCode } from "../../domain/wagering/failure-codes";
import type { UnitOfWork, Repositories } from "../ports/unit-of-work";
import type { InboxClaim } from "../../infrastructure/repositories/inbox.repository";
import { payloadHashOf } from "../shared/canonical-payload-hash";
import { newId, newEventId } from "../shared/ids";
import { IdempotencyConflictError } from "../errors";
import {
	WalletBalanceChanged,
	WagerTransactionPendingReference,
	WagerTransactionProcessed,
	WagerTransactionRejected,
} from "../../domain/outbox/events";

export interface WagerTransactionCommand {
	providerId: string;
	externalTransactionId: string;
	idempotencyKey: string;
	playerId: string;
	walletId: string;
	roundId: string;
	gameId: string;
	kind: string;
	money: MoneyProps;
	referenceExternalTransactionId?: string | undefined;
	correlationId: string;
	/** SQS delivery identity — different transports omit it. */
	messageId?: string | undefined;
	messagePayloadHash?: string | undefined;
}

export type WagerProcessingOutcome =
	| {
			type: "PROCESSED";
			transactionId: string;
			providerId: string;
			externalTransactionId: string;
			balanceAfter: MoneyProps | undefined;
			walletVersion: number | undefined;
			ledgerEntryId: string | undefined;
			idempotentReplay: boolean;
	  }
	| {
			type: "REJECTED";
			transactionId: string;
			providerId: string;
			externalTransactionId: string;
			failureCode: FailureCode;
			idempotentReplay: boolean;
	  }
	| {
			type: "PENDING_REFERENCE";
			transactionId: string;
			providerId: string;
			externalTransactionId: string;
			idempotentReplay: boolean;
	  };

export class MessageInFlightError extends Error {
	constructor() {
		super("message delivery is being processed by another transaction");
		this.name = "MessageInFlightError";
	}
}

export function toKind(value: unknown): WagerTransactionKind | undefined {
	const values = Object.values(WagerTransactionKind) as string[];
	return values.includes(value as WagerTransactionKind) ? (value as WagerTransactionKind) : undefined;
}

/**
 * Canonical hash subject: business fields only. Transport metadata (headers,
 * messageId, timestamps) is excluded by construction because the caller passes
 * exactly this subset.
 */
export function businessSubsetOf(cmd: {
	providerId: string;
	externalTransactionId: string;
	playerId: string;
	walletId: string;
	roundId: string;
	gameId: string;
	kind: string;
	money: MoneyProps;
	referenceExternalTransactionId?: string | undefined;
}): Record<string, unknown> {
	return {
		providerId: cmd.providerId,
		externalTransactionId: cmd.externalTransactionId,
		playerId: cmd.playerId,
		walletId: cmd.walletId,
		roundId: cmd.roundId,
		gameId: cmd.gameId,
		kind: cmd.kind,
		money: cmd.money,
		...(cmd.referenceExternalTransactionId !== undefined
			? { referenceExternalTransactionId: cmd.referenceExternalTransactionId }
			: {}),
	};
}

export function payloadHashOfCommand(cmd: WagerTransactionCommand): string {
	return payloadHashOf(businessSubsetOf(cmd));
}

export interface PendingReferencePolicy {
	baseDelayMs: number;
	maxAttempts: number;
}

export class ProcessWagerTransactionUseCase {
	constructor(
		private readonly uow: UnitOfWork,
		private readonly policy: PendingReferencePolicy,
		private readonly inboxConsumerName: string,
	) {}

	async execute(cmd: WagerTransactionCommand): Promise<WagerProcessingOutcome> {
		return await this.uow.transactional((repos) => this.withinTransaction(cmd, repos));
	}

	// -------------------------------------------------------------- fresh intake

	private async withinTransaction(cmd: WagerTransactionCommand, repos: Repositories): Promise<WagerProcessingOutcome> {
		const payloadHash = payloadHashOfCommand(cmd);

		if (cmd.messageId !== undefined) {
			const claim: InboxClaim = await repos.inbox.claim(cmd.messageId, this.inboxConsumerName, cmd.messagePayloadHash ?? payloadHash);
			if (claim === "inFlight") {
				throw new MessageInFlightError();
			}
			if (claim === "alreadyProcessed") {
				return await this.outcomeFromIdentity(cmd, repos, true);
			}
		}

		const wallet = await repos.wallets.lockById(cmd.walletId);

		const existing = await repos.transactions.findExistingByAnyKey(cmd.idempotencyKey, cmd.providerId, cmd.externalTransactionId);
		if (existing) {
			if (existing.matchesPayload(payloadHash)) {
				return this.outcomeOf(existing, true);
			}
			throw new IdempotencyConflictError(cmd.idempotencyKey);
		}

		const kind = toKind(cmd.kind);
		const money = Money.from(cmd.money);

		if (wallet === null) {
			return await this.rejectFresh(repos, cmd, payloadHash, FailureCode.WALLET_NOT_FOUND, kind, money);
		}
		if (kind === undefined) {
			return await this.rejectFresh(repos, cmd, payloadHash, FailureCode.INVALID_KIND, undefined, money);
		}
		if (kind === WagerTransactionKind.Opening) {
			return await this.rejectFresh(repos, cmd, payloadHash, FailureCode.INVALID_KIND, kind, money);
		}
		if (money.currency !== wallet.currency) {
			return await this.rejectFresh(repos, cmd, payloadHash, FailureCode.WALLET_CURRENCY_MISMATCH, kind, money);
		}

		const tx = WagerTransaction.create({
			id: newId(),
			providerId: cmd.providerId,
			externalTransactionId: cmd.externalTransactionId,
			idempotencyKey: cmd.idempotencyKey,
			payloadHash,
			walletId: cmd.walletId,
			playerId: cmd.playerId,
			roundId: cmd.roundId,
			gameId: cmd.gameId,
			kind,
			money,
			referenceExternalTransactionId: cmd.referenceExternalTransactionId,
		});

		if (tx.requiresReference()) {
			if (tx.referenceExternalTransactionId === undefined) {
				return await this.rejectTx(repos, cmd, tx, FailureCode.MISSING_REFERENCE);
			}
			const reference = await repos.transactions.lockByProviderExternal(tx.providerId, tx.referenceExternalTransactionId);
			if (reference === null) {
				return await this.parkPending(repos, cmd, tx);
			}
			const failure = validateReference(tx, reference);
			if (failure !== null) {
				return await this.rejectTx(repos, cmd, tx, failure);
			}
			return await this.applyRegistry(repos, cmd, tx, wallet, reference);
		}

		return await this.applyRegistry(repos, cmd, tx, wallet, undefined);
	}

	// ------------------------------------------------------ pending-reference work

	/**
	 * One parked transaction, one own SQL transaction. Resolves whatever it can now:
	 * applies when the reference became visible, schedules the next backoff, or
	 * rejects when attempts are exhausted.
	 */
	async resumePending(transactionId: string): Promise<WagerProcessingOutcome | "unschedulable"> {
		return await this.uow.transactional(async (repos) => {
			const tx = await repos.transactions.lockById(transactionId);
			if (tx === null || tx.status !== WagerTransactionStatus.PendingReference) {
				return "unschedulable";
			}
			const nextAttemptAt = new Date(Date.now() + backoffDelay(this.policy.baseDelayMs, tx.referenceAttempts + 1));
			tx.scheduleReferenceRetry(nextAttemptAt);

			const wallet = await repos.wallets.lockById(tx.walletId);
			if (wallet === null) {
				return await this.rejectWorker(repos, tx, FailureCode.WALLET_NOT_FOUND);
			}

			const referenceExternal = tx.referenceExternalTransactionId ?? "";
			const reference = await repos.transactions.lockByProviderExternal(tx.providerId, referenceExternal);
			if (reference === null) {
				if (tx.referenceAttempts >= this.policy.maxAttempts) {
					return await this.rejectWorker(repos, tx, FailureCode.REFERENCED_TRANSACTION_NOT_FOUND);
				}
				await flushTransactionState(repos, tx);
				return "unschedulable";
			}
			const failure = validateReference(tx, reference);
			if (failure !== null) {
				return await this.rejectWorker(repos, tx, failure);
			}
			return await this.applyRegistry(repos, syntheticCommandOf(tx), tx, wallet, reference);
		});
	}

	// ------------------------------------------------------------ shared internals

	private async applyRegistry(
		repos: Repositories,
		cmd: WagerTransactionCommand,
		tx: WagerTransaction,
		wallet: Wallet,
		reference: WagerTransaction | undefined,
	): Promise<WagerProcessingOutcome> {
		if (reference !== undefined && (await repos.transactions.hasSuccessfulReversalOf(reference.id, tx.kind))) {
			return await this.rejectTx(repos, cmd, tx, FailureCode.REFERENCE_ALREADY_REVERSED);
		}

		const now = new Date();

		if (!tx.affectsBalance()) {
			tx.markProcessed(reference?.id ?? undefined, now, undefined, undefined);
			await flushTransactionState(repos, tx);
			repos.outbox.enqueue(
				new WagerTransactionProcessed(tx.walletId, { eventId: newEventId(), correlationId: cmd.correlationId, causationId: tx.id }, {
					transactionId: tx.id,
					providerId: tx.providerId,
					externalTransactionId: tx.externalTransactionId,
					walletId: tx.walletId,
					playerId: tx.playerId,
					roundId: tx.roundId,
					gameId: tx.gameId,
					kind: tx.kind,
					status: "PROCESSED",
					money: tx.money.toJSON(),
					idempotencyKey: tx.idempotencyKey,
					balanceAfter: wallet.balance.toJSON(),
					walletVersion: wallet.version,
				}),
				newId(),
			);
			await this.markInbox(cmd, repos);
			return {
				type: "PROCESSED",
				transactionId: tx.id,
				providerId: tx.providerId,
				externalTransactionId: tx.externalTransactionId,
				balanceAfter: undefined,
				walletVersion: undefined,
				ledgerEntryId: undefined,
				idempotentReplay: false,
			};
		}

		const direction = tx.ledgerDirectionFor(reference);
		try {
			const mutated =
				direction === LedgerDirection.Credit
					? wallet.credit({ money: tx.money, occurredAt: now })
					: wallet.debit({ money: tx.money, occurredAt: now });
			const entry = WalletLedgerEntry.create({
				id: newId(),
				walletId: wallet.id,
				transactionId: tx.id,
				direction,
				money: tx.money,
				balanceBefore: mutated.balanceBefore,
				balanceAfter: mutated.balanceAfter,
				createdAt: now,
			});
			await repos.ledger.insert(entry);
			await repos.wallets.applyMutation(wallet, mutated, now);
			tx.markProcessed(reference?.id ?? undefined, now, mutated.balanceAfter.toJSON(), mutated.walletVersion);
			await flushTransactionState(repos, tx);

			repos.outbox.enqueue(
				WalletBalanceChanged.from(
					wallet.id,
					{ transactionId: tx.id, direction, money: tx.money },
					mutated,
					{ eventId: newEventId(), correlationId: cmd.correlationId, causationId: tx.id },
				),
				newId(),
			);
			repos.outbox.enqueue(
				new WagerTransactionProcessed(tx.walletId, { eventId: newEventId(), correlationId: cmd.correlationId, causationId: tx.id }, {
					transactionId: tx.id,
					providerId: tx.providerId,
					externalTransactionId: tx.externalTransactionId,
					walletId: tx.walletId,
					playerId: tx.playerId,
					roundId: tx.roundId,
					gameId: tx.gameId,
					kind: tx.kind,
					status: "PROCESSED",
					money: tx.money.toJSON(),
					idempotencyKey: tx.idempotencyKey,
					balanceAfter: mutated.balanceAfter.toJSON(),
					walletVersion: mutated.walletVersion,
				}),
				newId(),
			);
			await this.markInbox(cmd, repos);
			return {
				type: "PROCESSED",
				transactionId: tx.id,
				providerId: tx.providerId,
				externalTransactionId: tx.externalTransactionId,
				balanceAfter: mutated.balanceAfter.toJSON(),
				walletVersion: mutated.walletVersion,
				ledgerEntryId: entry.id,
				idempotentReplay: false,
			};
		} catch (error) {
			if (error instanceof BusinessRuleViolationError) {
				const code: FailureCode =
					error.failureCode === "INSUFFICIENT_BALANCE" && tx.kind === WagerTransactionKind.Rollback
						? FailureCode.REVERSAL_WOULD_OVERDRAW
						: (error.failureCode as FailureCode);
				await this.rejectTx(repos, cmd, tx, code);
				return {
					type: "REJECTED",
					transactionId: tx.id,
					providerId: tx.providerId,
					externalTransactionId: tx.externalTransactionId,
					failureCode: code,
					idempotentReplay: false,
				};
			}
			throw error;
		}
	}

	private async parkPending(repos: Repositories, cmd: WagerTransactionCommand, tx: WagerTransaction): Promise<WagerProcessingOutcome> {
		const nextAttemptAt = new Date(Date.now() + this.policy.baseDelayMs);
		tx.markPendingReference(nextAttemptAt);
		await flushTransactionState(repos, tx);
		repos.outbox.enqueue(
			new WagerTransactionPendingReference(tx.walletId, { eventId: newEventId(), correlationId: cmd.correlationId, causationId: tx.id }, {
				transactionId: tx.id,
				providerId: tx.providerId,
				externalTransactionId: tx.externalTransactionId,
				walletId: tx.walletId,
				playerId: tx.playerId,
				roundId: tx.roundId,
				referenceExternalTransactionId: tx.referenceExternalTransactionId ?? "",
				nextAttemptAt: nextAttemptAt.toISOString(),
				attempt: 0,
			}),
			newId(),
		);
		await this.markInbox(cmd, repos);
		return { type: "PENDING_REFERENCE", transactionId: tx.id, providerId: tx.providerId, externalTransactionId: tx.externalTransactionId, idempotentReplay: false };
	}

	private async rejectFresh(
		repos: Repositories,
		cmd: WagerTransactionCommand,
		payloadHash: string,
		code: FailureCode,
		kind: WagerTransactionKind | undefined,
		money: Money,
	): Promise<WagerProcessingOutcome> {
		const tx = WagerTransaction.create({
			id: newId(),
			providerId: cmd.providerId,
			externalTransactionId: cmd.externalTransactionId,
			idempotencyKey: cmd.idempotencyKey,
			payloadHash,
			walletId: cmd.walletId,
			playerId: cmd.playerId,
			roundId: cmd.roundId,
			gameId: cmd.gameId,
			kind: kind ?? WagerTransactionKind.Bet,
			money,
			referenceExternalTransactionId: cmd.referenceExternalTransactionId,
		});
		return await this.rejectTx(repos, cmd, tx, code);
	}

	private async rejectTx(repos: Repositories, cmd: WagerTransactionCommand, tx: WagerTransaction, code: FailureCode): Promise<WagerProcessingOutcome> {
		tx.reject(code);
		await flushTransactionState(repos, tx);
		repos.outbox.enqueue(rejectedEventOf(tx, cmd.correlationId), newId());
		await this.markInbox(cmd, repos);
		return { type: "REJECTED", transactionId: tx.id, providerId: tx.providerId, externalTransactionId: tx.externalTransactionId, failureCode: code, idempotentReplay: false };
	}

	private async rejectWorker(repos: Repositories, tx: WagerTransaction, code: FailureCode): Promise<WagerProcessingOutcome> {
		tx.reject(code);
		await flushTransactionState(repos, tx);
		repos.outbox.enqueue(rejectedEventOf(tx, tx.id), newId());
		return { type: "REJECTED", transactionId: tx.id, providerId: tx.providerId, externalTransactionId: tx.externalTransactionId, failureCode: code, idempotentReplay: false };
	}

	private async markInbox(cmd: WagerTransactionCommand, repos: Repositories): Promise<void> {
		if (cmd.messageId !== undefined) {
			await repos.inbox.markProcessed(cmd.messageId, this.inboxConsumerName, new Date());
		}
	}

	private async outcomeFromIdentity(cmd: WagerTransactionCommand, repos: Repositories, replay: boolean): Promise<WagerProcessingOutcome> {
		const existing = await repos.transactions.findExistingByAnyKey(cmd.idempotencyKey, cmd.providerId, cmd.externalTransactionId);
		if (existing === null) {
			throw new Error("inbox marks message processed but no transaction found — persistent state violation");
		}
		return this.outcomeOf(existing, replay);
	}

	private outcomeOf(existing: WagerTransaction, idempotentReplay: boolean): WagerProcessingOutcome {
		const base = { transactionId: existing.id, providerId: existing.providerId, externalTransactionId: existing.externalTransactionId, idempotentReplay };
		switch (existing.status) {
			case WagerTransactionStatus.Processed:
				return { type: "PROCESSED", ...base, balanceAfter: existing.resultingBalance, walletVersion: existing.resultingVersion, ledgerEntryId: undefined };
			case WagerTransactionStatus.Rejected:
			case WagerTransactionStatus.Failed:
				return { type: "REJECTED", ...base, failureCode: existing.failureCode ?? FailureCode.INTERNAL_ERROR };
			case WagerTransactionStatus.PendingReference:
			case WagerTransactionStatus.Pending:
				return { type: "PENDING_REFERENCE", ...base };
		}
		throw new Error(`unhandled transaction status ${existing.status as string}`);
	}
}

/** Linearly-then-exponential delay for reference retries: base * 2^n capped at 5 minutes. */
function backoffDelay(baseMs: number, attempt: number): number {
	const max = 5 * 60 * 1000;
	return Math.min(baseMs * Math.pow(2, Math.max(0, attempt - 1)), max);
}

function syntheticCommandOf(tx: WagerTransaction): WagerTransactionCommand {
	return {
		providerId: tx.providerId,
		externalTransactionId: tx.externalTransactionId,
		idempotencyKey: tx.idempotencyKey,
		playerId: tx.playerId,
		walletId: tx.walletId,
		roundId: tx.roundId,
		gameId: tx.gameId,
		kind: tx.kind,
		money: tx.money.toJSON(),
		referenceExternalTransactionId: tx.referenceExternalTransactionId,
		correlationId: tx.id,
	};
}

function rejectedEventOf(tx: WagerTransaction, correlationId: string): WagerTransactionRejected {
	return new WagerTransactionRejected(
		tx.walletId,
		{ eventId: newEventId(), correlationId, causationId: tx.id },
		{
			transactionId: tx.id,
			providerId: tx.providerId,
			externalTransactionId: tx.externalTransactionId,
			walletId: tx.walletId,
			playerId: tx.playerId,
			roundId: tx.roundId,
			gameId: tx.gameId,
			kind: tx.kind,
			status: "REJECTED",
			failureCode: tx.failureCode ?? FailureCode.INTERNAL_ERROR,
			idempotencyKey: tx.idempotencyKey,
		},
	);
}

async function flushTransactionState(repos: Repositories, tx: WagerTransaction): Promise<void> {
	const inserted = await repos.transactions.tryInsert(tx);
	if (inserted === "inserted") {
		await repos.transactions.save(tx);
	}
}

function validateReference(tx: WagerTransaction, reference: WagerTransaction): FailureCode | null {
	if (reference.status !== WagerTransactionStatus.Processed) {
		return FailureCode.REFERENCED_TRANSACTION_NOT_PROCESSABLE;
	}
	const allowed: Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
		[WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
		[WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
	};
	const allowedKinds = allowed[tx.kind];
	if (allowedKinds === undefined || !allowedKinds.includes(reference.kind)) {
		return FailureCode.REFERENCED_TRANSACTION_NOT_PROCESSABLE;
	}
	if (
		reference.providerId !== tx.providerId ||
		reference.playerId !== tx.playerId ||
		reference.walletId !== tx.walletId ||
		reference.roundId !== tx.roundId ||
		reference.money.currency !== tx.money.currency
	) {
		return FailureCode.REFERENCE_CONTEXT_MISMATCH;
	}
	if (!reference.money.equals(tx.money)) {
		return FailureCode.REFERENCE_AMOUNT_MISMATCH;
	}
	return null;
}
