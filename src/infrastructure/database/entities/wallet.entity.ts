import { Entity, PrimaryKey, Property, Unique, type Opt } from "@mikro-orm/core";

@Entity({ tableName: "wallets" })
@Unique({ name: "wallets_player_currency_uniq", properties: ["playerId", "currency"] })
export class WalletEntity {
	@PrimaryKey({ type: "uuid" })
	id!: string;

	@Property({ name: "player_id", type: "text" })
	playerId!: string;

	@Property({ type: "text" })
	currency!: string;

	@Property({ name: "balance", type: "numeric", precision: 14, scale: 2 })
	balance!: string;

	@Property({ type: "int" })
	version!: number;

	@Property({ name: "created_at", type: "timestamptz" })
	createdAt!: Opt<Date>;

	@Property({ name: "updated_at", type: "timestamptz" })
	updatedAt!: Opt<Date>;
}
