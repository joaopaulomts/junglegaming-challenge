export interface EventPublisher {
	/** Publishes one serialized envelope. Returns after accepted by the broker. */
	publish(envelope: Record<string, unknown>): Promise<void>;
}

export class LoggingEventPublisher implements EventPublisher {
	constructor(private readonly log: { info(msg: string, meta?: unknown): void }) {}

	async publish(envelope: Record<string, unknown>): Promise<void> {
		this.log.info("event published (logging publisher)", { eventType: envelope.eventType, eventId: envelope.eventId });
	}
}
