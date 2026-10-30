import type { UnitOfWork, Repositories } from "../../application/ports/unit-of-work";
import {
	WalletRepository,
	LedgerEntryRepository,
} from "../../infrastructure/repositories/wallet.repository";
import { WagerTransactionRepository } from "../../infrastructure/repositories/wager-transaction.repository";
import { InboxRepository } from "../../infrastructure/repositories/inbox.repository";
import { OutboxRepository } from "../../infrastructure/repositories/outbox.repository";

export class MikroUnitOfWork implements UnitOfWork {
	constructor(private readonly em: import("@mikro-orm/postgresql").EntityManager) {}

	async transactional<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
		return await this.em.transactional(async () => {
			const repositories: Repositories = {
				wallets: new WalletRepository(this.em),
				ledger: new LedgerEntryRepository(this.em),
				transactions: new WagerTransactionRepository(this.em),
				inbox: new InboxRepository(this.em),
				outbox: new OutboxRepository(this.em),
			};
			return await work(repositories);
		});
	}
}
