#!/bin/bash
# Creates the SQS queues used by the service.
# - wager-transactions.fifo   : consumer input (at-least-once, redrive to DLQ)
# - wager-transactions-dlq.fifo : poison / transient-exhausted messages
# - integration-events.fifo   : outbox publication target
#
# The DLQ ARN is written literally (account 000000000000 is fixed in
# LocalStack) to avoid shell-expansion/quoting pitfalls in JSON attributes.

set -e

REGION="sa-east-1"
DLQ_ARN="arn:aws:sqs:${REGION}:000000000000:wager-transactions-dlq.fifo"

awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --region "$REGION" \
  --attributes '{"FifoQueue": "true", "ContentBasedDeduplication": "true"}'

awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --region "$REGION" \
  --attributes "{\"FifoQueue\": \"true\", \"ContentBasedDeduplication\": \"true\", \"VisibilityTimeout\": \"30\", \"RedrivePolicy\": \"{\\\"maxReceiveCount\\\": 5, \\\"deadLetterTargetArn\\\": \\\"$DLQ_ARN\\\"}\"}"

awslocal sqs create-queue \
  --queue-name integration-events.fifo \
  --region "$REGION" \
  --attributes '{"FifoQueue": "true", "ContentBasedDeduplication": "true"}'

awslocal sqs get-queue-attributes \
  --queue-url "http://sqs.${REGION}.localhost.localstack.cloud:4566/000000000000/wager-transactions.fifo" \
  --attribute-names RedrivePolicy --region "$REGION"
