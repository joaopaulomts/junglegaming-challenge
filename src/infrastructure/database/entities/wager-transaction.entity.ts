import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "wager_transactions" })
export class WagerTransactionEntity {
	@PrimaryKey({ type: "uuid" })
	id!: string;

	@Property({ name: "provider_id", type: "text" })
	providerId!: string;

	@Property({ name: "external_transaction_id", type: "text" })
	externalTransactionId!: string;

	@Property({ name: "idempotency_key", type: "text" })
	idempotencyKey!: string;

	@Property({ name: "payload_hash", type: "char", length: 64 })
	payloadHash!: string;

	@Property({ name: "wallet_id", type: "uuid" })
	walletId!: string;

	@Property({ name: "player_id", type: "text" })
	playerId!: string;

	@Property({ name: "round_id", type: "text" })
	roundId!: string;

	@Property({ name: "game_id", type: "text" })
	gameId!: string;

	@Property({ type: "text" })
	kind!: string;

	@Property({ name: "amount", type: "numeric", precision: 14, scale: 2 })
	amount!: string;

	@Property({ type: "text" })
	currency!: string;

	@Property({
		name: "reference_external_transaction_id",
		type: "text",
		nullable: true,
	})
	referenceExternalTransactionId?: string;

	@Property({ type: "text" })
	status!: string;

	@Property({ name: "reference_transaction_id", type: "uuid", nullable: true })
	referenceTransactionId?: string;

	@Property({ name: "failure_code", type: "text", nullable: true })
	failureCode?: string;

	@Property({ name: "processed_at", type: "timestamptz", nullable: true })
	processedAt?: Date;

	@Property({ name: "resulting_balance", type: "numeric", precision: 14, scale: 2, nullable: true })
	resultingBalance?: string;

	@Property({ name: "resulting_version", type: "int", nullable: true })
	resultingVersion?: number;

	@Property({ name: "reference_attempts", type: "int" })
	referenceAttempts!: number;

	@Property({ name: "reference_next_attempt_at", type: "timestamptz", nullable: true })
	referenceNextAttemptAt?: Date;

	@Property({ name: "created_at", type: "timestamptz" })
	createdAt!: Date;
}
