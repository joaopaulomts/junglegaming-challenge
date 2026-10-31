import { SQSClient } from "@aws-sdk/client-sqs";

export function sqsClient(): SQSClient {
	const endpoint = process.env.SQS_ENDPOINT ?? "http://localhost:4566";
	return new SQSClient({
		region: process.env.AWS_REGION ?? "sa-east-1",
		endpoint,
		credentials: {
			accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
			secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
		},
	});
}

const QUEUE_BASE = "http://sqs.sa-east-1.localhost.localstack.cloud:4566/000000000000";
export const REQUEST_QUEUE_URL = process.env.SQS_REQUEST_QUEUE_URL ?? `${QUEUE_BASE}/wager-transactions.fifo`;
export const DLQ_QUEUE_URL = process.env.SQS_DLQ_QUEUE_URL ?? `${QUEUE_BASE}/wager-transactions-dlq.fifo`;
export const EVENTS_QUEUE_URL = process.env.SQS_EVENTS_QUEUE_URL ?? `${QUEUE_BASE}/integration-events.fifo`;
