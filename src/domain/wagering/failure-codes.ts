export const FailureCode = {
	INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
	REVERSAL_WOULD_OVERDRAW: "REVERSAL_WOULD_OVERDRAW",
	REFERENCED_TRANSACTION_NOT_FOUND: "REFERENCED_TRANSACTION_NOT_FOUND",
	REFERENCED_TRANSACTION_NOT_PROCESSABLE: "REFERENCED_TRANSACTION_NOT_PROCESSABLE",
	REFERENCE_ALREADY_REVERSED: "REFERENCE_ALREADY_REVERSED",
	REFERENCE_AMOUNT_MISMATCH: "REFERENCE_AMOUNT_MISMATCH",
	REFERENCE_CONTEXT_MISMATCH: "REFERENCE_CONTEXT_MISMATCH",
	PLAYER_WALLET_MISMATCH: "PLAYER_WALLET_MISMATCH",
	REFERENCE_KIND_NOT_ALLOWED: "REFERENCE_KIND_NOT_ALLOWED",
	MISSING_REFERENCE: "MISSING_REFERENCE",
	INVALID_KIND: "INVALID_KIND",
	WALLET_NOT_FOUND: "WALLET_NOT_FOUND",
	WALLET_CURRENCY_MISMATCH: "WALLET_CURRENCY_MISMATCH",
	INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];

export interface FailureCodeGuidance {
	retryable: boolean;
	payloadFixable: boolean;
	httpStatus: 400 | 404 | 409 | 422 | 500;
	description: string;
}

export const FAILURE_CODE_GUIDANCE: Record<FailureCode, FailureCodeGuidance> = {
	INSUFFICIENT_BALANCE: {
		retryable: false,
		payloadFixable: false,
		httpStatus: 422,
		description: "Wallet balance is lower than the debit. Do not resend unless the player balance changes.",
	},
	REVERSAL_WOULD_OVERDRAW: {
		retryable: false,
		payloadFixable: false,
		httpStatus: 422,
		description:
			"Rolling back a credit (WIN/REFUND) would push the balance below zero. Operationally distinct from insufficient balance on a bet.",
	},
	REFERENCED_TRANSACTION_NOT_FOUND: {
		retryable: false,
		payloadFixable: true,
		httpStatus: 422,
		description: "The referenced transaction never arrived or was rejected. Verify the reference id and resubmit a rollback only if needed.",
	},
	REFERENCED_TRANSACTION_NOT_PROCESSABLE: {
		retryable: false,
		payloadFixable: true,
		httpStatus: 422,
		description: "The reference exists but is not in a state/kind that can be referenced (REJECTED, FAILED, or invalid kind chain).",
	},
	REFERENCE_ALREADY_REVERSED: {
		retryable: false,
		payloadFixable: false,
		httpStatus: 422,
		description: "The reference has already been reverted by an operation of this kind. Do not resend.",
	},
	REFERENCE_AMOUNT_MISMATCH: {
		retryable: false,
		payloadFixable: true,
		httpStatus: 422,
		description: "The amount must equal the referenced transaction amount. Partial reversals are not supported.",
	},
	REFERENCE_CONTEXT_MISMATCH: {
		retryable: false,
		payloadFixable: true,
		httpStatus: 422,
		description: "The reference must belong to the same provider, player, wallet, currency and round.",
	},
	PLAYER_WALLET_MISMATCH: {
		retryable: false,
		payloadFixable: true,
		httpStatus: 422,
		description: "The wallet does not belong to the supplied playerId.",
	},
	REFERENCE_KIND_NOT_ALLOWED: {
		retryable: false,
		payloadFixable: true,
		httpStatus: 422,
		description:
			"The reference kind is not allowed for this operation: REFUND may only reference BET; ROLLBACK may only reference BET, WIN or REFUND.",
	},
	MISSING_REFERENCE: {
		retryable: false,
		payloadFixable: true,
		httpStatus: 422,
		description: "REFUND and ROLLBACK require referenceExternalTransactionId.",
	},
	INVALID_KIND: {
		retryable: false,
		payloadFixable: true,
		httpStatus: 422,
		description: "Unsupported transaction kind for external submission (OPENING is internal).",
	},
	WALLET_NOT_FOUND: {
		retryable: false,
		payloadFixable: true,
		httpStatus: 404,
		description: "No wallet exists for the given walletId. Create the wallet first.",
	},
	WALLET_CURRENCY_MISMATCH: {
		retryable: false,
		payloadFixable: true,
		httpStatus: 422,
		description: "The transaction currency does not match the wallet currency.",
	},
	INTERNAL_ERROR: {
		retryable: true,
		payloadFixable: false,
		httpStatus: 500,
		description: "Unexpected internal error. Safe to retry with the same idempotency key.",
	},
};
