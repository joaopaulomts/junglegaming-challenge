import type { EntityManager } from "@mikro-orm/postgresql";
import { InboxMessageEntity } from "../database/entities/inbox-message.entity";
import { InboxMessage } from "../../domain/inbox/inbox-message";

export type InboxClaim = "claimed" | "alreadyProcessed" | "inFlight";

export class InboxRepository {
	constructor(private readonly em: EntityManager) {}

	/**
	 * Registers the message delivery inside the caller's SQL transaction.
	 * The UNIQUE (consumer_name, message_id) index is the persistent dedup:
	 * - "claimed": first delivery of this message (or previous attempt crashed before commit) — process it
	 * - "alreadyProcessed": fully handled before — safe to ack
	 * - "inFlight": another transaction inserted but has not committed yet — commit a NO-OP
	 *   and return without ack (SQS will redeliver).
	 */
	async claim(messageId: string, consumerName: string, payloadHash: string): Promise<InboxClaim> {
		const now = new Date();
		await this.em.execute(
			`INSERT INTO inbox_messages (message_id, consumer_name, payload_hash, received_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT (consumer_name, message_id) DO NOTHING`,
			[messageId, consumerName, payloadHash, now],
		);
		const row = await this.em.findOne(InboxMessageEntity, { messageId, consumerName });
		if (!row) return "claimed";
		return row.processedAt !== null && row.processedAt !== undefined ? "alreadyProcessed" : "inFlight";
	}

	async markProcessed(messageId: string, consumerName: string, at: Date): Promise<void> {
		await this.em.nativeUpdate(
			InboxMessageEntity,
			{ messageId, consumerName },
			{ processedAt: at },
		);
	}
}
