import client from "prom-client";

export interface AppMetrics {
	registry: client.Registry;
	transactionsTotal: client.Counter<"status" | "kind" | "channel">;
	idempotentReplaysTotal: client.Counter;
	idempotencyConflictsTotal: client.Counter;
	duplicatesDetectedTotal: client.Counter;
	retriesTotal: client.Counter<"stage">;
	dlqMessagesTotal: client.Counter;
	lockConflictsTotal: client.Counter;
	outboxPublishedTotal: client.Counter;
	outboxLagMs: client.Gauge;
	outboxStaleCount: client.Gauge;
	processingLatencyMs: client.Histogram<"channel">;
	reconciliationMismatchesTotal: client.Counter;
	walletsTotal: client.Gauge;
	pendingReferenceCount: client.Gauge;
	inboxProcessedTotal: client.Counter;
}

let metricsInstance: AppMetrics | undefined;

export function metrics(): AppMetrics {
	if (metricsInstance) return metricsInstance;
	const registry = new client.Registry();
	registry.setDefaultLabels({ app: "wager-wallet-service" });
	client.collectDefaultMetrics({ register: registry, prefix: "process_" });

	metricsInstance = {
		registry,
		transactionsTotal: new client.Counter({
			name: "wager_transactions_total",
			help: "Wager transactions processed by terminal/nonterminal status",
			labelNames: ["status", "kind", "channel"] as const,
			registers: [registry],
		}),
		idempotentReplaysTotal: new client.Counter({
			name: "wager_idempotent_replays_total",
			help: "Replays returning the original result",
			registers: [registry],
		}),
		idempotencyConflictsTotal: new client.Counter({
			name: "wager_idempotency_conflicts_total",
			help: "Same idempotency key with diverging payload",
			registers: [registry],
		}),
		duplicatesDetectedTotal: new client.Counter({
			name: "wager_duplicates_detected_total",
			help: "Duplicated deliveries detected by inbox or transaction identity",
			registers: [registry],
		}),
		retriesTotal: new client.Counter({
			name: "wager_retries_total",
			help: "Retries by stage (sqs_visibility, outbox_publish, pending_reference)",
			labelNames: ["stage"] as const,
			registers: [registry],
		}),
		dlqMessagesTotal: new client.Counter({
			name: "wager_dlq_messages_total",
			help: "Messages moved to DLQ",
			registers: [registry],
		}),
		lockConflictsTotal: new client.Counter({
			name: "wager_lock_conflicts_total",
			help: "Concurrency conflicts (lock timeouts, serialization failures)",
			registers: [registry],
		}),
		outboxPublishedTotal: new client.Counter({
			name: "wager_outbox_published_total",
			help: "Outbox messages successfully published",
			registers: [registry],
		}),
		outboxLagMs: new client.Gauge({
			name: "wager_outbox_lag_ms",
			help: "Age of the oldest unpublished outbox message",
			registers: [registry],
		}),
		outboxStaleCount: new client.Gauge({
			name: "wager_outbox_stale_messages",
			help: "Outbox messages pending for more than 60s",
			registers: [registry],
		}),
		processingLatencyMs: new client.Histogram({
			name: "wager_processing_latency_ms",
			help: "Wager transaction processing latency",
			labelNames: ["channel"] as const,
			buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
			registers: [registry],
		}),
		reconciliationMismatchesTotal: new client.Counter({
			name: "wager_reconciliation_mismatches_total",
			help: "Wallet/ledger divergence checks that did not pass",
			registers: [registry],
		}),
		walletsTotal: new client.Gauge({
			name: "wager_wallets_total",
			help: "Wallets created (cumulative, this process)",
			registers: [registry],
		}),
		pendingReferenceCount: new client.Gauge({
			name: "wager_pending_reference_count",
			help: "Transactions with unresolved references",
			registers: [registry],
		}),
		inboxProcessedTotal: new client.Counter({
			name: "wager_inbox_processed_total",
			help: "Inbox messages processed (committed)",
			registers: [registry],
		}),
	};

	return metricsInstance;
}
