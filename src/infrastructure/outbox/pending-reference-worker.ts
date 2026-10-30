import type { MikroORM } from "@mikro-orm/postgresql";
import { ProcessWagerTransactionUseCase } from "../../application/wagering/process-wager-transaction";
import { childLogger } from "../observability/logger";
import { metrics } from "../observability/metrics";

export interface PendingReferenceWorkerOptions {
	batchSize: number;
	intervalMs: number;
}

const DEFAULTS: PendingReferenceWorkerOptions = { batchSize: 25, intervalMs: 1000 };

/**
 * Scans PENDING_REFERENCE rows whose backoff elapsed and re-runs them through
 * the shared use case (each candidate in its own SQL transaction). Two workers
 * in different instances cannot pick the same row: SELECT ... FOR UPDATE SKIP LOCKED.
 */
export class PendingReferenceWorker {
	private running = false;
	private readonly log = childLogger({ component: "pending-reference-worker" });
	private timer: NodeJS.Timeout | undefined;

	constructor(
		private readonly orm: MikroORM,
		private readonly useCase: ProcessWagerTransactionUseCase,
		private readonly options: PendingReferenceWorkerOptions = DEFAULTS,
	) {}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
		this.timer.unref?.();
		this.log.info("pending-reference worker started");
	}

	async stop(): Promise<void> {
		this.running = false;
		if (this.timer) clearInterval(this.timer);
	}

	async tick(): Promise<void> {
		if (!this.running) return;
		const em = this.orm.em.fork();
		try {
			const rows = await em.execute<{ id: string }[]>(
				`SELECT id FROM wager_transactions
				 WHERE status = 'PENDING_REFERENCE'
				   AND reference_next_attempt_at <= now()
				 ORDER BY reference_next_attempt_at ASC
				 LIMIT ${this.options.batchSize}
				 FOR UPDATE SKIP LOCKED`,
				[],
				"all",
			);
			const ids = (rows as unknown as { id: string }[]).map((r) => r.id);
			if (ids.length === 0) return;
			for (const id of ids) {
				try {
					const outcome = await this.useCase.resumePending(id);
					if (outcome === "unschedulable") {
						continue;
					}
					this.log.info({ transactionId: id, outcome: outcome.type }, "pending reference resolved");
					if (outcome.type === "REJECTED") {
						this.log.warn({ transactionId: id, failureCode: outcome.failureCode }, "pending reference exhausted");
					}
				} catch (error) {
					this.log.error({ err: error, transactionId: id }, "pending reference resume failed");
					metrics().retriesTotal.inc({ stage: "pending_reference" });
				}
			}
		} catch (error) {
			this.log.error({ err: error }, "pending reference scan failed");
		}
	}
}
