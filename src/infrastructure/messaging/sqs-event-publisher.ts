import { SendMessageCommand } from "@aws-sdk/client-sqs";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { EventPublisher } from "../../application/ports/event-publisher";
import { EVENTS_QUEUE_URL } from "./sqs-client";

/**
 * Publishes integration events to the events queue.
 *
 * FIFO attributes given even though the DB outbox is the real guarantee:
 *  - MessageDeduplicationId = eventId      → dedups accidental republications
 *  - MessageGroupId       = aggregateId    → preserves per-wallet event order
 */
export class SqsEventPublisher implements EventPublisher {
	constructor(
		private readonly client: SQSClient,
		private readonly queueUrl: string = EVENTS_QUEUE_URL,
	) {}

	async publish(envelope: Record<string, unknown>): Promise<void> {
		const eventId = String(envelope.eventId ?? "");
		const aggregateId = String(envelope.aggregateId ?? eventId);
		if (eventId.length === 0) {
			throw new Error("event envelope is missing eventId — outbox corruption");
		}
		try {
			await this.client.send(
				new SendMessageCommand({
					QueueUrl: this.queueUrl,
					MessageBody: JSON.stringify(envelope),
					MessageGroupId: aggregateId,
					MessageDeduplicationId: eventId,
				}),
			);
		} catch (error) {
			throw error instanceof Error ? error : new Error(String(error));
		}
	}
}
