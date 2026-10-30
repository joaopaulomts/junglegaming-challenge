import {
	ChangeMessageVisibilityCommand,
	DeleteMessageCommand,
	ReceiveMessageCommand,
	SendMessageCommand,
} from "@aws-sdk/client-sqs";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { Message } from "@aws-sdk/client-sqs";
import type { MoneyProps } from "../../domain/shared/money";
import type { ProcessWagerTransactionUseCase, WagerProcessingOutcome } from "../../application/wagering/process-wager-transaction";
import { MessageInFlightError } from "../../application/wagering/process-wager-transaction";
import { IdempotencyConflictError } from "../../application/errors";
import { errorClassOf } from "./consumer-errors";
import { runWithCorrelation } from "../observability/correlation";
import { childLogger } from "../observability/logger";
import { metrics } from "../observability/metrics";
import { sha256Hex } from "../../application/shared/canonical-payload-hash";
import { newCorrelationId } from "../../application/shared/ids";
import { REQUEST_QUEUE_URL } from "./sqs-client";

export interface WagerRequestedEnvelope {
	messageId: string;
	type: string;
	occurredAt: string;
	data: {
		providerId: string;
		externalTransactionId: string;
		idempotencyKey: string;
		playerId: string;
		walletId: string;
		roundId: string;
		gameId: string;
		kind: string;
		money: MoneyProps;
		referenceExternalTransactionId?: string;
	};
}

export interface ConsumerOptions {
	requestQueueUrl: string;
	dlqQueueUrl: string;
	maxReceiveCount: number;
	receiveBatchSize: number;
	waitTimeSeconds: number;
	stopGraceMs: number;
}

export const DEFAULT_CONSUMER_OPTIONS: ConsumerOptions = {
	requestQueueUrl: REQUEST_QUEUE_URL,
	dlqQueueUrl: process.env.SQS_DLQ_QUEUE_URL ?? "http://sqs.localhost.localstack.cloud:4566/000000000000/wager-transactions-dlq.fifo",
	maxReceiveCount: Number(process.env.SQS_MAX_RECEIVE_COUNT ?? 5),
	receiveBatchSize: 10,
	waitTimeSeconds: 10,
	stopGraceMs: 15000,
};

export class WagerSqsConsumer {
	private running = false;
	private stopping = false;
	private inFlight = new Set<Promise<void>>();
	private loop: Promise<void> | undefined;
	private readonly log = childLogger({ component: "sqs-consumer" });

	constructor(
		private readonly sqs: SQSClient,
		private readonly useCase: ProcessWagerTransactionUseCase,
		private readonly consumerName: string,
		private readonly options: ConsumerOptions = DEFAULT_CONSUMER_OPTIONS,
	) {}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.loop = this.pollLoop();
		this.log.info({ queue: this.options.requestQueueUrl }, "sqs consumer started");
	}

	async stop(): Promise<void> {
		this.stopping = true;
		this.log.info("sqs consumer stopping (SIGTERM) — finishing in-flight messages");
		const deadline = Date.now() + this.options.stopGraceMs;
		while (this.inFlight.size > 0 && Date.now() < deadline) {
			await sleep(100);
		}
		this.running = false;
		await (this.loop ?? Promise.resolve());
		this.log.info("sqs consumer stopped");
	}

	private async pollLoop(): Promise<void> {
		while (!this.stopping) {
			try {
				const received = await this.receiveBatch();
				if (received.length > 0) {
					for (const message of received) {
						const handler = this.handleMessage(message);
						this.inFlight.add(handler);
						void (async () => {
							try {
								await handler;
							} finally {
								this.inFlight.delete(handler);
							}
						})();
					}
				}
			} catch (error) {
				this.log.error({ err: error }, "poll loop failed — backoff before retrying");
				await sleep(1000);
			}
		}
	}

	private async receiveBatch(): Promise<Message[]> {
		const result = await this.sqs.send(
			new ReceiveMessageCommand({
				QueueUrl: this.options.requestQueueUrl,
				MaxNumberOfMessages: this.options.receiveBatchSize,
				WaitTimeSeconds: this.options.waitTimeSeconds,
				AttributeNames: ["All"],
				MessageAttributeNames: ["All"],
			}),
		);
		return result.Messages ?? [];
	}

	private async handleMessage(message: Message): Promise<void> {
		const body = message.Body ?? "";
		let envelope: WagerRequestedEnvelope;
		try {
			envelope = JSON.parse(body) as WagerRequestedEnvelope;
		} catch {
			await this.poison(message, "unparsable_json", "message body is not valid JSON");
			return;
		}

		if (envelope.type !== "WagerTransactionRequested") {
			await this.poison(message, "unknown_message_type", `unexpected message type ${envelope.type}`);
			return;
		}

		const messageId = envelope.messageId || message.MessageId || "";
		const payloadHash = sha256Hex(body);
		const attemptCount = Number(message.Attributes?.ApproximateReceiveCount ?? "0") + 1;

		if (attemptCount > this.options.maxReceiveCount) {
			// belt beyond the redrive policy: keep the audit trail in the DLQ
			await this.poison(message, "attempts_exhausted", `received ${attemptCount} times (limit ${this.options.maxReceiveCount})`);
			this.log.error({ messageId, attemptCount }, "message moved to DLQ after retry exhaustion");
			return;
		}

		const started = Date.now();
		await runWithCorrelation({ correlationId: newCorrelationId(), messageId, providerId: envelope.data.providerId }, async () => {
			const log = childLogger();
			try {
				const outcome = await this.useCase.execute({
					providerId: envelope.data.providerId,
					externalTransactionId: envelope.data.externalTransactionId,
					idempotencyKey: envelope.data.idempotencyKey ?? `${envelope.data.providerId}:${envelope.data.externalTransactionId}`,
					playerId: envelope.data.playerId,
					walletId: envelope.data.walletId,
					roundId: envelope.data.roundId,
					gameId: envelope.data.gameId,
					kind: envelope.data.kind,
					money: envelope.data.money,
					referenceExternalTransactionId: envelope.data.referenceExternalTransactionId,
					correlationId: messageId,
					messageId,
					messagePayloadHash: payloadHash,
				});
				metrics().processingLatencyMs.observe({ channel: "sqs" }, Date.now() - started);
				metrics().transactionsTotal.inc({ status: outcome.type, kind: envelope.data.kind, channel: "sqs" });
				metrics().inboxProcessedTotal.inc();
				log.info({ outcome }, "message processed — ack");
				await this.ack(message);
			} catch (error) {
				await this.handleFailure(message, error, messageId, attemptCount, log);
			}
		});
	}

	private async handleFailure(
		message: Message,
		error: unknown,
		messageId: string,
		attemptCount: number,
		log: ReturnType<typeof childLogger>,
	): Promise<void> {
		if (error instanceof MessageInFlightError) {
			// another worker holds this message; stay silent, SQS will redeliver
			log.debug({ messageId }, "message already in flight elsewhere");
			return;
		}
		const classification = errorClassOf(error);
		metrics().duplicatesDetectedTotal.inc();
		if (classification === "permanent") {
			if (error instanceof IdempotencyConflictError) {
				log.error({ messageId, err: error }, "idempotency conflict — moving to DLQ");
			} else {
				log.error({ messageId, err: error }, "permanent consumer failure — moving to DLQ");
			}
			await this.poison(message, "permanent_failures", error instanceof Error ? error.message : String(error));
			return;
		}
		metrics().retriesTotal.inc({ stage: "sqs_visibility" });
		log.warn({ messageId, attemptCount, err: error }, "transient failure — returning message to visibility");
		if (this.stopping) {
			await this.sqs.send(
				new ChangeMessageVisibilityCommand({
					QueueUrl: this.options.requestQueueUrl,
					ReceiptHandle: message.ReceiptHandle ?? "",
					VisibilityTimeout: 0,
				}),
			).catch(() => undefined);
		}
	}

	/** Business outcomes (PROCESSED/REJECTED/PENDING_REFERENCE) are terminal — ack after commit. */
	private async ack(message: Message): Promise<void> {
		await this.sqs.send(
			new DeleteMessageCommand({
				QueueUrl: this.options.requestQueueUrl,
				ReceiptHandle: message.ReceiptHandle ?? "",
			}),
		);
	}

	/** Copies the message to the DLQ (FIFO), then acks on the source queue. */
	private async poison(message: Message, reason: string, detail: string): Promise<void> {
		const receipt = message.MessageId ?? "";
		try {
			await this.sqs.send(
				new SendMessageCommand({
					QueueUrl: this.options.dlqQueueUrl,
					MessageBody: message.Body ?? "",
					MessageGroupId: this.consumerName,
					MessageDeduplicationId: `${this.consumerName}:${receipt}:poison:${reason}`,
					MessageAttributes: {
						poisonReason: { DataType: "String", StringValue: reason },
						poisonDetail: { DataType: "String", StringValue: detail.slice(0, 1000) },
					},
				}),
			);
			metrics().dlqMessagesTotal.inc();
			await this.ack(message);
			this.log.warn({ messageId: receipt, reason }, "message moved to DLQ and acked");
		} catch (error) {
			this.log.error({ err: error, messageId: receipt }, "failed to move message to DLQ — will redeliver");
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { WagerProcessingOutcome };
