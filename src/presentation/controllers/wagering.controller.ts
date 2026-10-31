import { Body, Controller, Get, Headers, HttpStatus, Inject, Param, Post, Res } from "@nestjs/common";
import type { Response as ExpressResponse } from "express";
import {
	ProcessWagerTransactionUseCase,
	type WagerProcessingOutcome,
} from "../../application/wagering/process-wager-transaction";
import { QueryService, type TransactionView } from "../../application/queries/query-service";
import { AggregateNotFoundError, InvalidPayloadError } from "../../application/errors";
import { PROVIDER_IDENTITY_TOKEN, type ProviderIdentityPort } from "../../application/ports/provider-identity.port";
import type { MoneyProps } from "../../domain/shared/money";
import { correlation } from "../../infrastructure/observability/correlation";
import { newCorrelationId } from "../../application/shared/ids";
import { SubmitTransactionRequest } from "../dtos/wallet.dto";

function requestCorrelationId(): string {
	const current = correlation();
	return current.correlationId !== "unset" ? current.correlationId : newCorrelationId();
}

export interface SubmitTransactionResponse {
	transactionId: string;
	status: "PROCESSED" | "REJECTED" | "PENDING_REFERENCE";
	balance?: { amount: string; currency: string };
	walletVersion?: number;
	failureCode?: string;
	idempotentReplay: boolean;
}

/**
 * POST /wagering/transactions runs the exact same use case as the SQS channel;
 * only transport concerns (header parsing, HTTP status mapping) live here.
 */
@Controller()
export class WageringController {
	constructor(
		@Inject(ProcessWagerTransactionUseCase) private readonly processTransaction: ProcessWagerTransactionUseCase,
		@Inject(QueryService) private readonly queries: QueryService,
		@Inject(PROVIDER_IDENTITY_TOKEN) private readonly providerIdentity: ProviderIdentityPort,
	) {}

	@Post("wagering/transactions")
	async submit(
		@Headers("idempotency-key") idempotencyKey: string | undefined,
		@Headers("x-provider-id") transportProviderId: string | undefined,
		@Body() body: SubmitTransactionRequest,
		@Res({ passthrough: true }) response: ExpressResponse,
	): Promise<SubmitTransactionResponse> {
		this.providerIdentity.authenticate({
			transportProviderId,
			claimedProviderId: body.providerId,
		});
		const key = idempotencyKey?.trim();
		if (key === undefined || key.length === 0) {
			throw new InvalidPayloadError([
				"Idempotency-Key header is required; the recommended default is \"{providerId}:{externalTransactionId}\"",
			]);
		}
		const outcome = await this.processTransaction.execute({
			providerId: body.providerId,
			externalTransactionId: body.externalTransactionId,
			idempotencyKey: key,
			playerId: body.playerId,
			walletId: body.walletId,
			roundId: body.roundId,
			gameId: body.gameId,
			kind: body.kind.toUpperCase(),
			money: { amount: body.money.amount, currency: body.money.currency.toUpperCase() } as MoneyProps,
			referenceExternalTransactionId: body.referenceExternalTransactionId,
			correlationId: requestCorrelationId(),
		});
		response.status(httpStatusOf(outcome.type));
		return serialize(outcome);
	}

	@Get("wagering/transactions/:transactionId")
	async byId(@Param("transactionId") transactionId: string): Promise<TransactionView> {
		const view = await this.queries.transactionById(transactionId);
		if (view === null) {
			throw new AggregateNotFoundError("transaction", transactionId);
		}
		return view;
	}

	@Get("providers/:providerId/wagering/transactions/:externalTransactionId")
	async byProviderExternal(
		@Param("providerId") providerId: string,
		@Param("externalTransactionId") externalTransactionId: string,
	): Promise<TransactionView> {
		const view = await this.queries.transactionByProviderExternal(providerId, externalTransactionId);
		if (view === null) {
			throw new AggregateNotFoundError("transaction", `${providerId}/${externalTransactionId}`);
		}
		return view;
	}
}

export function httpStatusOf(type: WagerProcessingOutcome["type"]): number {
	switch (type) {
		case "PROCESSED":
			return HttpStatus.OK;
		case "PENDING_REFERENCE":
			return HttpStatus.ACCEPTED;
		case "REJECTED":
			return HttpStatus.UNPROCESSABLE_ENTITY;
	}
}

export function serialize(outcome: WagerProcessingOutcome): SubmitTransactionResponse {
	const base = {
		transactionId: outcome.transactionId,
		idempotentReplay: outcome.idempotentReplay,
	};
	if (outcome.type === "REJECTED") {
		return { ...base, status: "REJECTED", failureCode: outcome.failureCode };
	}
	if (outcome.type === "PENDING_REFERENCE") {
		return { ...base, status: "PENDING_REFERENCE" };
	}
	const response: SubmitTransactionResponse = { ...base, status: "PROCESSED" };
	if (outcome.balanceAfter !== undefined) {
		response.balance = { amount: outcome.balanceAfter.amount, currency: outcome.balanceAfter.currency };
	}
	if (outcome.walletVersion !== undefined) {
		response.walletVersion = outcome.walletVersion;
	}
	return response;
}
