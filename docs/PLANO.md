# PLANO.md — Plano de execução

Marque cada tarefa ao concluir (`[x]`). Uma tarefa por sessão do agente.
O escopo completo está em `docs/ESCOPO.md`; cada tarefa cita as seções
relevantes. **Leia só essas seções.**

## Ciclo de cada tarefa

1. `/new` (sessão nova).
2. Agente **Plan**: pedir o plano da tarefa (máx. 10 linhas) e revisar.
3. Agente **Build**: executar o plano aprovado.
4. Eu rodo os testes, leio o diff e faço commit.
5. Marcar a tarefa aqui.

### Prompt padrão (Plan)

```
Leia AGENTS.md e a tarefa N em docs/PLANO.md. Leia em docs/ESCOPO.md só as
seções: [X, Y]. Proponha o plano em até 10 linhas, apontando dúvidas ou
ambiguidades. Não escreva código ainda.
```

### Prompt padrão (Build, após aprovar)

```
Plano aprovado. Execute a tarefa N. Escreva os testes junto, rode `bun test`
e mostre o resultado. Não altere nada fora do escopo da tarefa. No final,
liste arquivos alterados, decisões tomadas e pendências.
```

---

## Definition of Done global

- [ ] `bun test` passa (unidade, integração e concorrência).
- [ ] `docker compose up` sobe tudo do zero.
- [ ] Migrations sobem e descem sem erro.
- [ ] Nenhum `number` representando dinheiro.
- [ ] `wallet.balance == soma do ledger` em todos os testes de concorrência.
- [ ] `README.md` e `ARCHITECTURE.md` completos.

---

## Tarefas

### [ ] 0. Esqueleto e infraestrutura
**Seções:** 4, 12 · **Modelo:** leve

- Projeto Bun + NestJS + TypeScript `strict`.
- `docker-compose.yml` com PostgreSQL e LocalStack (SQS).
- Config validada por variáveis de ambiente.
- `GET /health/live` e `GET /health/ready` (checa Postgres e SQS), sem auth.
- Um teste mínimo passando com `bun test`.

**Risco a validar já aqui:** NestJS (decorators e injeção de dependência) e
MikroORM funcionam no Bun? O suporte a `emitDecoratorMetadata` pode ser
limitado. Se for, usar `@Inject()` explícito nos providers e mapear o ORM com
`EntitySchema` (mantém o domínio sem decorators). Documentar o que foi feito.

**Pronto quando:** `docker compose up -d && bun run start` responde nos dois
endpoints de health.

---

### [ ] 1. Money
**Seções:** 6.1 · **Modelo:** médio

- Classe `Money` imutável, construtor privado, `from`, `zero`, `add`,
  `subtract`, `negate`, comparações, `toJSON`, `toString`.
- Escala fixa de 2 casas. Rejeitar: `NaN`, `Infinity`, notação científica,
  string vazia, mais de 2 casas, negativos em contratos de entrada.
- Moedas diferentes lançam erro de domínio.

**Testes:** escala, arredondamento, entradas inválidas, conflito de moeda,
imutabilidade, valores grandes.

---

### [ ] 2. Domínio puro
**Seções:** 6, 7, 11 · **Modelo:** médio

- `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`,
  `OutboxMessage`, `IntegrationEvent` e as 4 subclasses de evento.
- Factories estáticas (`create`, `from`, `open`, `rehydrate`), construtores
  privados.
- Transições de `WagerTransaction` definidas e documentadas; estados terminais
  lançam `InvalidTransactionStateError`.
- Taxonomia de `FailureCode` (ver "Decisões a documentar").
- `WalletLedgerEntry` imutável; `create` valida a aritmética.

**Testes:** invariantes da Wallet, regras de BET/WIN/LOSS/REFUND/ROLLBACK,
transições válidas e inválidas, ledger desbalanceado rejeitado.

---

### [ ] 3. Schema e migrations
**Seções:** 5 (item 9), 6 · **Modelo:** forte

Tabelas: `wallets`, `wager_transactions`, `wallet_ledger_entries`,
`inbox_messages`, `outbox_messages`.

Garantias **no banco**:

- `wallets`: `UNIQUE(player_id, currency)`; `CHECK(balance >= 0)`;
  `version` inicia em 1.
- `wager_transactions`: `UNIQUE(idempotency_key)`;
  `UNIQUE(provider_id, external_transaction_id)`; status e kind com `CHECK`;
  índice único parcial para estorno único por `(reference_transaction_id, kind)`.
- `wallet_ledger_entries`: `UNIQUE(transaction_id, wallet_id)`;
  `CHECK` de que `balance_after = balance_before ± amount` conforme a direção;
  **trigger** que bloqueia `UPDATE` e `DELETE`.
- `inbox_messages`: PK `(consumer_name, message_id)`.
- `outbox_messages`: índice em `(published_at, next_attempt_at)` para o worker.
- Valores em `NUMERIC(20,2)`.

Migrations versionadas **e reversíveis**.

**Testes (integração, Postgres real):** cada constraint viola quando deveria;
UPDATE/DELETE no ledger falham; saldo negativo falha; migration up/down/up.

---

### [ ] 4. Mapeamento ORM e fronteira transacional
**Seções:** 4, 6 · **Modelo:** médio

- Mapear as entidades de domínio (preferir `EntitySchema`/mapeamento externo
  para manter o domínio puro). `Money` como duas colunas, reidratado com
  `Money.from`.
- Repositórios como portas no `application/`, implementações no
  `infrastructure/`.
- Uma abstração de transação (`transactional()`) usada pelos use cases.

**Testes:** salvar e reidratar cada agregado; round-trip de `Money` sem perda.

---

### [ ] 5. Use case SubmitWagerTransaction (núcleo)
**Seções:** 7, 8, 9 · **Modelo:** forte · **A tarefa mais importante**

Fluxo numa única transação SQL:

1. Inserir a transação de forma idempotente (`ON CONFLICT DO NOTHING`).
   Se já existia: payload igual → replay com o resultado original;
   payload diferente → conflito.
2. Travar a wallet (`FOR UPDATE`).
3. Validar regras (moeda, player, saldo).
4. Aplicar saldo + gravar ledger + gravar saldo observado.
5. Gravar eventos na outbox.
6. Commit.

Cobrir BET, WIN, LOSS aqui. LOSS não gera ledger. Rejeição não altera saldo.

**Testes de concorrência (paralelismo real):**

- Mesma aposta ×50 em paralelo → exatamente 1 débito.
- Saldo 100, duas apostas de 80 simultâneas → 1 `PROCESSED`, 1 `REJECTED`,
  saldo 20, 1 lançamento de débito.
- Wallets distintas em paralelo.
- Invariante final: saldo == ledger.

---

### [ ] 6. REFUND, ROLLBACK e referências fora de ordem
**Seções:** 7, 7.1, 7.2 · **Modelo:** forte

- Resolver a referência por `(providerId, referenceExternalTransactionId)`;
  validar mesmo provider, player, wallet, moeda e rodada.
- REFUND só referencia BET; ROLLBACK referencia BET, WIN ou REFUND.
- Valor igual ao da referência; estorno único por tipo.
- Rollback que levaria a saldo negativo → `REJECTED` com `failureCode`
  distinto do de saldo insuficiente.
- Referência ausente → `PENDING_REFERENCE` + evento.
- Worker agendado com backoff exponencial; limite de tentativas/TTL; esgotado
  → `REJECTED` com código de referência inexistente + evento.

**Testes:** estorno antes da referência; estorno duplicado concorrente;
rollback que estoura saldo; TTL esgotado.

---

### [ ] 7. API HTTP
**Seções:** 9 · **Modelo:** médio

- `POST /wallets` (cria `OPENING` + `CREDIT` na mesma transação; duplicada →
  conflito).
- `GET /wallets/:id`, `GET /wallets/:id/ledger?cursor&limit` (cursor opaco e
  estável), `GET /wagering/transactions/:id`,
  `GET /providers/:providerId/wagering/transactions/:externalTransactionId`.
- `POST /wagering/transactions` com `Idempotency-Key` obrigatório.
- Rejeitar `kind = OPENING`.
- `AuthGuard` no-op + `ProviderIdentityPort`.
- Mapeamento de status HTTP consistente (ver "Decisões a documentar").

**Testes:** contratos, validação de payload, replay, conflito, paginação.

---

### [ ] 8. Reconciliação
**Seções:** 9 · **Modelo:** leve

- `POST /wallets/:id/reconciliation` recalcula pelo ledger e compara.
- Divergência não é corrigida: log + métrica + sinalizada na resposta.

**Testes:** consistente; divergência forçada manualmente no banco é detectada.

---

### [ ] 9. Worker da outbox
**Seções:** 11 · **Modelo:** forte

- Seleção com `FOR UPDATE SKIP LOCKED`, publica, marca publicada.
- Falha → `scheduleRetry` com backoff.
- Funciona com vários publishers concorrentes.

**Testes:** 2+ publishers sobre a mesma outbox sem perder nem duplicar sem
controle; crash após commit e antes da publicação → outra instância publica;
publicação duplicada é segura para o consumidor.

---

### [ ] 10. Consumidor SQS
**Seções:** 10 · **Modelo:** forte

- Reutilizar o mesmo use case da entrada HTTP.
- Inbox persistente por `(consumerName, messageId)`, na mesma transação.
- `ack` só após o commit.
- Erro de negócio → ack; transitório → retry com backoff; permanente → DLQ.
- Limite de tentativas antes da DLQ.
- `SIGTERM`: concluir mensagens em andamento ou devolver a visibilidade.

**Testes:** redelivery sem duplicar efeito; morte entre commit e ack;
mensagem venenosa vai para a DLQ; shutdown gracioso.

---

### [ ] 11. Observabilidade
**Seções:** 12 · **Modelo:** leve

- Logs JSON com `correlationId`, `messageId`, `transactionId`, `walletId`,
  `providerId`; sem payload financeiro completo.
- Métricas: transações por status, duplicatas, retries, DLQ, conflitos de lock,
  outbox lag, latência. Endpoint `/metrics`.

---

### [ ] 12. Testes de concorrência multiprocesso e falhas
**Seções:** 13 · **Modelo:** forte

- ≥ 3 processos simultâneos (spawn de processos reais).
- Worker morto entre commit e ack.
- Dois publishers na mesma outbox.
- REFUND/ROLLBACK antes da referência.
- Reinício do serviço com consistência final comprovada.
- Invariante final: saldo == ledger.

---

### [ ] 13. Documentação
**Seções:** 2, 5, 8 · **Modelo:** leve

- `README.md`: setup, comandos, como rodar testes.
- `ARCHITECTURE.md`: estratégia de concorrência e justificativa, idempotência,
  hash canônico, transações, outbox/inbox, taxonomia de `failureCode`,
  mapeamento HTTP, escolha do ORM e do `Money`, decisão sobre autenticação,
  trade-offs e limitações.

---

### [ ] 14. Opcionais (só se sobrar tempo)
**Seções:** 14

- `bun run test:load` com metodologia, throughput, p50/p95/p99, taxa de erro,
  conflitos e outbox lag.
- Ledger de partidas dobradas.
- OpenTelemetry.

---

## Decisões a documentar (ARCHITECTURE.md)

Propostas iniciais. Ajustar se houver motivo e registrar o porquê.

**Transições de `WagerTransaction`:**
`PENDING → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE`;
`PENDING_REFERENCE → PROCESSED | REJECTED | FAILED`. Terminais:
`PROCESSED`, `REJECTED`, `FAILED`.

**`failureCode` (taxonomia sugerida):**

| Código | Quando |
|---|---|
| `INSUFFICIENT_FUNDS` | BET sem saldo |
| `REVERSAL_WOULD_OVERDRAW` | rollback levaria a saldo negativo |
| `WALLET_NOT_FOUND` | wallet inexistente |
| `PLAYER_WALLET_MISMATCH` | wallet não pertence ao player |
| `CURRENCY_MISMATCH` | moeda difere da wallet |
| `REFERENCE_REQUIRED` | REFUND/ROLLBACK sem referência |
| `REFERENCE_NOT_FOUND` | referência não apareceu até o TTL |
| `REFERENCE_MISMATCH` | provider, player, wallet, moeda ou rodada diferem |
| `REFERENCE_KIND_NOT_ALLOWED` | tipo de referência inválido |
| `REFERENCE_NOT_PROCESSED` | referência foi rejeitada ou falhou |
| `REFERENCE_ALREADY_REVERSED` | estorno repetido do mesmo tipo |
| `AMOUNT_MISMATCH` | valor difere do da referência |
| `INTERNAL_ERROR` | falha permanente de infraestrutura (`FAILED`) |

**Mapeamento HTTP sugerido (consistente em todos os endpoints):**

| Situação | Status |
|---|---|
| Payload inválido | `400` |
| Conflito de idempotência (mesma key, payload diferente) | `409` |
| Rejeição por regra de negócio | `422` com `failureCode` |
| Processada | `200` (ou `201` na primeira vez) |
| Aceita com processamento pendente (`PENDING_REFERENCE`) | `202` |
| Falha transitória de infraestrutura | `503` com `Retry-After` |

**Ambiguidades do escopo a decidir e registrar:**

- Uma mesma BET pode receber REFUND **e** ROLLBACK? O escopo só proíbe repetir
  o mesmo tipo. Decidir se bloqueia a combinação (mais seguro financeiramente).
- Referência existente mas ainda `PENDING_REFERENCE`: tratar como pendente.
- `ROLLBACK` de `LOSS` (sem efeito no saldo): permitido? Rejeitar?
- Nome e destino da fila/tópico de eventos de saída (a outbox publica para onde).
- TTL e número máximo de tentativas de `PENDING_REFERENCE` e justificativa.
- Replay de transação `REJECTED` devolve o mesmo resultado e o mesmo status.
