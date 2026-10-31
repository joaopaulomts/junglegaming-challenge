import { MikroORM } from "@mikro-orm/postgresql";
import { WalletRepository, LedgerEntryRepository } from "../../infrastructure/repositories/wallet.repository";
import { WagerTransactionRepository } from "../../infrastructure/repositories/wager-transaction.repository";
import type { WalletLedgerEntry } from "../../domain/wallet/ledger-entry";
import type { Wallet } from "../../domain/wallet/wallet";
import type { WagerTransaction } from "../../domain/wagering/wager-transaction";

export interface WalletView {
	id: string;
	playerId: string;
	balance: { amount: string; currency: string };
	version: number;
}

export interface LedgerEntryView {
	id: string;
	walletId: string;
	transactionId: string;
	direction: string;
	amount: string;
	currency: string;
	balanceBefore: string;
	balanceAfter: string;
	createdAt: string;
}

export interface TransactionView {
	transactionId: string;
	providerId: string;
	externalTransactionId: string;
	status: string;
	kind: string;
	money: { amount: string; currency: string };
	walletId: string;
	playerId: string;
	roundId: string;
	gameId: string;
	referenceExternalTransactionId?: string;
	referenceTransactionId?: string;
	failureCode?: string;
	processedAt?: string;
	resultingBalance?: string;
	resultingWalletVersion?: number;
	createdAt: string;
}

export interface LedgerPage {
	entries: LedgerEntryView[];
	nextCursor?: string;
}

export function walletView(w: Wallet): WalletView {
	return {
		id: w.id,
		playerId: w.playerId,
		balance: w.balance.toJSON(),
		version: w.version,
	};
}

export function transactionView(t: WagerTransaction): TransactionView {
	const base: TransactionView = {
		transactionId: t.id,
		providerId: t.providerId,
		externalTransactionId: t.externalTransactionId,
		status: t.status,
		kind: t.kind,
		money: t.money.toJSON(),
		walletId: t.walletId,
		playerId: t.playerId,
		roundId: t.roundId,
		gameId: t.gameId,
		createdAt: t.createdAt.toISOString(),
	};
	if (t.referenceExternalTransactionId !== undefined) base.referenceExternalTransactionId = t.referenceExternalTransactionId;
	if (t.referenceTransactionId !== undefined) base.referenceTransactionId = t.referenceTransactionId;
	if (t.failureCode !== undefined) base.failureCode = t.failureCode;
	if (t.processedAt !== undefined) base.processedAt = t.processedAt.toISOString();
	if (t.resultingBalance !== undefined) base.resultingBalance = t.resultingBalance.amount;
	if (t.resultingVersion !== undefined) base.resultingWalletVersion = t.resultingVersion;
	return base;
}

export function ledgerEntryView(e: WalletLedgerEntry): LedgerEntryView {
	return {
		id: e.id,
		walletId: e.walletId,
		transactionId: e.transactionId,
		direction: e.direction,
		amount: e.money.toJSON().amount,
		currency: e.money.currency,
		balanceBefore: e.balanceBefore.toJSON().amount,
		balanceAfter: e.balanceAfter.toJSON().amount,
		createdAt: e.createdAt.toISOString(),
	};
}

export function decodeLedgerCursor(raw: string | undefined): { createdAt: Date; id: string } | undefined {
	if (!raw) return undefined;
	try {
		const decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { createdAt: string; id: string };
		return { createdAt: new Date(decoded.createdAt), id: decoded.id };
	} catch {
		return undefined;
	}
}

export function encodeLedgerCursor(entry: { createdAt: Date; id: string }): string {
	return Buffer.from(JSON.stringify({ createdAt: entry.createdAt.toISOString(), id: entry.id }), "utf8").toString("base64url");
}

/** Read-only queries backed by fresh forks of the EntityManager. */
export class QueryService {
	constructor(private readonly orm: MikroORM) {}

	private repos(): { wallets: WalletRepository; ledger: LedgerEntryRepository; transactions: WagerTransactionRepository } {
		const em = this.orm.em.fork();
		return {
			wallets: new WalletRepository(em),
			ledger: new LedgerEntryRepository(em),
			transactions: new WagerTransactionRepository(em),
		};
	}

	async wallet(walletId: string): Promise<WalletView | null> {
		const { wallets } = this.repos();
		const w = await wallets.findById(walletId);
		return w ? walletView(w) : null;
	}

	async ledger(walletId: string, cursor?: string, limit = 50): Promise<LedgerPage | null> {
		const { wallets, ledger } = this.repos();
		const w = await wallets.findById(walletId);
		if (w === null) return null;
		const cur = decodeLedgerCursor(cursor);
		const entries = await ledger.listByWallet(walletId, limit + 1, cur);
		const hasMore = entries.length > limit;
		const page = hasMore ? entries.slice(0, limit) : entries;
		const response: LedgerPage = { entries: page.map(ledgerEntryView) };
		if (hasMore) {
			const last = page[page.length - 1];
			if (last) response.nextCursor = encodeLedgerCursor(last);
		}
		return response;
	}

	async transactionById(id: string): Promise<TransactionView | null> {
		const { transactions } = this.repos();
		const t = await transactions.findById(id);
		return t ? transactionView(t) : null;
	}

	async transactionByProviderExternal(providerId: string, externalTransactionId: string): Promise<TransactionView | null> {
		const { transactions } = this.repos();
		const t = await transactions.findByProviderExternal(providerId, externalTransactionId);
		return t ? transactionView(t) : null;
	}
}
