# Wager Wallet Service

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`,
`LOSS`, `REFUND`, `ROLLBACK`) recebidas de múltiplos provedores de jogos.

O desafio avalia correção financeira, concorrência entre múltiplas instâncias,
idempotência persistente, consistência entre saldo materializado e ledger,
processamento assíncrono e recuperação após falhas. Este repositório é a
entrega **parcial** desse desafio: a seção [Status da entrega](#status-da-entrega)
diz, item por item, o que foi verificado, o que está no código sem validação e o
que não foi feito.

## Stack

| Item | Escolha |
|---|---|
| Runtime / package manager / test runner | Bun 1.x |
| Linguagem | TypeScript (modo estrito) |
| Framework | NestJS |
| ORM | MikroORM 6.6 (`ReflectMetadataProvider`) |
| Banco | PostgreSQL 16 |
| Mensageria | AWS SQS via LocalStack 4.2 |
| Orquestração local | Docker Compose |

Prisma e outros ORMs ficaram fora, conforme o escopo.

## Como rodar

Pré-requisitos: Bun, Docker e Docker Compose.

```bash
# 1. Infraestrutura: PostgreSQL + LocalStack
docker compose up -d
docker compose ps            # postgres e localstack devem estar "healthy"

# 2. Dependências
bun install

# 3. Migrations (confira o nome exato do script em package.json)
bun run migration:up

# 4. Aplicação, porta 3000
bun run start                # equivale a: bun src/main.ts
```

| Serviço | Container | Porta |
|---|---|---|
| `postgres` | `wallet-postgres` (postgres:16-alpine) | 5432 |
| `localstack` | `wallet-localstack` (localstack/localstack:4.2) | 4566 |

Banco local: `wallets` (usuário `postgres`).

### Testes

```bash
bun test
```

> A suíte **não foi executada** na etapa em que a entrega foi encerrada, então
> não há resultado a informar. Não afirmo que ela passa.

### Verificação rápida

```bash
curl -i http://127.0.0.1:3000/health/live
curl -i http://127.0.0.1:3000/health/ready
```

`/health/ready` responde `{"status":"ready","checks":{"postgresql":"up","sqs":"up"}}`
quando PostgreSQL e SQS estão alcançáveis.

## API

| Método | Rota | Finalidade |
|---|---|---|
| `POST` | `/wallets` | Criar wallet (saldo inicial gera a transação interna `OPENING`) |
| `GET` | `/wallets/:walletId` | Consultar wallet |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=` | Ledger paginado |
| `POST` | `/wallets/:walletId/reconciliation` | Comparar saldo armazenado com o calculado pelo ledger |
| `POST` | `/wagering/transactions` | Submeter transação (header `Idempotency-Key` obrigatório) |
| `GET` | `/wagering/transactions/:transactionId` | Consultar transação por id |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consultar por id do provedor |
| `GET` | `/health/live` | Liveness |
| `GET` | `/health/ready` | Readiness (PostgreSQL e SQS) |
| `GET` | `/metrics` | Métricas |

Exemplos:

```bash
# criar wallet
curl -i -X POST http://127.0.0.1:3000/wallets \
  -H 'Content-Type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"100.00","currency":"BRL"}}'

# submeter uma aposta
curl -i -X POST http://127.0.0.1:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"<playerId>","walletId":"<walletId>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

Valores monetários trafegam como string decimal com 2 casas
(`{"amount":"25.00","currency":"BRL"}`), nunca como número.

## Desenho adotado

### Refletido no código

Estes pontos aparecem nas entidades, nas tabelas e nas consultas dos
repositórios:

- **Cinco entidades persistidas:** wallet, transação de aposta, lançamento de
  ledger, mensagem de inbox e mensagem de outbox.
- **Idempotência no banco, não em memória.** A transação é gravada com
  `INSERT ... ON CONFLICT DO NOTHING`, com `idempotency_key` e `payload_hash`
  como colunas próprias. Isso permite distinguir replay (mesmo hash) de conflito
  (mesma chave, payload diferente).
- **Resultado guardado na própria transação** (`resulting_balance` e
  `resulting_version`), para que um replay devolva o resultado original, com o
  saldo observado na época.
- **Referências fora de ordem:** a transação tem `reference_external_transaction_id`,
  `reference_transaction_id`, `reference_attempts` e `reference_next_attempt_at`,
  que sustentam o estado `PENDING_REFERENCE` e o reprocessamento com backoff.
- **Rejeição auditável:** a transação carrega `status` e `failure_code`.
- **Inbox persistente** por consumidor e mensagem, e **outbox** com
  `next_attempt_at` para publicação com retentativa.
- **Dinheiro sem `number`:** valor e moeda em colunas separadas.
- **Logs estruturados em JSON**, com `service` e `pid`, e endpoints de health e
  `/metrics`.

### Previsto no projeto, ainda não validado

Decisões de desenho definidas antes da implementação. **Não confirmei que o
código atual as cumpre:**

- Lock pessimista por wallet (`SELECT ... FOR UPDATE`), travando sempre a wallet
  primeiro para evitar deadlock.
- Ledger imutável por trigger no banco (bloqueio de `UPDATE` e `DELETE`).
- Saldo nunca negativo por `CHECK` no schema.
- Estorno único por índice parcial em `(reference_transaction_id, kind)`.
- Outbox publicada por workers com `FOR UPDATE SKIP LOCKED` e backoff, entrega
  at-least-once, com consumidores deduplicando por `eventId`.
- Publicação de eventos somente depois do commit, na mesma transação do efeito
  financeiro (padrão transactional outbox).
- SQS FIFO com `MessageGroupId = walletId` como otimização de ordenação. A
  garantia final fica com o banco.
- Autenticação: não implementada, com ponto de extensão previsto
  (`AuthGuard` no-op e `ProviderIdentityPort`), conforme a seção 2 do escopo.

## Status da entrega

| Área | Estado |
|---|---|
| Aplicação sobe no Bun com NestJS e MikroORM | Verificado |
| Conexão com PostgreSQL | Verificado |
| Conexão com SQS (LocalStack) | Verificado (`/health/ready`) |
| Schema com as 5 tabelas no banco | Verificado (as tabelas existem) |
| Health checks `live` e `ready` | Verificado |
| Rotas de wallet, wagering, reconciliação e métricas | Mapeadas; comportamento **não validado** |
| Criação de wallet (`POST /wallets`) | **Com defeito** (ver abaixo) |
| Idempotência, replay e conflito de payload | Código presente; **não validado** |
| Concorrência (aposta 50× em paralelo, 2 apostas × 80 sobre saldo 100) | **Não validado** |
| REFUND, ROLLBACK e referências fora de ordem | Código possivelmente presente; **não validado** |
| Worker da outbox | **Não validado** |
| Consumidor SQS (inbox, ack após commit, DLQ) | **Não validado** |
| Reconciliação | Rota mapeada; **não validada** |
| Suíte de testes | **Não executada** |
| `ARCHITECTURE.md` | **Não escrito** |
| Teste de carga (opcional) | Não feito |

## Limitações conhecidas

### Defeito conhecido: `POST /wallets` retorna 500

```
HTTP/1.1 500
{"error":{"code":"INTERNAL_ERROR","message":"unexpected error"}}
```

O log do PostgreSQL mostra o motivo:

```
ERROR:  there is no parameter $1 at character 396
STATEMENT:  INSERT INTO wager_transactions ...
```

O `INSERT` chega ao banco com os marcadores `$1..$22` no texto e sem valores.
**Causa provável, não confirmada no código:** consultas SQL cruas escritas com
marcadores `$N` do PostgreSQL e executadas pelo MikroORM, que espera `?`. Os
mesmos marcadores aparecem em:

| Arquivo | Linha | Consulta |
|---|---|---|
| `src/infrastructure/repositories/wager-transaction.repository.ts` | 74 | `INSERT ... ON CONFLICT DO NOTHING` |
| `src/infrastructure/repositories/inbox.repository.ts` | 22 | `INSERT` da inbox |
| `src/infrastructure/repositories/outbox.repository.ts` | 27 | seleção da outbox por `next_attempt_at` |

Como a gravação da transação é o primeiro passo do fluxo, **este defeito
impede ponta a ponta** a criação de wallet e o processamento de apostas, e
provavelmente afeta também a inbox e a outbox.

**Correção prevista:** trocar `$N` por `?` mantendo a ordem dos valores (ou usar
o QueryBuilder com `onConflict().ignore()`), conferindo se algum marcador se
repete. Há ainda uma hipótese secundária: o log mostrou o `INSERT` da transação
`OPENING` antes de qualquer `INSERT` em `wallets`, o que pode violar a chave
estrangeira de `wallet_id`. Se for o caso, a ordem correta dentro da mesma
transação é wallet, `OPENING`, lançamento no ledger e outbox.

### Outras limitações

- Nenhuma garantia de correção financeira ou de concorrência foi demonstrada
  por teste executado. O desenho descreve a intenção, e o status acima descreve
  a realidade.
- Não sei se os testes de integração existentes exercitam as consultas cruas
  contra o banco real, o que explicaria o defeito não ter sido detectado.
- Sem `ARCHITECTURE.md`: as justificativas de lock, ORM, hash canônico e
  taxonomia de `failureCode` estão só neste README e no `AGENTS.md`.

## O que eu faria com mais tempo

1. Corrigir os marcadores das consultas cruas e validar `POST /wallets`.
2. Executar `bun test` e transformar os cenários obrigatórios do escopo em
   testes de concorrência com paralelismo real:
   - a mesma aposta enviada 50 vezes em paralelo gera um único débito;
   - saldo `100.00` com duas apostas de `80.00` simultâneas: uma `PROCESSED`,
     uma `REJECTED`, saldo final `20.00`, um único lançamento de débito;
   - invariante final: saldo da wallet igual ao saldo reconstruído pelo ledger.
3. Validar REFUND, ROLLBACK e `PENDING_REFERENCE`, depois a outbox com dois
   publishers e o consumidor SQS com redelivery e DLQ.
4. Escrever o `ARCHITECTURE.md` com as decisões efetivamente implementadas.
5. Teste de carga e observabilidade adicional.

## Contexto da entrega

O desenvolvimento usou agentes de IA para programação, como o desafio permite.
O trabalho foi interrompido antes de terminar a validação, por limite de uso da
ferramenta de IA, e esta entrega registra o ponto exato em que parou.