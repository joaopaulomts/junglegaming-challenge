import { IntegrationEvent, type EventContext } from "./integration-event";
import type { MoneyProps } from "../shared/money";
import type { LedgerDirection } from "../wallet/ledger-direction";
import type { FailureCode } from "../wagering/failure-codes";
import { Money } from "../shared/money";

interface BaseEventProps<T> {
	aggregateId: string;
	ctx: EventContext;
	occurredAt: Date;
	data: T;
}

abstract class TypedEvent<T> extends IntegrationEvent<T> {
	protected constructor(props: BaseEventProps<T>) {
		super({
			eventId: props.ctx.eventId,
			aggregateId: props.aggregateId,
			correlationId: props.ctx.correlationId,
			causationId: props.ctx.causationId,
			occurredAt: props.occurredAt,
			data: props.data,
		});
	}
}

export interface WalletBalanceChangedData {
	walletId: string;
	transactionId: string;
	direction: LedgerDirection;
	money: MoneyProps;
	balanceBefore: MoneyProps;
	balanceAfter: MoneyProps;
	walletVersion: number;
}

export class WalletBalanceChanged extends TypedEvent<WalletBalanceChangedData> {
	readonly eventType = "WalletBalanceChanged";
	readonly version = 1;

	static from(
		walletId: string,
		entry: { transactionId: string; direction: LedgerDirection; money: Money },
		result: { balanceBefore: Money; balanceAfter: Money; walletVersion: number },
		ctx: EventContext,
	): WalletBalanceChanged {
		return new WalletBalanceChanged({
			aggregateId: walletId,
			ctx,
			occurredAt: new Date(),
			data: {
				walletId,
				transactionId: entry.transactionId,
				direction: entry.direction,
				money: entry.money.toJSON(),
				balanceBefore: result.balanceBefore.toJSON(),
				balanceAfter: result.balanceAfter.toJSON(),
				walletVersion: result.walletVersion,
			},
		});
	}
}

export interface WagerTransactionProcessedData {
	transactionId: string;
	providerId: string;
	externalTransactionId: string;
	walletId: string;
	playerId: string;
	roundId: string;
	gameId: string;
	kind: string;
	status: "PROCESSED";
	money: MoneyProps;
	idempotencyKey: string;
	balanceAfter: MoneyProps;
	walletVersion: number;
}

export class WagerTransactionProcessed extends TypedEvent<WagerTransactionProcessedData> {
	readonly eventType = "WagerTransactionProcessed";
	readonly version = 1;

	constructor(aggregateId: string, ctx: EventContext, data: WagerTransactionProcessedData) {
		super({ aggregateId, ctx, occurredAt: new Date(), data });
	}
}

export interface WagerTransactionRejectedData {
	transactionId: string;
	providerId: string;
	externalTransactionId: string;
	walletId: string;
	playerId: string;
	roundId: string;
	gameId: string;
	kind: string;
	status: "REJECTED";
	failureCode: FailureCode;
	idempotencyKey: string;
}

export class WagerTransactionRejected extends TypedEvent<WagerTransactionRejectedData> {
	readonly eventType = "WagerTransactionRejected";
	readonly version = 1;

	constructor(aggregateId: string, ctx: EventContext, data: WagerTransactionRejectedData) {
		super({ aggregateId, ctx, occurredAt: new Date(), data });
	}
}

export interface WagerTransactionPendingReferenceData {
	transactionId: string;
	providerId: string;
	externalTransactionId: string;
	walletId: string;
	playerId: string;
	roundId: string;
	referenceExternalTransactionId: string;
	nextAttemptAt: string;
	attempt: number;
}

export class WagerTransactionPendingReference extends TypedEvent<WagerTransactionPendingReferenceData> {
	readonly eventType = "WagerTransactionPendingReference";
	readonly version = 1;

	constructor(aggregateId: string, ctx: EventContext, data: WagerTransactionPendingReferenceData) {
		super({ aggregateId, ctx, occurredAt: new Date(), data });
	}
}

export type AnyIntegrationEvent =
	| WalletBalanceChanged
	| WagerTransactionProcessed
	| WagerTransactionRejected
	| WagerTransactionPendingReference;
