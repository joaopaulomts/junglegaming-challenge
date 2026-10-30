import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "inbox_messages" })
export class InboxMessageEntity {
	/** surrogate key */
	@PrimaryKey({ type: "bigserial" })
	id!: number;

	@Property({ name: "message_id", type: "text" })
	messageId!: string;

	@Property({ name: "consumer_name", type: "text" })
	consumerName!: string;

	@Property({ name: "payload_hash", type: "char", length: 64 })
	payloadHash!: string;

	@Property({ name: "received_at", type: "timestamptz" })
	receivedAt!: Date;

	@Property({ name: "processed_at", type: "timestamptz", nullable: true })
	processedAt?: Date;
}
