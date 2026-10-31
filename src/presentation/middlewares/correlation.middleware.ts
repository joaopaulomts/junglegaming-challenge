import { Injectable, type NestMiddleware } from "@nestjs/common";
import type { Request, Response, NextFunction } from "express";
import { enterCorrelation, type CorrelationContext } from "../../infrastructure/observability/correlation";
import { newCorrelationId } from "../../application/shared/ids";

/** Attaches a correlation context to the whole downstream request chain. */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
	use(req: Request, _res: Response, next: NextFunction): void {
		const header = req.headers["x-correlation-id"];
		const provider = req.headers["x-provider-id"];
		const context: CorrelationContext = {
			correlationId: typeof header === "string" && header.length > 0 ? header : newCorrelationId(),
		};
		if (typeof provider === "string" && provider.length > 0) {
			context.providerId = provider;
		}
		enterCorrelation(context);
		next();
	}
}
