# Araucaria LiveScore — contest.run API Reference

> Documento de referência da integração com `contest.run`.
>
> Objetivo: registrar apenas o que já foi observado em clientes públicos e investigações do projeto, separando claramente fatos confirmados, comportamento observado e pontos ainda pendentes de teste.

---

## 1. Status da documentação

Legenda usada neste documento:

```text
CONFIRMADO  comportamento reproduzido pelo POC read-only do Araucaria
OBSERVADO   dado presente em uma resposta do POC, sem semântica completa confirmada
INFERIDO    conclusão técnica plausível; não usar como contrato sem teste
NÃO RESOLVIDO  questão aberta que bloqueia uma decisão de produção
```

Regra do projeto:

> Não transformar uma inferência em contrato de API sem teste real.

---

## 2. Base do serviço

Site público:

```text
https://contest.run/
```

O frontend é uma aplicação cliente com rotas do tipo:

```text
#/score/{testid}
#/help/...
```

O Araucaria não deve depender do HTML da aplicação quando houver endpoint JSON disponível.

### 2.1. Evidência do POC baseline

Em 2026-09-11, o POC read-only do Araucaria executou seis `GET` requests
limitados aos endpoints documentados: `nearest`, `month/9`, categorias e
`displayscore` de dois `testid` retornados pelo discovery. Todos responderam
`200 application/json`, sem redirect, `ETag`, `Last-Modified`,
`Cache-Control`, `Retry-After` ou headers de rate limit observados.

Essa evidência confirma a disponibilidade daqueles paths naquele instante; não
congela o schema nem a política operacional futura do serviço. O resumo seguro
para revisão fica em `docs/observations/contest-run/2026-09-11-baseline.md`.

### 2.2. Evidência do POC Phase 0.7

Em 2026-09-11, um segundo POC read-only executou nove `GET` requests: discovery
em `nearest` e nos meses 8, 9 e 10, `displayscore` dos `testid` 108 e 91
selecionados deterministicamente, e uma segunda leitura dos mesmos paths após
15 minutos. Todos responderam `200 application/json`, sem redirect, retry,
cache ou headers de rate limit observados. O resumo sanitizado fica em
`docs/observations/contest-run/2026-09-11-phase-0-7.md`.

**OBSERVADO:** nos endpoints mensais, `dat` apareceu nas faixas:

```text
agosto     801..805
setembro   901..904
outubro   1001..1004
```

Isto suporta uma estrutura de mês mais slot, mas **não** estabelece a semântica
exata de `MMWW`, o ano de referência, nem a interpretação de calendário do
slot. `startday` e `finishday` continuaram compatíveis tanto com números de dia
da semana quanto com dias iniciais do mês.

**OBSERVADO:** `/nearest` permaneceu idêntico na janela de 15 minutos. Sua
semântica precisa - próximos, ativos ou janela deslizante mais ampla - continua
**NÃO RESOLVIDA**.

**OBSERVADO:** uma linha de `displayscore` pode avançar seu timestamp sem mudar
score, QSO, multiplicadores ou breakdown por banda. Reciprocamente, score, QSO,
multiplicadores e valores por banda podem diminuir ou sofrer reset. Logo,
presença de linha não implica atividade e métricas competitivas não devem ser
tratadas como monotônicas.

---

## 3. Endpoints de leitura identificados

### 3.1. Contests próximos

**CONFIRMADO:** o POC recebeu `200 application/json` deste path.

```http
GET https://contest.run/api/contest/nearest
```

Uso limitado confirmado:

- descobrir candidatos a contest;
- obter `testid`;
- alimentar o Contest Registry.

**OBSERVADO no POC:** a resposta foi um array de objetos com campos como:

```text
testid
contest
dat
startday
starttime
finishday
finishtime
name
scores
catcount
annlink
```

**NÃO RESOLVIDO:** não foram observados os campos `startdate` ou `enddate`.
O significado exato de `dat`, o ano representado e o timezone dos campos de
dia/hora permanecem desconhecidos. Logo, discovery não pode derivar uma janela
absoluta de atividade deste endpoint.

Exemplo observado, reduzido:

```json
[
  {
    "testid": 108,
    "contest": "DARC-WAEDC-SSB",
    "dat": 902,
    "startday": 6,
    "starttime": "00:00:00",
    "finishday": 7,
    "finishtime": "23:59:59",
    "name": "WAE DX SSB"
  }
]
```

---

### 3.2. Contests por mês

**CONFIRMADO:** o POC recebeu `200 application/json` de `/month/9`.

```http
GET https://contest.run/api/contest/month/{month}
```

Exemplo:

```http
GET https://contest.run/api/contest/month/10
```

Uso recomendado no Araucaria:

- complemento ao `nearest`;
- descoberta de múltiplos contests no mesmo período;
- redução do risco de perder um evento por depender de uma única lista.

**NÃO RESOLVIDO:**

- confirmar semântica exata do parâmetro `month`;
- confirmar se o endpoint depende do ano atual;
- verificar paginação ou limite.

---

### 3.3. Categorias de um contest

**CONFIRMADO:** o POC recebeu `200 application/json` para os `testid` 108 e 91.

```http
GET https://contest.run/api/category/contest/{testid}
```

Exemplo:

```http
GET https://contest.run/api/category/contest/40
```

Campos observados:

```text
catid
testid
ctdom
ct-dom
ctoper
ctwac
cttrans
ctband
ctpwr
ctmode
ctassis
ctstatn
cttime
ctoverl
categoryname
wherescores
ct-oper
ct-band
ct-mode
ct-assis
ct-trans
ct-power
ct-statn
ct-overl
ct-time
```

**OBSERVADO:** cada linha combina códigos numéricos (`ctoper`, `ctband` etc.)
com labels (`ct-oper`, `ct-band` etc.). Foram observados `-1`, strings vazias e
`null`; `ctdom`/`ct-dom` foram `null` em todas as três linhas de 108 e
misturaram `null` e string nas quinze linhas de 91. Esses valores não têm
semântica canônica confirmada.

Uso no Araucaria:

- mapear categorias do contest;
- permitir filtros no scoreboard;
- auxiliar no matching entre categorias externas e o modelo canônico.

As categorias não precisam ser consultadas a cada poll de score.

---

### 3.4. Scoreboard / displayscore

**CONFIRMADO:** o POC recebeu `200 application/json` para os `testid` 108 e 91.

```http
GET https://contest.run/api/displayscore/{testid}
```

Exemplo:

```http
GET https://contest.run/api/displayscore/40
```

Este é o endpoint principal para o External Collector.

Um cliente público já usa esse endpoint em polling periódico e processa a resposta como JSON.

**OBSERVADO:** a resposta foi um array com 93 linhas para 108 e 2 para 91. Uma
linha pode conter timestamp histórico; em 91 foram observadas datas de
2026-07-19 e 2026-09-09. A presença de uma estação em `displayscore` não prova
que ela esteja ativa no momento da leitura. Freshness deve ser calculada pelo
timestamp da própria linha.

---

## 4. Schema observado de `displayscore`

Campos observados no cliente público e confirmados pelo POC:

```text
auth
ctassis
ctband
ctmode
ctoper
ctoverl
ctpwr
ctstatn
cttime
cttrans

date
dxcc
elap
hrs
itu
lat
lon

m10
m15
m160
m20
m40
m80
mctotal
mptotal
mstotal
mtotal
mztotal

p10
p15
p160
p20
p40
p80
ptotal

q10
q15
q160
q20
q40
q80
qtotal
qtotalc
qtotalp
qtotalr

rownum
score
sign
soft
wac
waz
```

`auth` deve ser tratado como potencialmente sensível e nunca sair da fronteira
do adapter. `soft` foi observado como string e número. Tipos externos precisam
ser validados antes da normalização.

---

## 5. Mapeamento principal para o modelo canônico

```text
contest.run        Araucaria
-----------        ---------
sign            → callsign
date            → candidato a source_timestamp, com timezone não confirmado
score           → score

qtotal          → qso_total
ptotal          → points_total
mtotal          → mult_total

q160            → 160m qso
q80             → 80m qso
q40             → 40m qso
q20             → 20m qso
q15             → 15m qso
q10             → 10m qso

p160...         → points por banda
m160...         → mult por banda

dxcc            → dxcc
waz             → cq_zone
itu             → iaru_zone
lat             → latitude
lon             → longitude
soft            → metadado raw de software, após normalização de tipo
```

`qtotal`, `ptotal` e `mtotal` são os totais autoritativos retornados pela
fonte. O POC observou linhas em que não coincidem com a soma do breakdown por
banda; nunca recomputá-los localmente a partir dessas bandas.

A normalização oficial é definida em:

```text
data-normalization.md
```

---

## 6. Campos de QSO por banda

```text
q160
q80
q40
q20
q15
q10
qtotal
```

Isso permite calcular localmente:

```text
ΔQSO por banda
QSO rate
atividade dominante observada na janela
```

Importante:

> Breakdown por banda permite identificar em qual banda houve crescimento no intervalo, mas não prova com precisão a banda instantânea atual da estação.

---

## 7. Pontos por banda

Campos:

```text
p160
p80
p40
p20
p15
p10
ptotal
```

Esses campos devem ser preservados mesmo quando o frontend inicialmente não os exibir.

---

## 8. Multiplicadores

Campos por banda:

```text
m160
m80
m40
m20
m15
m10
mtotal
```

Agregados adicionais observados:

```text
mctotal
mptotal
mstotal
mztotal
```

A semântica exata desses agregados pode depender do contest.

Regra:

```text
preservar raw
normalizar apenas significado conhecido
```

---

## 9. Timestamp

**OBSERVADO no POC:** `date` usa o formato:

```text
YYYY-MM-DD HH:MM:SS
```

sem offset ou identificador de timezone. O cliente público aparenta tratá-lo
como UTC, mas isso é apenas uma inferência de cliente, não um contrato da fonte.

**NÃO RESOLVIDO:** o timezone oficial de `date` precisa de validação antes de
o adapter criar um `source_timestamp` UTC definitivo.

No Araucaria devem existir dois horários:

```text
source_timestamp
received_at
```

Nunca substituir um pelo outro.

---

## 10. Polling observado

O monitor público analisado usa:

```text
60 segundos
```

como intervalo de atualização.

Isso é evidência de uso prático, **não uma garantia oficial de rate limit**.

Configuração inicial sugerida no Araucaria:

```text
DEFAULT_POLL_INTERVAL = 60s
```

com:

- staggering;
- timeout;
- retry;
- backoff;
- tratamento de HTTP 429.

Detalhes em:

```text
collector-architecture.md
```

---

## 11. Coleta de todos os contests ativos

O Araucaria não deve selecionar apenas um `testid`, mas discovery do
`contest.run` hoje fornece candidatos, não uma prova de atividade absoluta.

Fluxo:

```text
GET /api/contest/nearest
GET /api/contest/month/{month}
        │
        ▼
registrar candidatos descobertos
        │
        ├── testid 41
        ├── testid 52
        ├── testid 67
        └── testid 88
        │
        ▼
GET /api/displayscore/41
GET /api/displayscore/52
GET /api/displayscore/67
GET /api/displayscore/88
```

A coleta deve continuar independentemente do contest selecionado no frontend.
**NÃO RESOLVIDO:** até confirmar a semântica de calendário, a produção não deve
agendar polling de "contests ativos" usando uma interpretação adivinhada de
`dat`, `startday` ou `finishday`.

---

## 12. Staggering

Exemplo com quatro contests:

```text
00s  testid 41
15s  testid 52
30s  testid 67
45s  testid 88
60s  testid 41
```

Objetivo:

- evitar bursts;
- reduzir carga no serviço;
- facilitar retries;
- diminuir risco de rate limiting.

---

## 13. Resposta vazia

Casos possíveis:

```text
[]
null
HTTP 200 sem stations
```

Tratamento:

```text
não apagar current_scores imediatamente
registrar poll vazio
avaliar stale timeout
```

Um poll vazio não significa necessariamente que o contest deixou de existir.

---

## 14. Falhas HTTP

Política do adapter:

```text
2xx   → processar
429   → respeitar Retry-After e aplicar backoff
5xx   → retry/backoff
4xx   → registrar; revisar se erro persistente
timeout → registrar e reagendar
JSON inválido → preservar raw e marcar parsing_error
```

---

## 15. Headers de leitura

O cliente público analisado usa headers semelhantes a um browser.

Para o Araucaria:

```text
User-Agent identificável
Accept: application/json
```

Evitar impersonação desnecessária se a API aceitar um cliente HTTP normal.

**CONFIRMADO:** o POC usou `Accept: application/json` e um `User-Agent`
identificável do Araucaria e recebeu respostas JSON bem-sucedidas.

---

## 16. Autenticação da API de leitura

**CONFIRMADO no POC:** os seis `GET` requests foram concluídos sem credenciais
explícitas.

Portanto, a hipótese atual é:

```text
read API pública
```

**NÃO RESOLVIDO:** não há confirmação de política de acesso, restrições por IP,
sessão ou headers além da amostra limitada do POC.

---

## 17. Write side / envio de score

Há evidência atual de logger público configurando:

```text
http://contest.run
```

como destino de Real-Time Score.

O comportamento observado do logger é:

```http
POST <rtc_url>
Content-Type: text/xml
Authorization: Basic ...
```

com corpo `dynamicresults` XML.

Exemplo conceitual:

```xml
<dynamicresults>
  <contest>...</contest>
  <call>...</call>
  <class ...></class>
  <breakdown>...</breakdown>
  <score>...</score>
  <timestamp>...</timestamp>
</dynamicresults>
```

Status:

```text
OBSERVADO EM CLIENTE PÚBLICO
```

Ainda não tratar como endpoint de produção do Araucaria sem teste controlado.

---

## 18. Autenticação de escrita

O logger analisado usa HTTP Basic Auth:

```text
username
password
```

A existência e política de criação dessas credenciais pertence ao `contest.run` e precisa ser validada antes de qualquer implementação outbound.

---

## 19. Respostas de escrita

Clientes do ecossistema mostram respostas HTTP tradicionais e há referência prática a sucesso semelhante a:

```text
200 / OK-Full
```

Isso não deve ainda ser usado como contrato rígido.

TODO:

- teste com credenciais autorizadas;
- registrar body e status reais;
- documentar erros.

---

## 20. Ambiente seguro de teste

Existe referência pública ao:

```text
General QSO Test
```

associado ao score route:

```text
#/score/40
```

Pode ser candidato a testes controlados.

Mesmo assim:

> Não enviar payloads sem credenciais válidas e autorização explícita.

---

## 21. Adapter proposto

Interface conceitual:

```ts
interface ContestRunAdapter {
  discoverNearest(): Promise<ExternalContest[]>;
  discoverMonth(month: number): Promise<ExternalContest[]>;
  getCategories(testId: number): Promise<ExternalCategory[]>;
  getScores(testId: number): Promise<ContestRunStation[]>;
  normalizeScores(...): CanonicalScoreSnapshot[];
}
```

### 21.1 Phase 2E.1 source-adapter contract

The implemented source adapter is a pure HTTP-response-to-DTO boundary: it
does not perform HTTP, scheduling, or database I/O. It recursively removes any
case-insensitive `auth` key before a `displayscore` DTO leaves
`@araucaria/source-adapters`; collector normalization repeats that protection
before retaining raw metrics, and row-rejection diagnostics contain only the
row index and error.

`date` is preserved as raw source evidence. It is not a proven UTC instant, so
normalization produces `sourceTimestamp: null` and
`sourceTimestampQuality: UNZONED_SOURCE_TEXT` when it is present. Aggregate
score/QSO/points/mult values remain source-authoritative and are never
recomputed from bands; band disagreement is valid source evidence. `soft` may
be a string or number, while `qtotalc`, `qtotalp`, and `qtotalr` remain raw
unresolved metrics without invented semantics. Discovery/category DTOs retain
observed IDs, codes, labels, and unknown fields; no contest year, timezone, or
activity state is inferred. A `displayscore` row means only source presence,
not PRESENT, FRESH, REPORTING, SCORING, or currently active.

### 21.2 Phase 2E.2 discovery contract

`ContestRunHttpClient` performs bounded `GET` requests with
`Accept: application/json`, a timeout, and no authentication or retry policy.
It sends raw response bytes only to the existing source-adapter parsers and
returns parsed DTOs with endpoint name, HTTP status, duration, and byte-count
metadata. It does not retain or log response bodies. Timeout, network,
non-2xx, invalid-content/body, oversized-body, and adapter-parse conditions
are explicit typed errors.

`ContestRunDiscoveryService` fetches `/contest/nearest`, optionally one
`/contest/month/{month}`, then categories for the discovered IDs. It deduplicates
only by `testid`; each nearest/month record remains in `discoveryEvidence`, so
conflicting raw fields have no invented winner. Category IDs, codes, labels,
sentinels, and unknown fields remain source evidence; no database persistence,
canonical category mapping, year, timezone, UTC timestamp, or activity meaning
is assigned. The optional `poc:contest-run:discovery` command is a separate,
read-only probe: current UTC month, at most two category requests, at most four
requests total, no `displayscore` requests, and sanitized JSON summary only.

### 21.3 Phase 2E.2 real read-only validation

The explicit real discovery probe completed with `PASS`. It made four bounded
read-only requests: `nearest`, the current-month discovery endpoint, and two
category endpoints. It made no `displayscore` requests and performed no
database writes. The real result confirmed testid-only deduplication across
nearest/month evidence, preservation of source-specific/conflicting discovery
evidence, and enforcement of the two-contest category-fetch bound. It did not
infer contest year, timezone, UTC timestamps, activity, or current-active
state.

### 21.4 Phase 2E.3 displayscore HTTP-to-normalization contract

`ContestRunHttpClient.displayScore(testid)` uses the same bounded read-only GET
policy and typed error model as discovery, and routes response bytes through
`parseContestRunDisplayScoreResponse`. The read-only validation helper then
uses the existing collector normalizer without any persistence operation. Its
sanitized per-contest summary includes HTTP metadata, source/normalized/rejected
row counts, date and unzoned-source-text counts, aggregate-to-band disagreement
counts, observed `soft` types, unresolved `qtotalc`/`qtotalp`/`qtotalr` field
presence, auth-redaction verification, and a small totals-only callsign sample.

The helper makes no temporal claim from a single response: reset-like evidence
is explicitly unassessed unless a separate bounded multi-snapshot validation is
introduced. It retains the Phase 2E.1 normalization contract: offset-free
`date` remains raw text with a null normalized timestamp and
`UNZONED_SOURCE_TEXT` quality; source aggregate totals are never recomputed;
row presence does not imply activity, freshness, reporting, or scoring. The
guarded `poc:contest-run:displayscore` command is limited to testids `108` and
`91`, makes at most two score requests, performs no database writes, and emits
sanitized JSON only.

### 21.5 Phase 2E.3 real read-only validation

The real displayscore probe completed with `PASS`: exactly two bounded score
requests, no database writes, and 244 of 244 source rows normalized successfully
with zero rejected rows. Auth redaction was verified. All observed dates remained
raw `UNZONED_SOURCE_TEXT`; no UTC or timezone inference was made. Real source
heterogeneity was confirmed (`soft` appeared as string and number), while
`qtotalc`, `qtotalp`, and `qtotalr` remained preserved unresolved evidence.

Aggregate-to-band disagreement was observed for 169 of 240 rows in testid
`108`; this does not alter the source-authoritative aggregate totals. No reset
claim was made because the validation used one temporal sample per contest.

### 21.6 Phase 2E.4 real controlled persistence validation

The guarded real integration harness completed with `PASS` against Percona
Server 5.7.44-48 using only `dxarauca_livescore_test` and contest.run testid
`91`. It persisted the real displayscore response through the established
source-neutral path: original response hash and redacted raw receipt,
source-adapter normalization, immutable score snapshots, and supplemental band
snapshots. No contest.run-specific persistence path was introduced.

The first fetch produced five accepted observations and five snapshots (with
30 persisted band rows). An immediate second fetch produced five observation-
level duplicates, no accepted snapshots, and no false new history rows. Auth
redaction was verified for the persisted receipt and normalized source evidence.
Fixture cleanup returned the isolated `PHASE2E4_TEST_*` namespace to zero rows.

All five source dates remained `UNZONED_SOURCE_TEXT`. Under the current Phase
2D canonical policy, contest.run observations with this unresolved timestamp
quality may be persisted as historical evidence but are not eligible for
canonical selection: this validation created zero `canonical_score_events` and
zero `current_scores` rows. This is not evidence that contest.run timestamps
are UTC and does not add source precedence or timezone semantics.

---

## 22. Contest discovery flow

```text
discovery scheduler
      │
      ├── /contest/nearest
      └── /contest/month/{month}
              │
              ▼
        normalize contests
              │
              ▼
        resolve internal IDs
              │
              ▼
        Contest Registry
```

---

## 23. Score collection flow

```text
poll scheduler
      │
      ▼
/api/displayscore/{testid}
      │
      ▼
raw_messages
      │
      ▼
ContestRunAdapter
      │
      ▼
CanonicalScoreSnapshot[]
      │
      ▼
dedup/reconciliation
      │
      ▼
MySQL
```

---

## 24. Persistência mínima por poll

Guardar metadados operacionais:

```text
source = CONTEST_RUN
external_contest_id
testid
requested_at
response_at
http_status
payload_hash
station_count
processing_status
```

---

## 25. Dados que não devemos inferir

Não inferir automaticamente:

```text
banda instantânea atual
frequência atual
QSO individual
worked calls
exchange
run/S&P
```

O `displayscore` observado é um snapshot agregado.

---

## 26. Histórico

Não há dependência de um endpoint histórico remoto.

O Araucaria constrói seu próprio histórico:

```text
poll 20:00
poll 20:01
poll 20:02
...
```

Com isso derivamos:

```text
ΔScore
ΔQSO
ΔMult
band deltas
rates
trends
```

---

## 27. Classificação após o POC baseline

### CONFIRMADO

- os quatro endpoints de leitura documentados responderam `200 application/json`
  na amostra do POC;
- discovery retornou `testid` utilizável para solicitar categorias e scores;
- as leituras funcionaram com `Accept: application/json`, User-Agent
  identificável e sem credenciais explícitas nesta amostra.

### OBSERVADO

- discovery retornou `dat`, dias e horários, sem `startdate`/`enddate`;
- categorias incluem códigos, labels e sentinelas;
- `displayscore` é um array de snapshots agregados, com linhas históricas;
- `soft` variou entre string e número e `auth` estava presente como campo;
- os totais e os breakdowns por banda nem sempre reconciliaram.

### INFERIDO

- `qtotal`, `ptotal` e `mtotal` devem permanecer autoritativos em vez de serem
  recalculados a partir das bandas;
- presença de uma linha deve ser separada da classificação de freshness/live.

### NÃO RESOLVIDO

- semântica de `dat`, ano, timezone e janelas absolutas de contest;
- timezone oficial de `date`;
- semântica de `qtotalc`, `qtotalp`, `qtotalr`, campos `m*total` e campos `ct*`;
- comportamento no término do contest e ciclo de vida de linhas stale;
- rate limits, headers mínimos, ETag/cache e paginação;
- endpoint atual de POST, HTTPS versus HTTP de escrita, credenciais e respostas
  de escrita.

---

## 28. Critérios para considerar a API validada

A integração read-side estará validada quando nossa POC conseguir:

1. listar contests;
2. obter `testid` automaticamente;
3. carregar categorias;
4. coletar `displayscore` real;
5. repetir polling por algumas horas;
6. observar múltiplos contests simultâneos;
7. registrar mudanças de score e breakdown;
8. tratar contest sem stations;
9. sobreviver a timeout/erro temporário;
10. confirmar formatos e timezone.

---

## 29. Decisão oficial para o MVP

O `contest.run` será a primeira fonte externa estruturada do Araucaria LiveScore.

Endpoints de leitura usados pelo MVP:

```text
/api/contest/nearest
/api/contest/month/{month}
/api/category/contest/{testid}
/api/displayscore/{testid}
```

A integração de escrita será implementada somente após teste controlado e documentação do comportamento real.

---

## 30. Documentos relacionados

```text
system-architecture.md
collector-architecture.md
data-normalization.md
source-priority-dedup.md
internal-api.md
contest-run-collection-simulation.md
```
