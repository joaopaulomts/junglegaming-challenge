import type { EntityManager } from "@mikro-orm/postgresql";
import { OutboxMessageEntity } from "../database/entities/outbox-message.entity";
import { OutboxMessage, type OutboxMessageState } from "../../domain/outbox/outbox-message";
import { IntegrationEvent } from "../../domain/outbox/integration-event";

export class OutboxRepository {
	constructor(private readonly em: EntityManager) {}

	async enqueue(event: IntegrationEvent<unknown>, id: string): Promise<void> {
		const envelope = event.toJSON();
		const row = this.em.create(OutboxMessageEntity, {
			id,
			aggregateId: envelope.aggregateId,
			eventType: envelope.eventType,
			payload: envelope as unknown as Record<string, unknown>,
			occurredAt: event.occurredAt,
			attempts: 0,
		});
		this.em.persist(row);
	}

	/** Claims a batch of due messages with FOR UPDATE SKIP LOCKED (multi-publisher safe). */
	async claimDueBatch(limit: number, now: Date): Promise<OutboxMessage[]> {
		const rows = await this.em.execute(
			`SELECT * FROM outbox_messages
			 WHERE published_at IS NULL
			   AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
			 ORDER BY occurred_at ASC
			 LIMIT ${limit}
			 FOR UPDATE SKIP LOCKED`,
			[now],
			"all",
		);
		return rows.map((row: Record<string, unknown>) => toDomain(row));
	}

	/** Persists publication state of a domain message. */
	async save(message: OutboxMessage): Promise<void> {
		await this.em.nativeUpdate(
			OutboxMessageEntity,
			{ id: message.id },
			{
				attempts: message.attempts,
				nextAttemptAt: message.nextAttemptAt ?? null,
				publishedAt: message.publishedAt ?? null,
			},
		);
	}

	async oldestPendingOccurredAt(): Promise<Date | null> {
		const rows = await this.em.execute(
			`SELECT occurred_at FROM outbox_messages WHERE published_at IS NULL ORDER BY occurred_at ASC LIMIT 1`,
			[],
			"all",
		);
		const first = rows[0] as { occurred_at: Date } | undefined;
		return first?.occurred_at instanceof Date ? first.occurred_at : null;
	}
}

export function toDomain(row: Record<string, unknown>): OutboxMessage {
	const state: OutboxMessageState = {
		id: String(row.id),
		aggregateId: String(row.aggregate_id),
		eventType: String(row.event_type),
		payload: (row.payload ?? {}) as Record<string, unknown>,
		occurredAt: new Date(String(row.occurred_at)),
		attempts: Number(row.attempts ?? 0),
		nextAttemptAt: row.next_attempt_at ? new Date(String(row.next_attempt_at)) : undefined,
		publishedAt: row.published_at ? new Date(String(row.published_at)) : undefined,
	};
	return OutboxMessage.rehydrate(state);
}
