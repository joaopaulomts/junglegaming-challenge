# AGENTS.md — Serviço financeiro distribuído de apostas

Leia este arquivo sempre. O escopo completo está em `docs/ESCOPO.md` e o plano
de trabalho em `docs/PLANO.md`.

## Como trabalhar (obrigatório)

- Faça **uma tarefa por vez**, a que eu indicar do `docs/PLANO.md`.
- **Não leia `docs/ESCOPO.md` inteiro.** Leia só as seções citadas na tarefa.
- Antes de codar, apresente o plano em **até 10 linhas** e liste dúvidas ou
  ambiguidades. Espere minha aprovação.
- Escreva os testes junto com o código. Rode `bun test` antes de dizer que
  terminou e mostre o resultado real.
- Não altere arquivos fora do escopo da tarefa. Não adicione dependências sem
  avisar e justificar.
- Se algo do escopo for ambíguo, **pergunte**. Não invente regra de negócio.
- Ao terminar, liste: arquivos criados/alterados, decisões tomadas e o que
  ficou pendente. Anote decisões relevantes em `ARCHITECTURE.md`.

## Stack

Bun 1.x (runtime, package manager e test runner), TypeScript em modo estrito,
NestJS, PostgreSQL, MikroORM, AWS SQS via LocalStack, Docker Compose.
Prisma e outros ORMs estão fora do escopo.

## Regras invioláveis

1. Dinheiro **nunca** é `number`/`float`/`double`. Use `Money` imutável, string
   decimal com 2 casas, biblioteca decimal (ex.: `decimal.js`).
2. Idempotência **persistente no banco**. Nunca cache em memória como garantia.
3. Unicidade, imutabilidade e não-negatividade garantidas **no schema**
   (UNIQUE, CHECK, trigger), não só no código.
4. Ledger imutável: sem UPDATE/DELETE (trigger no banco bloqueando).
5. Evento só entra na outbox **na mesma transação SQL** do efeito financeiro.
   Nada é publicado antes do commit.
6. Nada de lock global. A unidade de concorrência é a `walletId`.
7. Proibido `read → calculate → update` sem controle de concorrência.
8. Tem que estar correto com **múltiplas instâncias** da aplicação.
9. SQS FIFO é otimização, não garantia. O banco garante as invariantes.
10. `OPENING` é interno: nunca aceito pela API nem pela fila.
11. Domínio **sem** dependência de NestJS, decorators ou ORM.

## Decisões propostas (podem ser ajustadas; documentar em ARCHITECTURE.md)

- **Concorrência:** lock pessimista por wallet (`SELECT ... FOR UPDATE`) dentro
  da transação. Sempre travar a wallet **primeiro** para evitar deadlock.
- **Idempotência:** `UNIQUE(idempotency_key)` e
  `UNIQUE(provider_id, external_transaction_id)`; `INSERT ... ON CONFLICT DO
  NOTHING`; comparar `payload_hash`. Guardar na própria transação o saldo
  observado, para o replay devolver o resultado original.
- **Hash do payload:** SHA-256 de JSON canônico (chaves ordenadas) só dos campos
  de negócio. Header e metadados de transporte não entram.
- **Inbox:** PK `(consumer_name, message_id)`.
- **Outbox:** publishers com `FOR UPDATE SKIP LOCKED`, backoff exponencial,
  entrega at-least-once. Consumidores deduplicam por `eventId`.
- **Estorno único:** índice único parcial em `(reference_transaction_id, kind)`
  para REFUND/ROLLBACK processados.
- **SQS:** `MessageGroupId = walletId`; DLQ também FIFO; redrive com
  `maxReceiveCount`.
- **Dinheiro no banco:** `NUMERIC(20,2)` + coluna `currency`.
- **Autenticação:** não implementar. `AuthGuard` no-op + porta
  `ProviderIdentityPort`, documentados.

## Estrutura de pastas sugerida

```
src/
  domain/          # Money, Wallet, WagerTransaction, LedgerEntry, Inbox/Outbox, eventos
  application/     # use cases e portas (repositórios, publisher, clock)
  infrastructure/  # MikroORM, migrations, SQS, outbox worker, métricas
  interfaces/      # http (controllers) e sqs (consumer)
test/              # unit, integration, concurrency
docs/              # ESCOPO.md, PLANO.md
```

## Testes

- Unidade: domínio puro, sem I/O.
- Integração: PostgreSQL e LocalStack **reais** em containers. Sem mocks no
  lugar deles.
- Concorrência: paralelismo real (`Promise.all`, múltiplos processos). Nada de
  loop sequencial fingindo concorrência.
- Invariante final de todos os testes: `wallet.balance == saldo reconstruído
  pelo ledger`.

## Comandos (preencher conforme o projeto for criado)

```
docker compose up -d        # Postgres + LocalStack
bun install
bun test                    # todos os testes
bun run migration:up        # aplicar migrations
bun run migration:down      # reverter
bun run start
```

## Logs e segurança

- Logs estruturados (JSON) com `correlationId`, `messageId`, `transactionId`,
  `walletId`, `providerId`.
- Não logar payload financeiro completo nem dados sensíveis.
