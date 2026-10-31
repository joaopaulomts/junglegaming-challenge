import { Inject, Module, OnApplicationShutdown } from "@nestjs/common";
import { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { databaseConfig } from "../infrastructure/database/mikro-config";
import { createRootLogger } from "../infrastructure/observability/logger";

/**
 * MikroORM is wired by hand instead of through `MikroOrmModule.forRoot` for two
 * reasons:
 *
 * 1. Tokens are explicit. The Nest integration resolves different provider
 *    tokens depending on which option/driver branch it takes; a hand-written
 *    factory keeps `MikroORM`/`EntityManager` resolvable regardless, and never
 *    relies on `emitDecoratorMetadata`.
 * 2. Boot tolerates a database that is still starting (the documented flow is
 *    `docker compose up -d && bun run start`). Connection retries happen here,
 *    once, instead of each consumer having to guard against it.
 */
const DEFAULT_MAX_ATTEMPTS = 30;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt: number): number {
	return Math.min(500 * 2 ** Math.max(0, attempt - 1), 5_000);
}

async function connectWithRetry(): Promise<MikroORM> {
	const url = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/wallets";
	const poolMax = Number(process.env.DATABASE_POOL_MAX ?? 20);
	const maxAttempts = Number(process.env.DB_CONNECT_MAX_ATTEMPTS ?? DEFAULT_MAX_ATTEMPTS);
	const logger = createRootLogger();

	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			const orm = await MikroORM.init(databaseConfig(url, poolMax));
			logger.info({ attempt }, "connected to postgresql");
			return orm;
		} catch (error) {
			lastError = error;
			if (attempt === maxAttempts) break;
			logger.warn({ attempt, err: error }, "postgresql not reachable yet — retrying");
			await sleep(backoffDelay(attempt));
		}
	}
	throw lastError instanceof Error ? lastError : new Error("failed to connect to postgresql");
}

@Module({
	providers: [
		{ provide: MikroORM, useFactory: connectWithRetry },
		{
			provide: EntityManager,
			inject: [MikroORM],
			useFactory: (orm: MikroORM): EntityManager => orm.em as unknown as EntityManager,
		},
	],
	exports: [MikroORM, EntityManager],
})
export class OrmModule implements OnApplicationShutdown {
	constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

	async onApplicationShutdown(): Promise<void> {
		await this.orm.close(true);
	}
}
