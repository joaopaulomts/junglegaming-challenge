import { Money, type MoneyProps } from "../../domain/shared/money";
import { Wallet } from "../../domain/wallet/wallet";
import { WalletLedgerEntry } from "../../domain/wallet/ledger-entry";
import { LedgerDirection } from "../../domain/wallet/ledger-direction";
import { WagerTransaction } from "../../domain/wagering/wager-transaction";
import { WagerTransactionKind } from "../../domain/wagering/kinds";
import type { UnitOfWork, Repositories } from "../ports/unit-of-work";
import { newId, newEventId } from "../shared/ids";
import { uniqueViolatorOf } from "../../infrastructure/database/pg-errors";
import { sha256Hex } from "../shared/canonical-payload-hash";
import { WalletAlreadyExistsError } from "../errors";
import { WalletBalanceChanged, WagerTransactionProcessed } from "../../domain/outbox/events";

export interface CreateWalletProps {
	playerId: string;
	initialBalance: MoneyProps;
	correlationId: string;
}

export interface CreateWalletResult {
	id: string;
	playerId: string;
	balance: MoneyProps;
	version: number;
}

const WALLET_UNIQUENESS_CONSTRAINT = "wallets_player_currency_uniq";

/**
 * The opening credit lives in the same SQL transaction that persists the wallet:
 * OPENING transaction + CREDIT ledger entry + balance mutation + outbox events,
 * atomically. Uniqueness of (playerId, currency) is anchored on the DB unique
 * index; the in-transaction pre-check is fast-path only.
 */
export class CreateWalletUseCase {
	constructor(private readonly uow: UnitOfWork) {}

	async execute(props: CreateWalletProps): Promise<CreateWalletResult> {
		try {
			return await this.uow.transactional(async (repos) => {
				const initialBalance = Money.from(props.initialBalance);

				if (await repos.wallets.findDuplicate(props.playerId, initialBalance.currency)) {
					throw new WalletAlreadyExistsError(props.playerId, initialBalance.currency);
				}

				const walletId = newId();
				const wallet = Wallet.open({ id: walletId, playerId: props.playerId, initialBalance });
				await repos.wallets.insert(wallet);
				await recordOpening(repos, wallet, initialBalance, props.correlationId);

				return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
			});
		} catch (error) {
			if (uniqueViolatorOf(error) === WALLET_UNIQUENESS_CONSTRAINT) {
				throw new WalletAlreadyExistsError(props.playerId, props.initialBalance.currency);
			}
			throw error;
		}
	}
}

async function recordOpening(repos: Repositories, wallet: Wallet, initialBalance: Money, correlationId: string): Promise<void> {
	const now = new Date();
	const providerId = "internal";
	const externalTransactionId = `opening-${wallet.id}`;

	const tx = WagerTransaction.create({
		id: newId(),
		providerId,
		externalTransactionId,
		idempotencyKey: `${providerId}:${externalTransactionId}`,
		payloadHash: payloadHashForOpening(wallet, initialBalance),
		walletId: wallet.id,
		playerId: wallet.playerId,
		roundId: "",
		gameId: "",
		kind: WagerTransactionKind.Opening,
		money: initialBalance,
		referenceExternalTransactionId: undefined,
	});

	const mutated = wallet.credit({ money: initialBalance, occurredAt: now });
	const entry = WalletLedgerEntry.create({
		id: newId(),
		walletId: wallet.id,
		transactionId: tx.id,
		direction: LedgerDirection.Credit,
		money: initialBalance,
		balanceBefore: mutated.balanceBefore,
		balanceAfter: mutated.balanceAfter,
		createdAt: now,
	});

	tx.markProcessed(undefined, now, mutated.balanceAfter.toJSON(), mutated.walletVersion);
	await repos.transactions.tryInsert(tx);
	await repos.transactions.save(tx);
	await repos.ledger.insert(entry);
	await repos.wallets.applyMutation(wallet, mutated, now);

	const causation = { eventId: newEventId(), correlationId, causationId: tx.id };
	repos.outbox.enqueue(
		WalletBalanceChanged.from(
			wallet.id,
			{ transactionId: tx.id, direction: LedgerDirection.Credit, money: initialBalance },
			mutated,
			causation,
		),
		newId(),
	);
	repos.outbox.enqueue(
		new WagerTransactionProcessed(wallet.id, causation, {
			transactionId: tx.id,
			providerId,
			externalTransactionId,
			walletId: wallet.id,
			playerId: wallet.playerId,
			roundId: "",
			gameId: "",
			kind: WagerTransactionKind.Opening,
			status: "PROCESSED",
			money: initialBalance.toJSON(),
			idempotencyKey: tx.idempotencyKey,
			balanceAfter: mutated.balanceAfter.toJSON(),
			walletVersion: mutated.walletVersion,
		}),
		newId(),
	);
}

function payloadHashForOpening(wallet: Wallet, initialBalance: Money): string {
	const canonical = JSON.stringify({
		kind: WagerTransactionKind.Opening,
		money: initialBalance.toJSON(),
		playerId: wallet.playerId,
		walletId: wallet.id,
	});
	return sha256Hex(canonical);
}
