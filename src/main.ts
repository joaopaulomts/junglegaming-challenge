import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { LoggerService } from "@nestjs/common";
import { AppModule } from "./presentation/app.module";
import { createRootLogger, type AppLogger } from "./infrastructure/observability/logger";

/** Routes Nest's own lifecycle logging through pino so every line is JSON. */
function textOf(message: unknown): string {
	if (typeof message === "string") return message;
	if (message instanceof Error) return message.stack ?? message.message;
	if (message === undefined || message === null) return String(message);
	try {
		return JSON.stringify(message);
	} catch {
		return String(message);
	}
}

class PinoNestLogger implements LoggerService {
	constructor(private readonly logger: AppLogger) {}

	private write(level: "info" | "error" | "warn" | "debug", message: unknown, context?: string): void {
		this.logger[level]({ context: context ?? "Nest" }, textOf(message));
	}

	log(message: unknown, context?: string): void {
		this.write("info", message, context);
	}

	error(message: unknown, trace?: unknown, context?: string): void {
		this.logger.error({ context: context ?? "Nest", trace: textOf(trace) }, textOf(message));
	}

	warn(message: unknown, context?: string): void {
		this.write("warn", message, context);
	}

	debug(message: unknown, context?: string): void {
		this.write("debug", message, context);
	}

	verbose(message: unknown, context?: string): void {
		this.write("debug", message, context);
	}
}

async function bootstrap(): Promise<void> {
	const logger = createRootLogger();
	// The logger is passed at create-time on purpose: Nest exits the process
	// from `ExceptionsZone` when initialization fails (e.g. PostgreSQL down), so
	// a logger registered after `create()` would hide the very error we need.
	const app = await NestFactory.create(AppModule, { logger: new PinoNestLogger(logger) });
	app.enableShutdownHooks();

	const port = Number(process.env.PORT ?? 3000);
	await app.listen(port, "0.0.0.0");
	logger.info({ port }, "wager-wallet service listening");
}

void bootstrap().catch((error: unknown) => {
	createRootLogger().error({ err: error }, "failed to bootstrap service");
	process.exit(1);
});
