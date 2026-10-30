import type { MikroORM, EntityManager } from "@mikro-orm/postgresql";
import { OutboxRepository } from "../repositories/outbox.repository";
import type { EventPublisher } from "../../application/ports/event-publisher";
import { OutboxMessage } from "../../domain/outbox/outbox-message";
import { childLogger } from "../observability/logger";
import { metrics } from "../observability/metrics";

export interface OutboxWorkerOptions {
	batchSize: number;
	intervalMs: number;
}

const DEFAULTS: OutboxWorkerOptions = { batchSize: 50, intervalMs: 500 };

/**
 * Transactional outbox publisher.
 *
 * Locks a batch FOR UPDATE SKIP LOCKED (safe across concurrent publishers),
 * publishes each envelope, marks published in the same SQL transaction. A crash
 * after publish and before commit causes redelivery — safe because
 * MessageDeduplicationId = eventId and downstream dedups by inbox.
 */
export class OutboxWorker {
	private running = false;
	private readonly log = childLogger({ component: "outbox-worker" });
	private timer: NodeJS.Timeout | undefined;

	constructor(
		private readonly orm: MikroORM,
		private readonly publisher: EventPublisher,
		private readonly options: OutboxWorkerOptions = DEFAULTS,
	) {}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
		this.timer.unref?.();
		this.log.info("outbox worker started");
	}

	async stop(): Promise<void> {
		this.running = false;
		if (this.timer) clearInterval(this.timer);
	}

	async tick(): Promise<void> {
		if (!this.running) return;
		const em = this.orm.em.fork();
		try {
			const outboxRepo = new OutboxRepository(em);
			const now = new Date();
			const pending = await outboxRepo.claimDueBatch(this.options.batchSize, now);
			if (pending.length === 0) {
				await this.observeLag(em);
				return;
			}
			for (const message of pending) {
				try {
					await this.publisher.publish(message.payload);
					message.markPublished(new Date());
					await outboxRepo.save(message);
					this.log.info({ eventId: message.id, eventType: message.eventType, attempts: message.attempts }, "outbox published");
					metrics().outboxPublishedTotal.inc();
				} catch (error) {
					const current = message;
					current.scheduleRetry(now);
					await outboxRepo.save(current);
					this.log.warn({ err: error, outboxId: current.id, attempts: current.attempts }, "outbox publish failed — scheduled retry");
					metrics().retriesTotal.inc({ stage: "outbox_publish" });
				}
			}
			await this.observeLag(em);
		} catch (error) {
			this.log.error({ err: error }, "outbox worker tick failed");
		}
	}

	private async observeLag(em: EntityManager): Promise<void> {
		const outboxRepo = new OutboxRepository(em);
		const oldest = await outboxRepo.oldestPendingOccurredAt();
		if (oldest) {
			metrics().outboxLagMs.set(Math.max(0, Date.now() - oldest.getTime()));
		} else {
			metrics().outboxLagMs.set(0);
		}
	}
}

export type { OutboxMessage };
