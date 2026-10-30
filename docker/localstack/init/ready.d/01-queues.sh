#!/bin/bash
# Creates the SQS queues used by the service.
# - wager-transactions.fifo   : consumer input (at-least-once, redrive to DLQ)
# - wager-transactions-dlq.fifo : poison / transient-exhausted messages
# - integration-events.fifo   : outbox publication target

set -e

LOCALSTACK_HOST="http://localhost:4566"
REGION="sa-east-1"

DLQ_ARN="$(
  awslocal sqs create-queue \
    --queue-name wager-transactions-dlq.fifo \
    --region "$REGION" \
    --attributes '{
      "FifoQueue": "true",
      "ContentBasedDeduplication": "true"
    }' \
    --query 'QueueArn' \
    --output text
)"

awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --region "$REGION" \
  --attributes "$(cat <<EOF
{
  "FifoQueue": "true",
  "ContentBasedDeduplication": "true",
  "VisibilityTimeout": "30",
  "RedrivePolicy": "{\"maxReceiveCount\": 5, \"deadLetterTargetArn\": \"$DLQ_ARN\"}"
}
EOF
)"

awslocal sqs create-queue \
  --queue-name integration-events.fifo \
  --region "$REGION" \
  --attributes '{
    "FifoQueue": "true",
    "ContentBasedDeduplication": "true"
  }'

awslocal sqs list-queues --queue-name-prefix wager --region "$REGION"
awslocal sqs list-queues --queue-name-prefix integration --region "$REGION"
