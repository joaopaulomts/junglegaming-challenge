import type { IntegrationEvent } from "./integration-event";
import { InvalidEntityStateError } from "../shared/errors";

export interface OutboxMessageState {
	id: string;
	aggregateId: string;
	eventType: string;
	payload: Readonly<Record<string, unknown>>;
	occurredAt: Date;
	attempts: number;
	nextAttemptAt?: Date | undefined;
	publishedAt?: Date | undefined;
}

export interface EnqueueOutboxProps {
	id: string;
	aggregateId: string;
	eventType: string;
	payload: Readonly<Record<string, unknown>>;
	occurredAt: Date;
}

export class OutboxMessage {
	private constructor(
		public readonly id: string,
		public readonly aggregateId: string,
		public readonly eventType: string,
		public readonly payload: Readonly<Record<string, unknown>>,
		public readonly occurredAt: Date,
		private _attempts: number,
		private _nextAttemptAt?: Date,
		private _publishedAt?: Date,
	) {}

	/** Enqueues from an in-memory integration event envelope. */
	static enqueue(event: IntegrationEvent<unknown>, id: string): OutboxMessage {
		const envelope = event.toJSON();
		return new OutboxMessage(id, envelope.aggregateId, envelope.eventType, { ...envelope } as Record<string, unknown>, event.occurredAt, 0);
	}

	static rehydrate(state: OutboxMessageState): OutboxMessage {
		return new OutboxMessage(
			state.id,
			state.aggregateId,
			state.eventType,
			state.payload,
			state.occurredAt,
			state.attempts,
			state.nextAttemptAt,
			state.publishedAt,
		);
	}

	get attempts(): number {
		return this._attempts;
	}

	get nextAttemptAt(): Date | undefined {
		return this._nextAttemptAt;
	}

	get publishedAt(): Date | undefined {
		return this._publishedAt;
	}

	isPending(): boolean {
		return this._publishedAt === undefined;
	}

	isDue(now: Date): boolean {
		return this.isPending() && (!this._nextAttemptAt || this._nextAttemptAt.getTime() <= now.getTime());
	}

	markPublished(at: Date): void {
		if (!this.isPending()) {
			throw new InvalidEntityStateError("outbox message already published");
		}
		this._publishedAt = at;
	}

	scheduleRetry(now: Date): void {
		this._attempts += 1;
		this._nextAttemptAt = now;
	}
}
