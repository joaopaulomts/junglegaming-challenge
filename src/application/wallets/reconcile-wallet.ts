import { Money, type MoneyProps } from "../../domain/shared/money";
import { Wallet } from "../../domain/wallet/wallet";
import type { UnitOfWork } from "../ports/unit-of-work";
import { AggregateNotFoundError } from "../errors";
import type { WalletLedgerEntry } from "../../domain/wallet/ledger-entry";
import { LedgerDirection } from "../../domain/wallet/ledger-direction";

export interface ReconciliationReport {
	walletId: string;
	storedBalance: MoneyProps;
	calculatedBalance: MoneyProps;
	difference: MoneyProps;
	consistent: boolean;
	checkedEntries: number;
}

const PAGE_SIZE = 500;

/**
 * Rebuilds the wallet balance from immutable ledger entries and compares it with
 * the materialized balance. Divergences are never corrected here: the caller logs,
 * records a metric and surfaces the inconsistency in the response.
 */
export class ReconcileWalletUseCase {
	constructor(private readonly uow: UnitOfWork) {}

	async execute(walletId: string): Promise<ReconciliationReport> {
		return await this.uow.transactional(async (repos) => {
			const wallet = await repos.wallets.findById(walletId);
			if (wallet === null) {
				throw new AggregateNotFoundError("wallet", walletId);
			}
			return await reconcile(repos, wallet);
		});
	}
}

interface ReconcileRepos {
	wallets: { findById(id: string): Promise<Wallet | null> };
	ledger: {
		listByWallet(walletId: string, limit: number, strictlyOlderThan?: { createdAt: Date; id: string }): Promise<WalletLedgerEntry[]>;
		countByWallet(walletId: string): Promise<number>;
	};
}

export async function reconcile(repos: ReconcileRepos, wallet: Wallet): Promise<ReconciliationReport> {
	const total = await repos.ledger.countByWallet(wallet.id);
	let calculated = Money.zero(wallet.currency);
	let checkedEntries = 0;
	let cursor: { createdAt: Date; id: string } | undefined;

	while (checkedEntries < total) {
		const entries = await repos.ledger.listByWallet(wallet.id, PAGE_SIZE, cursor);
		if (entries.length === 0) break;
		for (const entry of entries) {
			calculated = entry.direction === LedgerDirection.Credit ? calculated.add(entry.money) : calculated.subtract(entry.money);
			checkedEntries += 1;
		}
		const oldestInPage = entries[entries.length - 1];
		if (oldestInPage === undefined) break;
		cursor = { createdAt: oldestInPage.createdAt, id: oldestInPage.id };
	}

	const stored = wallet.balance;
	const difference = stored.subtract(calculated);
	return {
		walletId: wallet.id,
		storedBalance: stored.toJSON(),
		calculatedBalance: calculated.toJSON(),
		difference: difference.toJSON(),
		consistent: difference.isZero(),
		checkedEntries,
	};
}
