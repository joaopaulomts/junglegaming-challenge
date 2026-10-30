export enum WagerTransactionKind {
	Opening = "OPENING",
	Bet = "BET",
	Win = "WIN",
	Loss = "LOSS",
	Refund = "REFUND",
	Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
	Pending = "PENDING",
	PendingReference = "PENDING_REFERENCE",
	Processed = "PROCESSED",
	Rejected = "REJECTED",
	Failed = "FAILED",
}

export const SUBMITTABLE_KINDS: readonly WagerTransactionKind[] = [
	WagerTransactionKind.Bet,
	WagerTransactionKind.Win,
	WagerTransactionKind.Loss,
	WagerTransactionKind.Refund,
	WagerTransactionKind.Rollback,
];
