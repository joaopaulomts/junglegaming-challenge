import { Inject, Injectable, MiddlewareConsumer, Module, NestModule, ValidationPipe } from "@nestjs/common";
import { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { WalletsController } from "./controllers/wallets.controller";
import { WageringController } from "./controllers/wagering.controller";
import { OperationsController } from "./controllers/operations.controller";
import { NoopProviderAuthGuard } from "./auth/noop-provider-auth.guard";
import { ApiExceptionFilter } from "./filters/api-exception.filter";
import { CorrelationMiddleware } from "./middlewares/correlation.middleware";
import { SqsClientModule } from "./sqs-client.module";
import {
	ProcessWagerTransactionUseCase,
	type PendingReferencePolicy,
} from "../application/wagering/process-wager-transaction";
import { CreateWalletUseCase } from "../application/wallets/create-wallet";
import { ReconcileWalletUseCase } from "../application/wallets/reconcile-wallet";
import { QueryService } from "../application/queries/query-service";
import { NoopProviderIdentityPort, PROVIDER_IDENTITY_TOKEN } from "../application/ports/provider-identity.port";
import { MikroUnitOfWork } from "../infrastructure/uow/mikro-uow";
import { OrmModule } from "./orm.module";

/**
 * Every provider is bound with an explicit `@Inject()` token so the container
 * never depends on `emitDecoratorMetadata` (supported unevenly across
 * runtimes — see docs/PLANO.md task 0).
 */
function pendingPolicy(): PendingReferencePolicy {
	return {
		baseDelayMs: Number(process.env.PENDING_REFERENCE_BASE_DELAY_MS ?? 2000),
		maxAttempts: Number(process.env.PENDING_REFERENCE_MAX_ATTEMPTS ?? 50),
	};
}

function inboxConsumerName(): string {
	return process.env.INBOX_CONSUMER_NAME ?? "wager-transaction-consumer";
}

@Injectable()
export class ProcessWagerTransactionAdapter extends ProcessWagerTransactionUseCase {
	constructor(@Inject(EntityManager) em: EntityManager) {
		super(new MikroUnitOfWork(em), pendingPolicy(), inboxConsumerName());
	}
}

@Injectable()
export class CreateWalletAdapter extends CreateWalletUseCase {
	constructor(@Inject(EntityManager) em: EntityManager) {
		super(new MikroUnitOfWork(em));
	}
}

@Injectable()
export class ReconcileWalletAdapter extends ReconcileWalletUseCase {
	constructor(@Inject(EntityManager) em: EntityManager) {
		super(new MikroUnitOfWork(em));
	}
}

@Injectable()
export class QueryServiceAdapter extends QueryService {
	constructor(@Inject(MikroORM) orm: MikroORM) {
		super(orm);
	}
}

const validationPipe = new ValidationPipe({
	whitelist: true,
	forbidNonWhitelisted: true,
	transform: true,
});

@Module({
	imports: [OrmModule, SqsClientModule],
	controllers: [WalletsController, WageringController, OperationsController],
	providers: [
		{ provide: "APP_GUARD", useClass: NoopProviderAuthGuard },
		{ provide: "APP_FILTER", useClass: ApiExceptionFilter },
		{ provide: "APP_PIPE", useValue: validationPipe },
		{ provide: ProcessWagerTransactionUseCase, useClass: ProcessWagerTransactionAdapter },
		{ provide: CreateWalletUseCase, useClass: CreateWalletAdapter },
		{ provide: ReconcileWalletUseCase, useClass: ReconcileWalletAdapter },
		{ provide: QueryService, useClass: QueryServiceAdapter },
		{ provide: PROVIDER_IDENTITY_TOKEN, useClass: NoopProviderIdentityPort },
	],
})
export class AppModule implements NestModule {
	configure(consumer: MiddlewareConsumer): void {
		consumer.apply(CorrelationMiddleware).forRoutes("*");
	}
}
