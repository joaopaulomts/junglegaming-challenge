import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "outbox_messages" })
export class OutboxMessageEntity {
	@PrimaryKey({ type: "uuid" })
	id!: string;

	@Property({ name: "aggregate_id", type: "text" })
	aggregateId!: string;

	@Property({ name: "event_type", type: "text" })
	eventType!: string;

	@Property({ type: "jsonb" })
	payload!: Record<string, unknown>;

	@Property({ name: "occurred_at", type: "timestamptz" })
	occurredAt!: Date;

	@Property({ type: "int" })
	attempts!: number;

	@Property({ name: "next_attempt_at", type: "timestamptz", nullable: true })
	nextAttemptAt?: Date;

	@Property({ name: "published_at", type: "timestamptz", nullable: true })
	publishedAt?: Date;
}
