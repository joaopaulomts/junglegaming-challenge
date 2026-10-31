import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query } from "@nestjs/common";
import { CreateWalletUseCase } from "../../application/wallets/create-wallet";
import { ReconcileWalletUseCase, type ReconciliationReport } from "../../application/wallets/reconcile-wallet";
import { QueryService, type LedgerPage, type WalletView } from "../../application/queries/query-service";
import { AggregateNotFoundError } from "../../application/errors";
import { correlation } from "../../infrastructure/observability/correlation";
import { newCorrelationId } from "../../application/shared/ids";
import { CreateWalletRequest } from "../dtos/wallet.dto";

function requestCorrelationId(): string {
	const current = correlation();
	return current.correlationId !== "unset" ? current.correlationId : newCorrelationId();
}

const MAX_LEDGER_PAGE = 200;

@Controller("wallets")
export class WalletsController {
	constructor(
		@Inject(CreateWalletUseCase) private readonly createWallet: CreateWalletUseCase,
		@Inject(ReconcileWalletUseCase) private readonly reconciler: ReconcileWalletUseCase,
		@Inject(QueryService) private readonly queries: QueryService,
	) {}

	@Post()
	@HttpCode(HttpStatus.CREATED)
	async create(@Body() body: CreateWalletRequest): Promise<WalletView> {
		const result = await this.createWallet.execute({
			playerId: body.playerId,
			initialBalance: body.initialBalance,
			correlationId: requestCorrelationId(),
		});
		const view = await this.queries.wallet(result.id);
		if (view === null) {
			throw new AggregateNotFoundError("wallet", result.id);
		}
		return view;
	}

	@Get(":walletId")
	async get(@Param("walletId") walletId: string): Promise<WalletView> {
		const view = await this.queries.wallet(walletId);
		if (view === null) {
			throw new AggregateNotFoundError("wallet", walletId);
		}
		return view;
	}

	@Get(":walletId/ledger")
	async ledger(@Param("walletId") walletId: string, @Query("cursor") cursor?: string, @Query("limit") limit?: string): Promise<LedgerPage> {
		const parsed = limit ? Number(limit) : 50;
		const bounded = Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_LEDGER_PAGE ? Math.floor(parsed) : 50;
		const page = await this.queries.ledger(walletId, cursor, bounded);
		if (page === null) {
			throw new AggregateNotFoundError("wallet", walletId);
		}
		return page;
	}

	@Post(":walletId/reconciliation")
	async reconcile(@Param("walletId") walletId: string): Promise<ReconciliationReport> {
		return await this.reconciler.execute(walletId);
	}
}
