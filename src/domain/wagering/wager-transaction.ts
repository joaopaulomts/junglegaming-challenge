import { Money, type MoneyProps } from "../shared/money";
import { InvalidTransactionStateError } from "../shared/errors";
import type { FailureCode } from "./failure-codes";
import { WagerTransactionKind, WagerTransactionStatus } from "./kinds";
import { LedgerDirection } from "../wallet/ledger-direction";

export interface WagerTransactionSnapshot {
	status: WagerTransactionStatus;
	referenceTransactionId?: string;
	failureCode?: FailureCode;
	processedAt?: Date;
}

export interface WagerTransactionState extends WagerTransactionSnapshot {
	id: string;
	providerId: string;
	externalTransactionId: string;
	idempotencyKey: string;
	payloadHash: string;
	walletId: string;
	playerId: string;
	roundId: string;
	gameId: string;
	kind: WagerTransactionKind;
	money: MoneyProps;
	referenceExternalTransactionId?: string;
	createdAt: Date;
	referenceAttempts: number;
	referenceNextAttemptAt?: Date;
	resultingBalance?: MoneyProps;
	resultingVersion?: number;
}

export interface CreateWagerTransactionProps {
	id: string;
	providerId: string;
	externalTransactionId: string;
	idempotencyKey: string;
	payloadHash: string;
	walletId: string;
	playerId: string;
	roundId: string;
	gameId: string;
	kind: WagerTransactionKind;
	money: Money;
	referenceExternalTransactionId?: string;
}

const TERMINAL_STATUSES = new Set<WagerTransactionStatus>([
	WagerTransactionStatus.Processed,
	WagerTransactionStatus.Rejected,
	WagerTransactionStatus.Failed,
]);

export class WagerTransaction {
	private constructor(
		public readonly id: string,
		public readonly providerId: string,
		public readonly externalTransactionId: string,
		public readonly idempotencyKey: string,
		public readonly payloadHash: string,
		public readonly walletId: string,
		public readonly playerId: string,
		public readonly roundId: string,
		public readonly gameId: string,
		public readonly kind: WagerTransactionKind,
		public readonly money: Money,
		public readonly referenceExternalTransactionId: string | undefined,
		public readonly createdAt: Date,
		private _status: WagerTransactionStatus,
		private _referenceTransactionId?: string,
		private _failureCode?: FailureCode,
		private _processedAt?: Date,
		private _referenceAttempts: number = 0,
		private _referenceNextAttemptAt?: Date,
		private _resultingBalance?: MoneyProps,
		private _resultingVersion?: number,
	) {}

	static create(props: CreateWagerTransactionProps): WagerTransaction {
		return new WagerTransaction(
			props.id,
			props.providerId,
			props.externalTransactionId,
			props.idempotencyKey,
			props.payloadHash,
			props.walletId,
			props.playerId,
			props.roundId,
			props.gameId,
			props.kind,
			Money.from(props.money.toJSON()),
			props.referenceExternalTransactionId,
			new Date(),
			WagerTransactionStatus.Pending,
		);
	}

	/** Rebuild from persistence — never revalidates transition rules. */
	static rehydrate(state: WagerTransactionState): WagerTransaction {
		return new WagerTransaction(
			state.id,
			state.providerId,
			state.externalTransactionId,
			state.idempotencyKey,
			state.payloadHash,
			state.walletId,
			state.playerId,
			state.roundId,
			state.gameId,
			state.kind,
			Money.from(state.money),
			state.referenceExternalTransactionId,
			state.createdAt,
			state.status,
			state.referenceTransactionId,
			state.failureCode,
			state.processedAt,
			state.referenceAttempts,
			state.referenceNextAttemptAt,
			state.resultingBalance,
			state.resultingVersion,
		);
	}

	// ---- state
	get status(): WagerTransactionStatus {
		return this._status;
	}

	get referenceTransactionId(): string | undefined {
		return this._referenceTransactionId;
	}

	get failureCode(): FailureCode | undefined {
		return this._failureCode;
	}

	get processedAt(): Date | undefined {
		return this._processedAt;
	}

	get referenceAttempts(): number {
		return this._referenceAttempts;
	}

	get referenceNextAttemptAt(): Date | undefined {
		return this._referenceNextAttemptAt;
	}

	get resultingBalance(): MoneyProps | undefined {
		return this._resultingBalance;
	}

	get resultingVersion(): number | undefined {
		return this._resultingVersion;
	}

	// ---- transitions
	markProcessed(referenceTransactionId: string | undefined, at: Date, resultingBalance?: MoneyProps, resultingVersion?: number): void {
		this.assertNotTerminal();
		this._status = WagerTransactionStatus.Processed;
		this._referenceTransactionId = referenceTransactionId;
		this._processedAt = at;
		this._resultingBalance = resultingBalance;
		this._resultingVersion = resultingVersion;
	}

	markPendingReference(nextAttemptAt: Date): void {
		if (this._status !== WagerTransactionStatus.Pending) {
			throw new InvalidTransactionStateError(
				`only PENDING transitions to PENDING_REFERENCE, got ${this._status}`,
			);
		}
		this._status = WagerTransactionStatus.PendingReference;
		this._referenceNextAttemptAt = nextAttemptAt;
	}

	reject(code: FailureCode): void {
		this.assertNotTerminal();
		this._status = WagerTransactionStatus.Rejected;
		this._failureCode = code;
	}

	fail(code: FailureCode): void {
		this.assertNotTerminal();
		this._status = WagerTransactionStatus.Failed;
		this._failureCode = code;
	}

	isTerminal(): boolean {
		return TERMINAL_STATUSES.has(this._status);
	}

	affectsBalance(): boolean {
		return this.kind !== WagerTransactionKind.Loss;
	}

	requiresReference(): boolean {
		return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
	}

	matchesPayload(payloadHash: string): boolean {
		return this.payloadHash === payloadHash;
	}

	scheduleReferenceRetry(nextAttemptAt: Date): void {
		if (this._status !== WagerTransactionStatus.PendingReference) {
			throw new InvalidTransactionStateError(
				`only PENDING_REFERENCE schedules retries, got ${this._status}`,
			);
		}
		this._referenceAttempts += 1;
		this._referenceNextAttemptAt = nextAttemptAt;
	}

	ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
		switch (this.kind) {
			case WagerTransactionKind.Opening:
				return LedgerDirection.Credit;
			case WagerTransactionKind.Bet:
				return LedgerDirection.Debit;
			case WagerTransactionKind.Win:
			case WagerTransactionKind.Refund:
				return LedgerDirection.Credit;
			case WagerTransactionKind.Rollback: {
				if (!reference) {
					throw new InvalidTransactionStateError("ROLLBACK requires its reference to determine ledger direction");
				}
				const referenceDirection = reference.ledgerDirectionFor();
				return referenceDirection === LedgerDirection.Debit
					? LedgerDirection.Credit
					: LedgerDirection.Debit;
			}
			case WagerTransactionKind.Loss:
				throw new InvalidTransactionStateError("LOSS does not produce a ledger entry");
		}
	}

	private assertNotTerminal(): void {
		if (this.isTerminal()) {
			throw new InvalidTransactionStateError(
				`cannot transition terminal transaction ${this.id} in status ${this._status}`,
			);
		}
	}
}
