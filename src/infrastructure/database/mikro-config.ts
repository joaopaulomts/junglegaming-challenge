import { defineConfig } from "@mikro-orm/postgresql";
import { WalletEntity } from "./entities/wallet.entity";
import { WalletLedgerEntryEntity } from "./entities/ledger-entry.entity";
import { WagerTransactionEntity } from "./entities/wager-transaction.entity";
import { InboxMessageEntity } from "./entities/inbox-message.entity";
import { OutboxMessageEntity } from "./entities/outbox-message.entity";
import { Migration20261030000001 } from "./migrations/Migration20261030000001";

export function databaseConfig(databaseUrl: string, poolMax = 20) {
	return defineConfig({
		clientUrl: databaseUrl,
		entities: [
			WalletEntity,
			WalletLedgerEntryEntity,
			WagerTransactionEntity,
			InboxMessageEntity,
			OutboxMessageEntity,
		],
		extensions: [],

		migrations: {
			migrationsList: [
				{ name: "Migration20261030000001", class: Migration20261030000001 },
			],
			snapshot: false,
		},
		pool: { max: poolMax },
		debug: process.env.NODE_ENV === "development",
	});
}
