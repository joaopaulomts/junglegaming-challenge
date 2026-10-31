import { Module } from "@nestjs/common";
import { SQSClient } from "@aws-sdk/client-sqs";
import { sqsClient } from "../infrastructure/messaging/sqs-client";

/**
 * Single shared SQS client for the HTTP process (outbox publisher, SQS
 * consumer and readiness probe). One client => one agent pool per process.
 */
@Module({
	providers: [{ provide: SQSClient, useFactory: sqsClient }],
	exports: [SQSClient],
})
export class SqsClientModule {}
