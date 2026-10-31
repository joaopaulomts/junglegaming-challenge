import { type ArgumentsHost, Catch, type ExceptionFilter, HttpStatus } from "@nestjs/common";
import type { Response } from "express";
import { BusinessRuleViolationError } from "../../domain/shared/errors";
import { FailureCode, FAILURE_CODE_GUIDANCE } from "../../domain/wagering/failure-codes";
import {
	ApplicationError,
	IdempotencyConflictError,
	InvalidPayloadError,
	TransientInfraError,
	WalletAlreadyExistsError,
	AggregateNotFoundError,
} from "../../application/errors";
import { ProviderIdentityMismatchError } from "../../application/ports/provider-identity.port";
import { MessageInFlightError } from "../../application/wagering/process-wager-transaction";

export interface ErrorBody {
	error: {
		code: string;
		message: string;
		retryable?: boolean;
		payloadFixable?: boolean;
		details?: string[];
	};
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
	catch(exception: unknown, host: ArgumentsHost): void {
		const ctx = host.switchToHttp();
		const response = ctx.getResponse<Response>();

		const mapped = this.mapException(exception);
		response.status(mapped.status).json(mapped.body);
	}

	private mapException(exception: unknown): { status: number; body: ErrorBody } {
		if (exception instanceof BusinessRuleViolationError) {
			const failure = FAILURE_CODE_GUIDANCE[exception.failureCode as FailureCode];
			return {
				status: failure?.httpStatus ?? HttpStatus.UNPROCESSABLE_ENTITY,
				body: {
					error: {
						code: exception.failureCode,
						message: exception.message,
						retryable: failure?.retryable,
						payloadFixable: failure?.payloadFixable,
					},
				},
			};
		}
		if (exception instanceof IdempotencyConflictError) {
			return {
				status: HttpStatus.CONFLICT,
				body: {
					error: {
						code: "IDEMPOTENCY_CONFLICT",
						message: exception.message,
						retryable: false,
						payloadFixable: false,
					},
				},
			};
		}
		if (exception instanceof InvalidPayloadError) {
			return {
				status: HttpStatus.BAD_REQUEST,
				body: {
					error: {
						code: "INVALID_PAYLOAD",
						message: "request payload failed validation",
						retryable: true,
						payloadFixable: true,
						details: exception.issues,
					},
				},
			};
		}
		if (exception instanceof ProviderIdentityMismatchError) {
			return {
				status: HttpStatus.BAD_REQUEST,
				body: {
					error: {
						code: "PROVIDER_IDENTITY_MISMATCH",
						message: exception.message,
						retryable: false,
						payloadFixable: true,
					},
				},
			};
		}
		if (exception instanceof WalletAlreadyExistsError) {
			return {
				status: HttpStatus.CONFLICT,
				body: {
					error: { code: "WALLET_ALREADY_EXISTS", message: exception.message, retryable: false },
				},
			};
		}
		if (exception instanceof AggregateNotFoundError) {
			return {
				status: HttpStatus.NOT_FOUND,
				body: {
					error: { code: "NOT_FOUND", message: exception.message, retryable: false },
				},
			};
		}
		if (exception instanceof TransientInfraError) {
			return {
				status: HttpStatus.SERVICE_UNAVAILABLE,
				body: {
					error: {
						code: "SERVICE_UNAVAILABLE",
						message: "transient infrastructure failure — safe to retry",
						retryable: true,
					},
				},
			};
		}
		if (exception instanceof ApplicationError) {
			return {
				status: HttpStatus.INTERNAL_SERVER_ERROR,
				body: { error: { code: "APPLICATION_ERROR", message: exception.message } },
			};
		}
		if (exception instanceof MessageInFlightError) {
			return {
				status: HttpStatus.SERVICE_UNAVAILABLE,
				body: {
					error: {
						code: "PROCESSING_IN_FLIGHT",
						message: "this message is being processed by another consumer — retry shortly",
						retryable: true,
					},
				},
			};
		}
		return {
			status: HttpStatus.INTERNAL_SERVER_ERROR,
			body: { error: { code: "INTERNAL_ERROR", message: "unexpected error" } },
		};
	}
}
