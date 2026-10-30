import pino from "pino";
import { correlation } from "./correlation";

export type AppLogger = pino.Logger;

let rootLogger: pino.Logger | undefined;

export function createRootLogger(level = process.env.LOG_LEVEL ?? "info"): pino.Logger {
	rootLogger = pino(
		{
			level,
			base: { service: "wager-wallet-service", pid: process.pid },
			formatters: {
				level(label) {
					return { level: label };
				},
			},
		},
	);
	return rootLogger;
}

/** Percent-serializes base logger with current AsyncLocalStorage correlation ids. */
export function childLogger(bindings: Record<string, unknown> = {}): pino.Logger {
	const base = rootLogger ?? createRootLogger();
	return base.child({ ...correlation(), ...bindings });
}
