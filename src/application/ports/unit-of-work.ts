export interface Repositories {
	readonly wallets: import("../../infrastructure/repositories/wallet.repository").WalletRepository;
	readonly ledger: import("../../infrastructure/repositories/wallet.repository").LedgerEntryRepository;
	readonly transactions: import("../../infrastructure/repositories/wager-transaction.repository").WagerTransactionRepository;
	readonly inbox: import("../../infrastructure/repositories/inbox.repository").InboxRepository;
	readonly outbox: import("../../infrastructure/repositories/outbox.repository").OutboxRepository;
}

/**
 * Every financial write path executes inside exactly one UnitOfWork boundary —
 * one SQL transaction spanning inbox, transaction record, wallet, ledger and outbox.
 * Repositories are resolved *inside* the transaction, bound to the same EntityManager.
 */
export interface UnitOfWork {
	transactional<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
}

export class UnitOfWorkResolutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnitOfWorkResolutionError";
	}
}
