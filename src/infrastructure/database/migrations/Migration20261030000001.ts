import { Migration } from "@mikro-orm/migrations";

/**
 * Schema carrying all structural invariants:
 *  - non-negative balance + unique wallets (DB-level, section 5.9)
 *  - immutable ledger entries with verified arithmetic + one entry per
 *    transaction per wallet + FK into transactions
 *  - transaction identity: unique idempotency key and unique
 *    (provider, external id); terminal rows frozen by trigger; one successful
 *    reversal per kind via partial unique index
 *  - inbox dedup by (consumer, message id)
 */
export class Migration20261030000001 extends Migration {
	override async up(): Promise<void> {
		this.addSql(`
			CREATE TABLE wallets (
				id uuid PRIMARY KEY,
				player_id text NOT NULL,
				currency char(3) NOT NULL,
				balance numeric(14,2) NOT NULL,
				version integer NOT NULL DEFAULT 1,
				created_at timestamptz NOT NULL DEFAULT now(),
				updated_at timestamptz NOT NULL DEFAULT now(),
				CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
				CONSTRAINT wallets_version_positive CHECK (version >= 1),
				CONSTRAINT wallets_player_currency_uniq UNIQUE (player_id, currency)
			)
		`);

		this.addSql(`
			CREATE TABLE wager_transactions (
				id uuid PRIMARY KEY,
				provider_id text NOT NULL,
				external_transaction_id text NOT NULL,
				idempotency_key text NOT NULL,
				payload_hash char(64) NOT NULL,
				wallet_id uuid NOT NULL,
				player_id text NOT NULL,
				round_id text NOT NULL,
				game_id text NOT NULL,
				kind text NOT NULL,
				amount numeric(14,2) NOT NULL,
				currency char(3) NOT NULL,
				reference_external_transaction_id text,
				status text NOT NULL,
				reference_transaction_id uuid,
				failure_code text,
				processed_at timestamptz,
				resulting_balance numeric(14,2),
				resulting_version integer,
				reference_attempts integer NOT NULL DEFAULT 0,
				reference_next_attempt_at timestamptz,
				created_at timestamptz NOT NULL DEFAULT now(),
				CONSTRAINT wager_kind_valid CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
				CONSTRAINT wager_kind_internal_only CHECK (kind <> 'OPENING' OR provider_id = 'internal'),
				CONSTRAINT wager_amount_positive CHECK (amount > 0),
				CONSTRAINT wager_status_valid CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
				CONSTRAINT wager_attempts_non_negative CHECK (reference_attempts >= 0),
				CONSTRAINT wager_transaction_idempotency_uniq UNIQUE (idempotency_key),
				CONSTRAINT wager_transaction_identity_uniq UNIQUE (provider_id, external_transaction_id)
			)
		`);

		this.addSql(`
			CREATE TABLE wallet_ledger_entries (
				id uuid PRIMARY KEY,
				wallet_id uuid NOT NULL REFERENCES wallets (id),
				transaction_id uuid NOT NULL REFERENCES wager_transactions (id),
				direction text NOT NULL,
				amount numeric(14,2) NOT NULL,
				currency char(3) NOT NULL,
				balance_before numeric(14,2) NOT NULL,
				balance_after numeric(14,2) NOT NULL,
				created_at timestamptz NOT NULL DEFAULT now(),
				CONSTRAINT ledger_direction_valid CHECK (direction IN ('DEBIT', 'CREDIT')),
				CONSTRAINT ledger_amount_positive CHECK (amount > 0),
				CONSTRAINT ledger_before_non_negative CHECK (balance_before >= 0),
				CONSTRAINT ledger_after_non_negative CHECK (balance_after >= 0),
				CONSTRAINT ledger_entry_arithmetic CHECK (
					(direction = 'DEBIT' AND balance_before - amount = balance_after)
					OR (direction = 'CREDIT' AND balance_before + amount = balance_after)
				),
				CONSTRAINT ledger_one_entry_per_transaction_per_wallet UNIQUE (transaction_id, wallet_id)
			)
		`);

		this.addSql(`
			CREATE TABLE inbox_messages (
				id bigserial PRIMARY KEY,
				message_id text NOT NULL,
				consumer_name text NOT NULL,
				payload_hash char(64) NOT NULL,
				received_at timestamptz NOT NULL DEFAULT now(),
				processed_at timestamptz,
				CONSTRAINT inbox_message_uniq UNIQUE (consumer_name, message_id)
			)
		`);

		this.addSql(`
			CREATE TABLE outbox_messages (
				id uuid PRIMARY KEY,
				aggregate_id text NOT NULL,
				event_type text NOT NULL,
				payload jsonb NOT NULL,
				occurred_at timestamptz NOT NULL DEFAULT now(),
				attempts integer NOT NULL DEFAULT 0,
				next_attempt_at timestamptz,
				published_at timestamptz,
				CONSTRAINT outbox_attempts_non_negative CHECK (attempts >= 0)
			)
		`);

		/* ---------------------------- lookup indexes ---------------------------- */

		this.addSql(`CREATE INDEX wallets_player_idx ON wallets (player_id)`);
		this.addSql(`CREATE INDEX wager_transactions_by_provider_external_idx ON wager_transactions (provider_id, external_transaction_id)`);
		this.addSql(`CREATE INDEX wager_transactions_by_wallet_idx ON wager_transactions (wallet_id, created_at DESC)`);
		this.addSql(`CREATE INDEX wager_transactions_by_round_idx ON wager_transactions (provider_id, round_id)`);
		this.addSql(`
			CREATE UNIQUE INDEX wager_reversal_once_per_kind_idx
			ON wager_transactions (reference_transaction_id, kind)
			WHERE status = 'PROCESSED'
			  AND reference_transaction_id IS NOT NULL
			  AND kind IN ('REFUND', 'ROLLBACK')
		`);
		this.addSql(`
			CREATE INDEX wager_pending_reference_idx
			ON wager_transactions (reference_next_attempt_at)
			WHERE status = 'PENDING_REFERENCE'
		`);
		this.addSql(`CREATE INDEX ledger_by_wallet_idx ON wallet_ledger_entries (wallet_id, created_at DESC, id DESC)`);
		this.addSql(`CREATE INDEX ledger_by_transaction_idx ON wallet_ledger_entries (transaction_id)`);
		this.addSql(`CREATE INDEX inbox_consumer_received_idx ON inbox_messages (consumer_name, received_at DESC)`);
		this.addSql(`
			CREATE INDEX outbox_due_idx
			ON outbox_messages (COALESCE(next_attempt_at, occurred_at))
			WHERE published_at IS NULL
		`);
		this.addSql(`CREATE INDEX outbox_pending_lag_idx ON outbox_messages (occurred_at) WHERE published_at IS NULL`);

		/* ------------------ ledger silence: UPDATE/DELETE never ------------------ */

		this.addSql(`
			CREATE OR REPLACE FUNCTION enforce_ledger_immutability()
			RETURNS trigger
			LANGUAGE plpgsql
			AS $$
			BEGIN
				RAISE EXCEPTION 'wallet_ledger_entries is immutable: % blocked on row %', TG_OP, OLD.id;
			END;
			$$
		`);
		this.addSql(`
			CREATE TRIGGER wallet_ledger_entries_no_update
			BEFORE UPDATE ON wallet_ledger_entries
			FOR EACH ROW EXECUTE FUNCTION enforce_ledger_immutability()
		`);
		this.addSql(`
			CREATE TRIGGER wallet_ledger_entries_no_delete
			BEFORE DELETE ON wallet_ledger_entries
			FOR EACH ROW EXECUTE FUNCTION enforce_ledger_immutability()
		`);

		/* ------------- terminal wager transactions become immutable -------------- */

		this.addSql(`
			CREATE OR REPLACE FUNCTION enforce_terminal_transaction_immutability()
			RETURNS trigger
			LANGUAGE plpgsql
			AS $$
			BEGIN
				IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
					RAISE EXCEPTION 'wager transaction % is terminal and immutable', OLD.id;
				END IF;
				RETURN NEW;
			END;
			$$
		`);
		this.addSql(`
			CREATE TRIGGER wager_transactions_terminal_protection
			BEFORE UPDATE ON wager_transactions
			FOR EACH ROW EXECUTE FUNCTION enforce_terminal_transaction_immutability()
		`);
		this.addSql(`
			CREATE TRIGGER wager_transactions_no_delete
			BEFORE DELETE ON wager_transactions
			FOR EACH ROW EXECUTE FUNCTION enforce_ledger_immutability()
		`);
	}

	override async down(): Promise<void> {
		this.addSql(`DROP TRIGGER IF EXISTS wager_transactions_no_delete ON wager_transactions`);
		this.addSql(`DROP TRIGGER IF EXISTS wager_transactions_terminal_protection ON wager_transactions`);
		this.addSql(`DROP FUNCTION IF EXISTS enforce_terminal_transaction_immutability()`);
		this.addSql(`DROP TRIGGER IF EXISTS wallet_ledger_entries_no_update ON wallet_ledger_entries`);
		this.addSql(`DROP TRIGGER IF EXISTS wallet_ledger_entries_no_delete ON wallet_ledger_entries`);
		this.addSql(`DROP FUNCTION IF EXISTS enforce_ledger_immutability()`);
		this.addSql(`DROP INDEX IF EXISTS outbox_pending_lag_idx`);
		this.addSql(`DROP INDEX IF EXISTS outbox_due_idx`);
		this.addSql(`DROP INDEX IF EXISTS inbox_consumer_received_idx`);
		this.addSql(`DROP INDEX IF EXISTS ledger_by_transaction_idx`);
		this.addSql(`DROP INDEX IF EXISTS ledger_by_wallet_idx`);
		this.addSql(`DROP INDEX IF EXISTS wager_pending_reference_idx`);
		this.addSql(`DROP INDEX IF EXISTS wager_reversal_once_per_kind_idx`);
		this.addSql(`DROP INDEX IF EXISTS wager_transactions_by_round_idx`);
		this.addSql(`DROP INDEX IF EXISTS wager_transactions_by_wallet_idx`);
		this.addSql(`DROP INDEX IF EXISTS wager_transactions_by_provider_external_idx`);
		this.addSql(`DROP INDEX IF EXISTS wallets_player_idx`);
		this.addSql(`DROP TABLE IF EXISTS outbox_messages`);
		this.addSql(`DROP TABLE IF EXISTS inbox_messages`);
		this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries`);
		this.addSql(`DROP TABLE IF EXISTS wager_transactions`);
		this.addSql(`DROP TABLE IF EXISTS wallets`);
	}
}
