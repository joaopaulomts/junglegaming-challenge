# ARCHITECTURE.md

> Arquivo vivo: registra decisões relevantes por tarefa + decisões estruturais.
> As seções de tarefa cobrem decisões tomadas até o momento; o restante
> (`README.md` completo, trade-offs finais) fica para a tarefa 13.

## Stack e runtime

- **Bun 1.4**: runtime, package manager e test runner. TypeScript `strict`
  (com `exactOptionalPropertyTypes` e `noUncheckedIndexedAccess`).
- **NestJS 11** + **MikroORM 6** (PostgreSQL) + **SQS via LocalStack** (Docker
  Compose). Prisma fora de escopo.

## Validação do risco: NestJS (decorators) e MikroORM no Bun

Validado no boot real (não apenas em typecheck):

- **Decorators do Nest funcionam no Bun.** O grafo de dependência inicializa
  (validators, filtros, controllers, providers registrados e instanceados).
- **MikroORM funciona no Bun.** As entidades usam decorators do próprio
  MikroORM (`@Entity`, `@Property`) **com `type:` explícito em todas as
  propriedades** — nada depende de `emitDecoratorMetadata` (suporte irregular
  em runtimes alternativos). O schema vem de migrations SQL versionadas
  (`Migration20261030000001`), não do schema generator em runtime.
- **Mitigação de DI:** todos os providers e controllers usam `@Inject()`
  explícito com tokens (classes, symbols ou strings), então o container nunca
  precisa de `design:paramtypes` gerado pelo `emitDecoratorMetadata`.

## Concorrência

- **Lock pessimista por wallet** — `SELECT ... FOR UPDATE` na wallet como
  **primeira** ação de cada transação (evita deadlock); nenhuma trava global.
  `LockMode.PESSIMISTIC_WRITE` nos repositórios (`lockById`,
  `lockByProviderExternal`).
- Unidade de concorrência = `walletId`. Várias instâncias do processo são
  seguras: todas as garantias de ordem vivem no banco.

## Idempotência e hash de payload

- Persistida no banco (nunca cache em memória):
  `UNIQUE(idempotency_key)` e `UNIQUE(provider_id, external_transaction_id)`
  em `wager_transactions`; `INSERT ... ON CONFLICT DO NOTHING` resolve a
  corrida no nível do banco (`tryInsert` reporta `inserted | conflict`).
- `payload_hash` = SHA-256 de **JSON canônico** (chaves ordenadas
  recursivamente, recursão com ordenação determinística) **somente do
  subconjunto de negócio** (`providerId`, `externalTransactionId`, `playerId`,
  `walletId`, `roundId`, `gameId`, `kind`, `money`,
  `referenceExternalTransactionId?`). Headers (`Idempotency-Key`, `x-provider-id`)
  e metadados de transporte (`messageId`, `correlationId`) **não** entram no
  hash; testes de unidade cobrem isso (`tests/unit/payload-hash.test.ts`).
- Mesma key + payload igual → **replay** com o resultado original. Para isso a
  transação guarda o resultado observado (`resulting_balance`,
  `resulting_version`, `resulting_wallet_version`, `processed_at`).
- Mesma key com payload diferente → `IdempotencyConflictError` (409), nunca
  replay.
- **Inbox** com PK `(consumer_name, message_id)` e estados
  `inFlight | processed`, usada pelo canal SQS na mesma transação do efeito.

## Transações

Toda a cadeia abaixo roda numa **única transação SQL** (`MikroUnitOfWork`.
`transactional()`, com repositórios presos ao `EntityManager` da transação):

1. resolução idempotente (`tryInsert` / `findExistingByAnyKey`);
2. lock pessimista da wallet;
3. validações de regra (moeda, player, saldo, referência);
4. mutação da wallet (`Wallet.debit/credit` — CHECK `balance >= 0` no banco);
5. `WalletLedgerEntry` imutável (trigger bloqueia UPDATE/DELETE);
6. eventos na **outbox** (nada publicado antes do commit);
7. commit.

Rejeição por regra de negócio também é persistida (`status = REJECTED`,
`failure_code`) — inclusive para wallets inexistentes (`wallet_id` sem FK,
propositalmente, pois a wallet pode nunca ter existido).

## Outbox / Inbox (at-least-once)

- `FOR UPDATE SKIP LOCKED` no worker da outbox (vários publishers sem
  duplicação de trabalho); `markPublished` na mesma transação do claim.
- Publicação dupla é esperada (crash após commit/publish): segurança vem do
  consumidor deduplicando por `eventId`.
- Backoff exponencial com limite de tentativas (`scheduleRetry`).

## SQS

Filas FIFO (`docker/localstack/init/ready.d/01-queues.sh`):

- `wager-transactions.fifo` → redrive com `maxReceiveCount: 5` para
  `wager-transactions-dlq.fifo` (ambas FIFO, `ContentBasedDeduplication`);
- `integration-events.fifo` → destino da outbox.
- `MessageGroupId = walletId` (ordena por agregado, sem serializar o sistema
  inteiro).
- FIFO é otimização, não garantia: TODAS as invariantes são garantidas pelo
  banco (idempotência + lock por wallet).
- Erros classificados em `consumer-errors.ts`: transitório → re-delivery com
  backoff; permanente (payload rejeitável) → DLQ + ack; `MessageInFlightError`
  → não-ack para não perder a corrida do inbox.

## Money

- `Money` imutável (`decimal.js`, `ROUND_HALF_EVEN`, precisão 40), escala fixa
  de 2 casas, `toJSON()` sempre com 2 casas.
- Rejeita em contratos de entrada: `NaN`/`Infinity`, notação científica,
  string vazia, mais/menos de 2 casas, negativos e valores acima de
  `999999999999.99`.
- No banco: `NUMERIC(20,2)` + coluna `currency` separada; reidratação sempre
  via `Money.from`.
- DTO `MoneyDto` aceita apenas `/^\d+\.\d{2}$/` (não-negativo); negativos são
  rejeitados na fronteira HTTP e em `Money.from` (contratos de entrada), visto
  que nenhuma operação de domínio consome montante negativo — direção vem do
  `kind` e do `LedgerDirection`.

## Migrations e garantias no schema

`Migration20261030000001` (up/down reversível):

- `wallets`: `UNIQUE(player_id, currency)`, `CHECK(balance >= 0)`;
- `wallet_ledger_entries`: `CHECK` de aritmética
  (`balance_after = balance_before ± amount` por direção),
  `UNIQUE(transaction_id, wallet_id)` e **trigger** que bloqueia UPDATE/DELETE;
- `wager_transactions`: `UNIQUE(idempotency_key)`,
  `UNIQUE(provider_id, external_transaction_id)`, CHECK de `kind`/`status`,
  **índice único parcial** `(reference_transaction_id, kind)` para
  REFUND/ROLLBACK processados (estorno único), trigger de imutabilidade para
  linhas terminais;
- `inbox_messages`: PK `(consumer_name, message_id)`;
- `outbox_messages`: índice `(published_at, next_attempt_at)`;

## Autenticação (decisão: não implementar)

- `NoopProviderAuthGuard` (guard global) + porta
  `ProviderIdentityPort` (`src/application/ports/provider-identity.port.ts`)
  com `NoopProviderIdentityPort`.
- O desenho adotado seria Integração OIDC (Keycloak ou Zitadel): client-credentials
  por provedor, validação de JWT no gateway/guard e comparação do `azp`/`sub`
  com `providerId` de payload → 403 em divergência; a troca de implementação
  da porta não muda use cases nem controllers.
- Comportamento atual (no-op): credencial ausente → segue; credencial
  presente que contradiz o payload → 400 `PROVIDER_IDENTITY_MISMATCH`
  (testado).
- Health (`/health/live`, `/health/ready`) e `/metrics` ficam abertos
  propositalmente.

## Mapeamento HTTP (consistente em todos os endpoints)

| Situação | Status |
|---|---|
| Payload/DTO inválido, identidade contraditória | `400` |
| Conflito de idempotência | `409` |
| Wallet duplicada | `409` |
| Agregado não encontrado | `404` |
| Rejeição por regra de negócio | `422` + `failureCode` |
| Processada | `200` |
| Aceita com referência pendente | `202` |
| Falha transitória de infraestrutura | `503` (`retryable: true`) |
| Processamento em fila em outro consumidor | `503` `PROCESSING_IN_FLIGHT` |

## Observabilidade

- Logs JSON (pino) com `correlationId` via `AsyncLocalStorage`; contextos
  logados: `messageId`, `transactionId`, `walletId`, `providerId`. O bootstrap
  do Nest também passa pelo adapter do pino (todas as linhas saem em JSON).
- Métricas prom-client em `/metrics`: transações por `status/kind/channel`,
  idempotent replays, idempotency conflicts, duplicatas, retries (inbox/outbox/
  pending-reference), DLQ, lock conflicts, outbox lag, latência por canal,
  divergências de reconciliação, wallets e pending references.
- Payloads financeiros completos não são logados.

## Boot resilient

- `OrmModule` (fábrica própria, sem `MikroOrmModule.forRoot`) conecta com
  retry/backoff exponencial (até `DB_CONNECT_MAX_ATTEMPTS=30`) para sobreviver
  a `docker compose up -d && bun run start` com Postgres ainda acordando.
  Fechamento do ORM em `onApplicationShutdown`.
- Logs de bootstrap são roteados pelo pino **antes** de qualquer falha (Nest
  chama `process.exit(1)` na ExceptionsZone; um logger registrado depois
  esconderia o motivo).

## Limitações / pendências conhecidas

- `@mikro-orm/nestjs` deixou de ser usada (providers próprios garantem tokens
  determinísticos); dependência pode ser removida do `package.json`.
- Workers (outbox, pending-reference, SQS consumer) ainda não registrados nos
  lifecycle hooks do AppModule (tarefas 9/10 integrarão).
- Testes de integração/concorrência aguardam tarefas 5–12.
