# Araucaria LiveScore — Collector Architecture

> Documento de referência da arquitetura do **External Collector** do Araucaria LiveScore.
>
> Este componente é responsável por descobrir, acompanhar e coletar **todos os contests ativos simultaneamente**, independentemente do que estiver sendo visualizado no frontend.

---

## 1. Regra principal

> **O Araucaria LiveScore deve descobrir e coletar simultaneamente todos os contests ativos disponíveis nas fontes externas.**

O collector não trabalha com um único "contest atual".

Exemplo:

```text
Contest A ─┐
Contest B ─┤
Contest C ─┼──► collector
Contest D ─┤
Contest E ─┘
```

Se cinco contests estiverem ativos, os cinco devem ser coletados.

---

## 2. Separação entre coleta e interface

A escolha do usuário na interface não controla o collector.

```text
BACKEND
coleta:
- Contest A
- Contest B
- Contest C
- Contest D

FRONTEND
usuário visualiza:
- Contest B
```

Trocar para Contest C muda apenas a consulta da interface.

---

## 3. Fontes iniciais

O collector deverá ser modular.

Fontes previstas:

```text
contest.run
Contest Online ScoreBoard
HAMSCORE
```

Cada fonte terá seu próprio adapter:

```text
ContestRunAdapter
CosbAdapter
HamScoreAdapter
```

Todos devem entregar os dados ao mesmo Normalizer.

---

## 4. Arquitetura

```text
                ┌────────────────────┐
                │ Discovery Scheduler│
                └─────────┬──────────┘
                          │
          ┌───────────────┼────────────────┐
          ▼               ▼                ▼
     contest.run          COSB          HAMSCORE
          │               │                │
          └───────────────┼────────────────┘
                          ▼
                 Contest Registry
                          │
                          ▼
               Active Contest Manager
                          │
             ┌────────────┼────────────┐
             ▼            ▼            ▼
         Contest A    Contest B    Contest C
            poll         poll         poll
             │            │            │
             └────────────┼────────────┘
                          ▼
                      Adapters
                          │
                          ▼
                     Normalizer
                          │
                          ▼
                    Deduplicator
                          │
                          ▼
                        MySQL
```

---

## 5. Contest discovery

### 5.1. contest.run

Endpoints identificados:

```text
GET https://contest.run/api/contest/nearest
```

e como complemento:

```text
GET https://contest.run/api/contest/month/{month}
```

Campos relevantes:

```text
testid
name
dat
startday
starttime
finishday
finishtime
```

O POC read-only de 2026-09-11 não observou `startdate` nem `enddate`. A
semântica de `dat`, o ano e o timezone ainda não são conhecidos. Para
`contest.run`, discovery deve registrar candidatos e seus campos raw, mas não
deve derivar janelas absolutas de WARMUP/ACTIVE/FINISHING com esses valores.

O `testid` é o ID utilizado posteriormente em:

```text
GET /api/displayscore/{testid}
```

### 5.2. Estratégia de discovery

Executar discovery periodicamente:

```text
a cada 5–10 minutos
```

Fluxo:

```text
fetch contests
     │
     ▼
normalizar identificação
     │
     ▼
comparar com MySQL
     │
     ├── contest novo
     ├── contest existente
     └── contest encerrado
     │
     ▼
atualizar Contest Registry
```

---

## 6. Contest Registry

O registry representa todos os contests conhecidos naquele momento.

Exemplo:

```text
external_id  name                start       end         status
41           CQ WPX CW           00:00       23:59       ACTIVE
52           ARI DX              12:00       23:59       ACTIVE
67           Helvetia            13:00       15:00       ACTIVE
88           Florida QSO Party   16:00       02:00       UPCOMING
```

O registry pode existir em memória e persistir os dados essenciais no MySQL.

---

## 7. Estados do contest

Estados recomendados:

```text
UPCOMING
WARMUP
ACTIVE
FINISHING
FINISHED
DISABLED
```

### Regras conceituais

```text
WARMUP:
start_at - 30 min <= agora < start_at

ACTIVE:
start_at <= agora <= end_at

FINISHING:
end_at < agora <= end_at + 60 min

FINISHED:
agora > end_at + 60 min
```

A tolerância poderá ser configurável.

Essas regras de estado continuam válidas para fontes que fornecem `start_at` e
`end_at` confiáveis. Para `contest.run`, a semântica de calendário observada não
é suficiente para aplicá-las em produção. Não construir scheduling de contests
ativos a partir de uma interpretação adivinhada de `dat`, `startday` ou
`finishday`.

---

## 8. Por que coletar antes e depois

Começar antes ajuda a capturar:

- stations que começam a enviar score antecipadamente;
- inconsistências de horário;
- alterações de configuração;
- pré-carregamento de categorias.

Continuar depois ajuda a capturar:

- último update;
- score final;
- loggers que publicam com atraso;
- correções imediatas.

---

## 9. Scheduler de polling

Cada contest ativo possui um job lógico de polling.

Exemplo:

```text
Contest 41 → a cada ~60s
Contest 52 → a cada ~60s
Contest 67 → a cada ~60s
Contest 88 → a cada ~60s
```

Não disparar todos simultaneamente.

---

## 10. Staggering

Se houver cinco contests:

```text
00s → contest 41
12s → contest 52
24s → contest 67
36s → contest 88
48s → contest 103

60s → contest 41
72s → contest 52
...
```

Objetivos:

- evitar bursts;
- reduzir impacto na fonte;
- distribuir CPU/rede;
- diminuir chance de rate limiting.

O scheduler deve recalcular o spacing conforme o número de contests ativos.

---

## 11. Poll interval

Valor inicial recomendado:

```text
60 segundos por contest
```

Não assumir que todas as fontes aceitarão esse intervalo.

Cada adapter poderá definir:

```text
min_poll_interval
default_poll_interval
backoff_policy
```

Exemplo:

```text
contest.run    60s
COSB           60–120s
HAMSCORE       60–120s
```

Os valores definitivos dependem dos testes e das políticas de cada serviço.

---

## 12. Coleta do contest.run

Endpoint principal identificado:

```text
GET https://contest.run/api/displayscore/{testid}
```

Exemplo:

```text
GET https://contest.run/api/displayscore/40
```

A resposta contém dados de múltiplas estações.

Campos identificados incluem:

```text
sign
date
score
soft

qtotal
q160
q80
q40
q20
q15
q10

ptotal
p160
p80
p40
p20
p15
p10

mtotal
m160
m80
m40
m20
m15
m10
```

Também existem metadados de categoria e localização.

Uma linha retornada por `displayscore` não prova que a estação esteja ativa no
momento do poll. O POC observou linhas com timestamps históricos. A freshness da
estação deve ser calculada a partir do `source_timestamp` da própria linha, com
fallback explícito apenas quando necessário; a presença da linha não deve criar
ou prolongar atividade por si só.

### 12.1. Sinais distintos de estado da fonte

O collector deve registrar estes quatro conceitos separadamente:

| Sinal | Definição |
| --- | --- |
| `PRESENT` | A linha existe na resposta da fonte. |
| `FRESH` | O timestamp da fonte está dentro do limiar configurado de freshness. |
| `REPORTING` | O timestamp da fonte avançou em relação à observação aceita anterior. |
| `SCORING` | Uma ou mais métricas competitivas mudaram. |

Nenhum desses sinais implica automaticamente qualquer outro. Uma linha pode ser
`PRESENT` e stale; `REPORTING` sem `SCORING` quando apenas o timestamp muda; ou
`SCORING` com uma correção negativa. A classificação canônica e a apresentação
operacional devem preservar essa distinção.

---

## 13. Categorias

Para contest.run:

```text
GET https://contest.run/api/category/contest/{testid}
```

As categorias não precisam ser consultadas a cada poll.

Estratégia:

```text
contest novo
     │
     ▼
carregar categorias
     │
     ▼
salvar/cachear
```

Atualizar novamente apenas:

- em discovery periódico;
- se houver mudança detectada;
- por TTL, por exemplo 30–60 min.

---

## 14. Fluxo de um poll

```text
scheduler
   │
   ▼
adapter.poll(contest)
   │
   ▼
HTTP GET
   │
   ├── success
   │      │
   │      ▼
   │  raw response
   │      │
   │      ▼
   │  save raw_message
   │      │
   │      ▼
   │  normalize
   │      │
   │      ▼
   │  deduplicate
   │      │
   │      ▼
   │  persist snapshots
   │
   └── failure
          │
          ▼
        retry/backoff
```

---

### 14.1 Phase 2E.5 bounded polling execution

The implemented reusable cycle is `CollectorPollingService.runCycle`, not a
long-running daemon. It selects enabled due `collector_source_contests` in
deterministic order, with a per-cycle maximum. It uses no inferred contest.run
activity or timestamp semantics.

Each mapping attempts a non-blocking, dedicated-session MySQL advisory lock
named `als:<environment>:csc:<mapping-id>`. The losing worker reports
`LOCKED_BY_OTHER` and does not fetch, persist a raw receipt, create a
`collector_runs` row, or change scheduling. A lock owner creates a `RUNNING`
run, performs the HTTP/ingestion work outside a long transaction, then
atomically finalizes the run and updates `last_success_at` or `last_failure_at`
plus `next_poll_at`. The physical lock is released and its connection closed in
`finally`.

`request_count` counts source HTTP attempts and `received_message_count` counts
durable payload receipts, not station rows. Invalid poll intervals are reported
without an invented fallback.

Real validation against Percona Server 5.7.44-48 passed using
`dxarauca_livescore_test`: a due mapping acquired its dedicated lock, completed
one `RUNNING` -> `SUCCESS` run, issued one request, and durably persisted one
linked raw receipt plus five snapshots. `last_success_at` and `next_poll_at`
advanced. An immediate cycle made zero HTTP requests because the mapping was
not due; a separately held lock returned `LOCKED_BY_OTHER` with zero HTTP calls,
zero collector runs, and no schedule mutation. Lock release and fixture cleanup
were verified. The five `UNZONED_SOURCE_TEXT` observations remained
non-canonical (`canonicalEventCount = 0`, `currentScoreCount = 0`).

### 14.2 Phase 2E.6 runtime and abandoned-run recovery

`CollectorRuntimeService.run` is the continuous operational layer around the
bounded polling cycle. It performs startup recovery once, then uses a
sequential `runCycle`/abortable-sleep loop rather than `setInterval`; a later
cycle cannot overlap a prior cycle in the same process. Mapping-level outcomes
remain contained in their completed cycle. Only a top-level infrastructure
failure emits `RUNTIME_CYCLE_FAILED` and waits the bounded runtime backoff
before retrying.

`RUNNING` is audit state, not durable lock ownership. Recovery considers only
rows older than the configured stale threshold and then attempts to reacquire
the same mapping lock, `als:<environment>:csc:<mapping-id>`, on a pinned
physical session. A held lock leaves the row unchanged as `ACTIVE_LOCK_HELD`.
Only successful lock reacquisition permits a conditional
`RUNNING`/`finished_at IS NULL` update to `FAILED` with the sanitized
`ABANDONED_RUN_RECOVERED` code. MySQL releases a connection-owned advisory lock
when its physical connection dies, which is why both age and reacquisition are
required.

For an enabled mapping with a valid interval, recovery atomically records
`last_failure_at` and advances `next_poll_at`. Disabled mappings are never
re-enabled; invalid/null intervals and unlinked runs are finalized without an
invented schedule. `SIGINT` and `SIGTERM` abort sleep and prevent a new cycle,
while allowing the active bounded cycle to finish before the entrypoint closes
the database pool. Structured, sanitized runtime events cover startup,
recovery, cycles, runtime failures, shutdown, and stop.

`DATABASE_URL` and `COLLECTOR_ENVIRONMENT` are required by `collector:run`.
Intentional defaults are a 30-second cycle, 10 mappings/cycle, 50 recovery
rows/batch, a 15-minute stale threshold, a 5-second runtime-failure backoff,
and a 60-second maximum backoff.

Real validation passed on Percona Server 5.7.44-48 using
`dxarauca_livescore_test`. The recovery scenarios were separate: (A) an
abandoned stale `RUNNING` row whose mapping lock was available was recovered as
`FAILED` with `ABANDONED_RUN_RECOVERED`, a `finished_at`, an advanced enabled
mapping failure schedule, and verified lock release; (B) a stale row whose same
mapping lock was held remained unchanged, with scheduling unchanged and an
active-lock skip result. Stale age alone is not abandonment evidence: recovery
requires stale age *and* successful reacquisition of the exact mapping lock.

Recovery ran before a finite runtime validation cycle. That cycle started and
completed once (`maxConcurrentCycles = 1`), made one displayscore HTTP request,
then honored shutdown without starting another cycle. The resulting
`UNZONED_SOURCE_TEXT` observations remained non-canonical
(`canonicalEventCount = 0`, `currentScoreCount = 0`), and fixture cleanup
returned zero rows. Distributed heartbeats/leases, platform deployment
configuration, source-specific retry policy, and automatic discovery
provisioning remain out of scope.

### 14.3 Phase 2E.7 durable discovery catalog synchronization

`ContestRunCatalogSyncService` is a bounded one-shot catalog operation; it is
not integrated into the continuous polling runtime. It resolves the existing
`CONTEST_RUN` source by stable code and refuses to create a production source
row if it is absent. It then acquires a dedicated source-global MySQL advisory
lock on a pinned physical session:
`als:<environment>:source:<source-id>:discovery`. A losing worker returns
`LOCKED_BY_OTHER` before HTTP, run audit, or catalog mutation.

The owner records a `collector_runs` audit row with a null mapping,
`run_kind = DISCOVERY`, `RUNNING` then `SUCCESS`/`FAILED`, exact discovery HTTP
request count, and `received_message_count = 0`; discovery bodies are not
durable raw receipts. HTTP completes outside transactions. Each discovered
contest is persisted in an independent short transaction resolving/creating the
contest, upserting its external identity/evidence, and ensuring one mapping.

New mappings are always disabled with no invented interval or schedule. Existing
enabled state, interval, configuration, and scheduling remain operator-owned;
only a null external identity link may be repaired when the exact source/testid
relationship makes it unambiguous. `DISCOVERED` means only known source catalog
identity, never active, reporting, scoring, upcoming, or running. Automatic
activation and discovery scheduling remain deferred.

#### Real Percona validation

The guarded Phase 2E.7 catalog validation passed on the real Percona 5.7.44-48
test target. It performed one nearest, one month, and two bounded category
requests, synchronized two unique source testids, and created two contests,
two external identities, and two disabled mappings. The same synchronization
immediately repeated created no duplicates and preserved an explicitly changed
operator mapping configuration.

No start/end/timezone or activity semantics were inferred, categories remained
source evidence, and no displayscore request, score snapshot, canonical event,
or current-score row was created. A separately held source-global discovery
lock returned `LOCKED_BY_OTHER` without mutation. The lock was released and the
isolated fixture cleanup returned zero rows.

---

## 15. Raw response

Todo poll deve poder ser auditado.

Armazenar:

```text
source
contest_external_id
requested_at
response_at
http_status
content_type
payload
payload_hash
processing_status
error
```

Isso permite:

- reproduzir bugs;
- revisar mudanças de API;
- reprocessar dados;
- provar o que a fonte devolveu.

---

## 16. Normalização

O adapter não deve escrever diretamente nas tabelas finais.

Fluxo:

```text
source-specific payload
        │
        ▼
source adapter
        │
        ▼
normalized snapshot
        │
        ▼
persistence layer
```

Exemplo de objeto normalizado:

```json
{
  "source": "CONTEST_RUN",
  "external_contest_id": "40",
  "callsign": "CR3W",
  "timestamp": "2026-09-10T22:31:00Z",
  "score": 1732224,
  "qso_total": 1619,
  "points_total": 4872,
  "mult_total": 240,
  "bands": [
    {"band":"80m","qso":298,"mult":40},
    {"band":"40m","qso":403,"mult":59},
    {"band":"20m","qso":477,"mult":67},
    {"band":"15m","qso":307,"mult":47},
    {"band":"10m","qso":134,"mult":27}
  ]
}
```

---

## 17. Persistência

Cada station recebida deve ser comparada com o estado conhecido.

Se for um novo update:

```text
INSERT score_snapshots
INSERT band_snapshots
UPSERT current_scores
```

Se for duplicata exata:

```text
não gerar novo snapshot
```

O raw message pode ser preservado para auditoria.

Para `contest.run`, persistir uma observação não equivale a classificá-la como
live. A classificação de freshness/stale pertence ao timestamp da observação e
às regras canônicas, não ao endpoint que a retornou.

---

## 18. Deduplicação

Uma mesma estação pode aparecer em múltiplas fontes.

Exemplo:

```text
CR3W
 ├── contest.run
 ├── COSB
 └── HAMSCORE
```

O collector precisa distinguir:

```text
mesmo estado replicado
```

de:

```text
novo update legítimo
```

Fingerprint sugerido:

```text
contest
callsign
source_timestamp
score
qso_total
payload_hash
```

A política detalhada deverá ficar em:

```text
source-priority-dedup.md
```

---

## 19. Prioridade de fontes

Ordem inicial:

```text
DIRECT LOGGER
    >
FEDERATION
    >
EXTERNAL SERVER
    >
MANUAL
```

Entre servidores externos, a prioridade poderá variar conforme:

- qualidade;
- timestamp;
- completude;
- atraso;
- disponibilidade de breakdown.

A prioridade não deve apagar a rastreabilidade da origem.

---

## 20. Falhas de rede

O collector deve ser tolerante a falhas.

Exemplo:

```text
HTTP 200
→ processa normalmente

timeout
→ registra erro
→ retry posterior

HTTP 429
→ aumenta intervalo
→ respeita Retry-After quando presente

HTTP 5xx
→ exponential backoff

JSON inválido
→ salva raw
→ marca parsing error
```

---

## 21. Backoff

Sugestão inicial:

```text
1ª falha → próximo retry em 60s
2ª falha → 120s
3ª falha → 240s
4ª falha → 480s
máximo    → 15 min
```

Após sucesso:

```text
retorna ao intervalo normal
```

---

## 22. Circuit breaker

Se uma fonte estiver falhando continuamente:

```text
CLOSED
→ funcionando

OPEN
→ muitas falhas
→ parar polls por curto período

HALF-OPEN
→ testar novamente
```

Isso evita bombardear um serviço indisponível.

Pode ser implementado depois do MVP se necessário.

---

## 23. Concorrência

Não usar um processo separado por contest.

Preferir:

```text
um scheduler
+
jobs assíncronos
+
limite de concorrência
```

Exemplo:

```text
max_concurrent_requests_per_source = 2 ou 3
```

Isso mantém o collector simples e controlável.

---

## 24. Descoberta de novos contests durante o dia

O discovery deve continuar rodando mesmo com contests ativos.

Exemplo:

```text
14:00
Contest A
Contest B

16:00 discovery
Contest C apareceu

→ registrar Contest C
→ carregar categorias
→ criar job
→ começar polling
```

Não é necessário reiniciar o backend.

---

## 25. Finalização automática

Quando um contest passar para `FINISHED`:

```text
parar polling
```

mas manter:

```text
contest registry
snapshots
raw messages
analytics
```

O histórico permanece disponível indefinidamente.

---

## 26. Multi-source discovery

Cada fonte pode ter mecanismo diferente.

Interface conceitual:

```text
discoverContests()
getCategories(contest)
getScores(contest)
```

Adapters:

```text
ContestRunAdapter
CosbAdapter
HamScoreAdapter
```

Se COSB ou HAMSCORE não oferecerem API estruturada, o adapter poderá inicialmente usar parsing de página pública.

O restante do sistema não muda.

---

## 27. Identificação do mesmo contest entre fontes

Problema:

```text
contest.run:
testid = 40

COSB:
identificador diferente

HAMSCORE:
outro identificador
```

Precisamos mapear todos para um único `contest_id` interno.

Tabela:

```text
contest_external_ids
```

Campos:

```text
contest_id
source_id
external_id
```

O matching poderá usar:

```text
nome normalizado
data inicial
data final
modo
```

Casos ambíguos devem permitir revisão manual.

---

## 28. Observabilidade do collector

Manter estado operacional por source/contest:

```text
source
contest
last_discovery
last_poll
last_success
last_error
http_status
stations_received
snapshots_created
duplicates_discarded
next_poll
failure_count
```

Isso poderá alimentar uma futura página:

```text
Tools → Collector Status
```

---

## 29. Health check

O backend deve oferecer um health endpoint interno.

Exemplo conceitual:

```text
GET /api/health/collectors
```

Resposta:

```json
{
  "contest_run": {
    "status": "ok",
    "last_success": "2026-09-10T22:31:00Z",
    "active_contests": 5
  },
  "cosb": {
    "status": "degraded"
  }
}
```

---

## 30. Métricas importantes

Monitorar:

```text
poll duration
poll success rate
API latency
stations per poll
snapshots per poll
duplicates per poll
parsing errors
HTTP 429 count
HTTP 5xx count
active contest count
```

---

## 31. Exemplo completo com múltiplos contests

```text
19:00 discovery

contest.run retorna:
41 CQ WPX
52 ARI DX
67 Helvetia
88 Florida QP

todos estão ACTIVE
```

Scheduler:

```text
19:00:00 → GET /displayscore/41
19:00:15 → GET /displayscore/52
19:00:30 → GET /displayscore/67
19:00:45 → GET /displayscore/88

19:01:00 → GET /displayscore/41
19:01:15 → GET /displayscore/52
...
```

Cada resposta:

```text
raw_messages
     │
     ▼
normalizer
     │
     ▼
score_snapshots
band_snapshots
current_scores
```

---

## 32. Uso pelo frontend

O frontend pode mostrar:

```text
LIVE NOW

● CQ WPX CW
● ARI DX Contest
● Helvetia Contest
● Florida QSO Party
```

Todos já estarão sendo coletados.

Quando o usuário escolhe um:

```text
GET /api/contests/{id}/scoreboard
```

O frontend consulta nosso backend, nunca o servidor externo.

---

## 33. Pseudocódigo conceitual

```text
while service_running:

    if discovery_due:
        contests = discover_from_all_sources()
        registry.merge(contests)
        update_active_jobs()

    for job in jobs_due:
        if concurrency_available(job.source):
            enqueue_poll(job)

    sleep(short_interval)
```

Worker:

```text
poll(job):
    response = adapter.getScores(job.contest)

    saveRaw(response)

    normalized = adapter.normalize(response)

    for station in normalized:
        if not duplicate(station):
            persistSnapshot(station)

    markSuccess(job)
```

---

## 34. Configuração sugerida

```text
DISCOVERY_INTERVAL=600
DEFAULT_POLL_INTERVAL=60
PRE_START_WINDOW=1800
POST_END_WINDOW=3600
HTTP_TIMEOUT=20
MAX_CONCURRENT_PER_SOURCE=3
MAX_BACKOFF=900
```

Valores em segundos.

Esses valores são iniciais e deverão ser validados em produção.

---

## 35. MVP

Implementar primeiro:

```text
ContestRunAdapter
Contest Registry
Discovery Scheduler
Active Contest Manager
Polling Scheduler
Normalizer
MySQL persistence
basic retry
collector logs
```

Depois:

```text
COSB adapter
HAMSCORE adapter
advanced backoff
circuit breaker
admin monitoring
Redis
```

---

## 36. Critérios de sucesso

O collector estará validado quando conseguir:

1. descobrir automaticamente os contests;
2. identificar todos os contests ativos;
3. coletá-los simultaneamente;
4. manter polling contínuo por várias horas;
5. detectar novos contests sem restart;
6. parar contests encerrados automaticamente;
7. salvar snapshots sem duplicação indevida;
8. continuar funcionando se uma fonte falhar;
9. alimentar o scoreboard sem depender do frontend;
10. fornecer histórico suficiente para Rival Monitor e analytics.

---

## 37. Decisão oficial

A arquitetura oficial do collector será:

```text
DISCOVERY
   │
   ▼
CONTEST REGISTRY
   │
   ▼
ACTIVE CONTEST MANAGER
   │
   ▼
STAGGERED POLLING
   │
   ▼
SOURCE ADAPTER
   │
   ▼
NORMALIZER
   │
   ▼
DEDUPLICATOR
   │
   ▼
MYSQL
```

O collector deverá acompanhar **todos os contests ativos simultaneamente**, com requisições escalonadas e sem qualquer dependência da seleção feita pelo usuário no frontend.
