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

export function correlation(): CorrelationContext {
	return storage.getStore() ?? { correlationId: "unset" };
}
