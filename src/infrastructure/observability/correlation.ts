import { AsyncLocalStorage } from "node:async_hooks";

export interface CorrelationContext {
	correlationId: string;
	messageId?: string;
	transactionId?: string;
	walletId?: string;
	providerId?: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

/** Runs fn with a correlation context available synchronously anywhere below. */
export function runWithCorrelation<T>(context: CorrelationContext, fn: () => Promise<T>): Promise<T> {
	return storage.run(context, fn);
}

/**
 * Attaches the context to the *current* async frame — used at transport
 * boundaries (Express middleware) where the downstream chain is invoked
 * synchronously through next().
 */
export function enterCorrelation(context: CorrelationContext): void {
	storage.enterWith(context);
}

export function correlation(): CorrelationContext {
	return storage.getStore() ?? { correlationId: "unset" };
}
