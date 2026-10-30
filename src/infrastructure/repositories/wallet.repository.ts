import { LockMode } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import { Wallet, type WalletState } from "../../domain/wallet/wallet";
import { WalletEntity } from "../database/entities/wallet.entity";
import { WalletLedgerEntry, type LedgerEntryState } from "../../domain/wallet/ledger-entry";
import { WalletLedgerEntryEntity } from "../database/entities/ledger-entry.entity";
import { Money } from "../../domain/shared/money";
import { WalletMutationResult } from "../../domain/wallet/wallet";

export class WalletRepository {
	constructor(private readonly em: EntityManager) {}

	/** Loads and locks the wallet row (SELECT ... FOR UPDATE) for the caller's transaction. */
	async lockById(id: string): Promise<Wallet | null> {
		const row = await this.em.findOne(
			WalletEntity,
			{ id },
			{ lockMode: LockMode.PESSIMISTIC_WRITE },
		);
		if (!row) return null;
		return toWallet(row);
	}

	async findById(id: string): Promise<Wallet | null> {
		const row = await this.em.findOne(WalletEntity, { id });
		return row ? toWallet(row) : null;
	}

	async insert(wallet: Wallet): Promise<void> {
		const row = this.em.create(WalletEntity, {
			id: wallet.id,
			playerId: wallet.playerId,
			currency: wallet.currency,
			balance: wallet.balance.toJSON().amount,
			version: wallet.version,
		});
		this.em.persist(row);
	}

	async applyMutation(wallet: Wallet, result: WalletMutationResult, at: Date): Promise<void> {
		const row = await this.em.findOneOrFail(WalletEntity, { id: wallet.id });
		row.balance = result.balanceAfter.toJSON().amount;
		row.version = result.walletVersion;
		row.updatedAt = at;
	}

	async mutateBalance(id: string, balance: string, version: number, at: Date): Promise<void> {
		await this.em.nativeUpdate(
			WalletEntity,
			{ id },
			{ balance, version, updatedAt: at },
			{},
		);
	}
}

export function toWallet(row: WalletEntity): Wallet {
	const state: WalletState = {
		id: row.id,
		playerId: row.playerId,
		currency: row.currency,
		balance: { amount: row.balance, currency: row.currency },
		version: row.version,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
	return Wallet.rehydrate(state);
}

export class LedgerEntryRepository {
	constructor(private readonly em: EntityManager) {}

	async insert(entry: WalletLedgerEntry): Promise<void> {
		const row = this.em.create(WalletLedgerEntryEntity, {
			id: entry.id,
			walletId: entry.walletId,
			transactionId: entry.transactionId,
			direction: entry.direction,
			amount: entry.money.toJSON().amount,
			currency: entry.money.currency,
			balanceBefore: entry.balanceBefore.toJSON().amount,
			balanceAfter: entry.balanceAfter.toJSON().amount,
			createdAt: entry.createdAt,
		});
		this.em.persist(row);
	}

	async listByWallet(walletId: string, limit: number, afterCursor?: { createdAt: Date; id: string }): Promise<WalletLedgerEntry[]> {
		const rows = await this.em.find(
			WalletLedgerEntryEntity,
			afterCursor
				? { walletId, createdAt: { $lt: afterCursor.createdAt }, id: { $lt: afterCursor.id } }
				: { walletId },
			{ orderBy: [{ createdAt: "desc" }, { id: "desc" }], limit },
		);
		return rows.map(toLedgerEntry);
	}

	async balanceAfter(walletId: string): Promise<Money | null> {
		const rows = await this.em.find(
			WalletLedgerEntryEntity,
			{ walletId },
			{ orderBy: [{ createdAt: "desc" }, { id: "desc" }], limit: 1 },
		);
		if (rows.length === 0) return null;
		const first = rows[0];
		if (!first) return null;
		return Money.from({ amount: first.balanceAfter, currency: first.currency });
	}

	async countByWallet(walletId: string): Promise<number> {
		return await this.em.count(WalletLedgerEntryEntity, { walletId });
	}
}

export function toLedgerEntry(row: WalletLedgerEntryEntity): WalletLedgerEntry {
	const currency = row.currency;
	const state: LedgerEntryState = {
		id: row.id,
		walletId: row.walletId,
		transactionId: row.transactionId,
		direction: row.direction as LedgerEntryState["direction"],
		money: { amount: row.amount, currency },
		balanceBefore: { amount: row.balanceBefore, currency },
		balanceAfter: { amount: row.balanceAfter, currency },
		createdAt: row.createdAt,
	};
	return WalletLedgerEntry.rehydrate(state);
}
