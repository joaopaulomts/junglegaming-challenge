import { Entity, PrimaryKey, Property } from "@mikro-orm/core";

@Entity({ tableName: "wallet_ledger_entries" })
export class WalletLedgerEntryEntity {
	@PrimaryKey({ type: "uuid" })
	id!: string;

	@Property({ name: "wallet_id", type: "uuid" })
	walletId!: string;

	@Property({ name: "transaction_id", type: "uuid" })
	transactionId!: string;

	@Property({ type: "text" })
	direction!: string;

	@Property({ type: "numeric", precision: 14, scale: 2 })
	amount!: string;

	@Property({ type: "text" })
	currency!: string;

	@Property({ name: "balance_before", type: "numeric", precision: 14, scale: 2 })
	balanceBefore!: string;

	@Property({ name: "balance_after", type: "numeric", precision: 14, scale: 2 })
	balanceAfter!: string;

	@Property({ name: "created_at", type: "timestamptz" })
	createdAt!: Date;
}
