import { Type } from "class-transformer";
import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength, ValidateNested } from "class-validator";

export class MoneyDto implements MoneyPropsShape {
	@IsString()
	@Matches(/^\d+\.\d{2}$/, { message: "amount must be a non-negative decimal string with exactly 2 fractional digits" })
	@MaxLength(20)
	amount!: string;

	@IsString()
	@Matches(/^[A-Z]{3}$/, { message: "currency must be an ISO-4217 code" })
	@MaxLength(3)
	currency!: string;
}

interface MoneyPropsShape {
	amount: string;
	currency: string;
}

export class CreateWalletRequest {
	@IsNotEmpty()
	@IsString()
	@MaxLength(64)
	playerId!: string;

	@Type(() => MoneyDto)
	@ValidateNested()
	initialBalance!: MoneyDto;
}

export interface SubmitTransactionRequestShape {
	providerId: string;
	externalTransactionId: string;
	playerId: string;
	walletId: string;
	roundId: string;
	gameId: string;
	kind: string;
	money: MoneyPropsShape;
	referenceExternalTransactionId?: string | undefined;
}

export class SubmitTransactionRequest implements SubmitTransactionRequestShape {
	@IsString()
	@IsNotEmpty()
	@MaxLength(64)
	providerId!: string;

	@IsString()
	@IsNotEmpty()
	@MaxLength(128)
	externalTransactionId!: string;

	@IsString()
	@IsNotEmpty()
	@MaxLength(64)
	playerId!: string;

	@IsString()
	@IsNotEmpty()
	@MaxLength(64)
	walletId!: string;

	@IsString()
	@IsNotEmpty()
	@MaxLength(128)
	roundId!: string;

	@IsString()
	@IsNotEmpty()
	@MaxLength(128)
	gameId!: string;

	@IsString()
	@IsNotEmpty()
	@MaxLength(16)
	kind!: string;

	@Type(() => MoneyDto)
	@ValidateNested()
	money!: MoneyDto;

	@IsOptional()
	@IsString()
	@MaxLength(128)
	referenceExternalTransactionId?: string | undefined;
}
