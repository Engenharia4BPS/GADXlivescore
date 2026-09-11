# Araucaria LiveScore — Internal API

> Documento de referência da API interna consumida pelo frontend do **Araucaria LiveScore**.
>
> Objetivo: definir um contrato estável entre frontend e backend, independentemente das fontes externas (`contest.run`, COSB, HAMSCORE, N1MM, DXLog etc.).

---

## 1. Princípio central

O frontend **nunca deve consultar diretamente** serviços externos.

Fluxo oficial:

```text
Browser
   │
   ▼
Araucaria Internal API
   │
   ▼
MySQL / Analytics Engine
   │
   ├── contest.run
   ├── COSB
   ├── HAMSCORE
   └── direct logger ingest
```

Benefícios:

- contrato único;
- deduplicação;
- histórico próprio;
- segurança;
- cache;
- independência das fontes;
- possibilidade de trocar adapters sem alterar o frontend.

---

## 2. Base path

Proposta para o MVP:

```text
/api/v1
```

Exemplo:

```text
https://araucariadx.com/livescore/api/v1/contests/live
```

O prefixo exato de deploy pode mudar, mas a API deve ser versionada desde o início.

---

## 3. Formato

```text
HTTPS
JSON
UTF-8
```

Header recomendado:

```http
Accept: application/json
```

Datas:

```text
ISO 8601 UTC
```

Exemplo:

```text
2026-09-11T17:30:00Z
```

---

## 4. Envelope padrão

Resposta simples:

```json
{
  "data": {},
  "meta": {
    "generated_at": "2026-09-11T17:30:00Z"
  }
}
```

Resposta de coleção:

```json
{
  "data": [],
  "meta": {
    "generated_at": "2026-09-11T17:30:00Z",
    "count": 42
  }
}
```

---

## 5. Regras de representação

### Inteiros

```text
score
qso
points
mult
```

sempre como inteiros JSON.

### Ausência de dado

```text
null
```

não converter ausência para `0`.

### Callsigns

Retornar normalizados em uppercase.

### Banda

Formato canônico:

```text
160m
80m
40m
20m
15m
10m
...
```

---

# CONTESTS

## 6. Listar contests

```http
GET /api/v1/contests
```

Filtros opcionais:

```text
status
from
to
source
q
```

Exemplo:

```http
GET /api/v1/contests?status=ACTIVE
```

Resposta:

```json
{
  "data": [
    {
      "id": 1001,
      "slug": "cq-ww-cw-2026",
      "name": "CQ WW DX CW",
      "start_at": "2026-11-28T00:00:00Z",
      "end_at": "2026-11-29T23:59:59Z",
      "status": "ACTIVE",
      "station_count": 142,
      "last_update": "2026-11-28T14:32:18Z"
    }
  ],
  "meta": {
    "count": 1,
    "generated_at": "2026-11-28T14:32:20Z"
  }
}
```

---

## 7. Contests live

Atalho para contests ativos:

```http
GET /api/v1/contests/live
```

Equivalente conceitual a:

```text
status in WARMUP, ACTIVE, FINISHING
```

Uso principal:

- seletor de contest;
- página inicial;
- indicador `LIVE NOW`.

---

## 8. Detalhes de um contest

```http
GET /api/v1/contests/{contestId}
```

Exemplo de resposta:

```json
{
  "data": {
    "id": 1001,
    "slug": "cq-ww-cw-2026",
    "name": "CQ WW DX CW",
    "start_at": "2026-11-28T00:00:00Z",
    "end_at": "2026-11-29T23:59:59Z",
    "status": "ACTIVE",
    "sources": [
      {
        "code": "CONTEST_RUN",
        "external_id": "52",
        "last_success": "2026-11-28T14:32:18Z"
      }
    ]
  },
  "meta": {
    "generated_at": "2026-11-28T14:32:20Z"
  }
}
```

---

## 9. Categorias do contest

```http
GET /api/v1/contests/{contestId}/categories
```

Resposta conceitual:

```json
{
  "data": [
    {
      "id": 81,
      "name": "MULTI-OP HIGH ALL BAND",
      "operator_class": "MULTI-OP",
      "power": "HIGH",
      "assisted": "ASSISTED",
      "transmitter": "MULTI-TX",
      "band": "ALL",
      "mode": "CW"
    }
  ]
}
```

---

# SCOREBOARD

## 10. Scoreboard principal

```http
GET /api/v1/contests/{contestId}/scoreboard
```

Parâmetros opcionais:

```text
category_id
window
callsign
limit
cursor
sort
```

`window` aceita inicialmente:

```text
last
10m
30m
1h
2h
6h
contest
```

Exemplo:

```http
GET /api/v1/contests/1001/scoreboard?window=30m&limit=100
```

---

## 11. Linha do scoreboard

Formato proposto:

```json
{
  "rank": 1,
  "callsign": "CR3W",
  "category": {
    "id": 81,
    "name": "MULTI-OP HIGH ALL BAND"
  },
  "score": 1763136,
  "delta_score": 41280,
  "qso": 1647,
  "delta_qso": 37,
  "mult": 241,
  "delta_mult": 2,
  "qso_rate": 74.0,
  "score_rate": 82560.0,
  "bands": {
    "80m":  { "qso": 301, "delta_qso": 3 },
    "40m":  { "qso": 409, "delta_qso": 8 },
    "20m":  { "qso": 488, "delta_qso": 16 },
    "15m":  { "qso": 313, "delta_qso": 8 },
    "10m":  { "qso": 136, "delta_qso": 2 }
  },
  "source": {
    "code": "CONTEST_RUN",
    "source_at": "2026-09-10T22:31:00Z",
    "received_at": "2026-09-10T22:31:08Z"
  }
}
```

`delta_*` depende da janela selecionada.

---

## 12. Ordenação

Valores iniciais possíveis:

```text
score_desc
score_asc
qso_desc
delta_score_desc
delta_qso_desc
rate_desc
callsign_asc
```

Default:

```text
score_desc
```

---

## 13. Paginação

Preferir cursor pagination:

```text
limit=100
cursor=...
```

Resposta:

```json
{
  "meta": {
    "count": 100,
    "next_cursor": "opaque-token"
  }
}
```

Evitar paginação por offset em tabelas muito ativas.

---

# STATIONS

## 14. Detalhes de uma estação

```http
GET /api/v1/contests/{contestId}/stations/{callsign}
```

Exemplo:

```http
GET /api/v1/contests/1001/stations/CR3W
```

Resposta:

```json
{
  "data": {
    "callsign": "CR3W",
    "score": 1763136,
    "qso": 1647,
    "mult": 241,
    "category": {},
    "station_meta": {
      "club": null,
      "dxcc": "CT3",
      "cq_zone": 33,
      "grid": null,
      "logger": "DXLog"
    },
    "last_update": "2026-09-10T22:31:00Z"
  }
}
```

---

## 15. Histórico da estação

```http
GET /api/v1/contests/{contestId}/stations/{callsign}/history
```

Parâmetros:

```text
from
to
resolution
```

`resolution`:

```text
raw
1m
5m
15m
1h
```

Exemplo:

```http
GET /api/v1/contests/1001/stations/CR3W/history?resolution=5m
```

Resposta:

```json
{
  "data": [
    {
      "timestamp": "2026-09-10T22:30:00Z",
      "score": 1721856,
      "qso": 1610,
      "mult": 239
    },
    {
      "timestamp": "2026-09-10T22:35:00Z",
      "score": 1770000,
      "qso": 1655,
      "mult": 242
    }
  ]
}
```

---

## 16. Histórico por banda

```http
GET /api/v1/contests/{contestId}/stations/{callsign}/bands
```

Parâmetros:

```text
window
from
to
```

Resposta conceitual:

```json
{
  "data": {
    "callsign": "CR3W",
    "window": "30m",
    "bands": [
      {
        "band": "20m",
        "qso": 488,
        "delta_qso": 16,
        "mult": 67,
        "delta_mult": 1
      }
    ]
  }
}
```

---

# ANALYTICS

## 17. Summary de analytics

```http
GET /api/v1/contests/{contestId}/analytics/summary
```

Parâmetro obrigatório/recomendado:

```text
window
```

Exemplo:

```http
GET /api/v1/contests/1001/analytics/summary?window=1h
```

Pode retornar:

```text
leader
our_station
position
gap_to_leader
score_rate
qso_rate
fastest_gainer
most_active_band
```

---

## 18. Comparação de estações

```http
GET /api/v1/contests/{contestId}/compare
```

Parâmetros:

```text
callsigns
window
```

Exemplo:

```http
GET /api/v1/contests/1001/compare?callsigns=ZW5B,CR3W,D4C&window=1h
```

Resposta conceitual:

```json
{
  "data": {
    "window": "1h",
    "stations": [
      {
        "callsign": "ZW5B",
        "score": 1877568,
        "delta_score": 132480,
        "delta_qso": 118,
        "qso_rate": 118,
        "gap_to_leader": 0
      }
    ]
  }
}
```

---

# RIVAL MONITOR

## 19. Rival Monitor

```http
GET /api/v1/contests/{contestId}/rivals
```

Parâmetros:

```text
window
watchlist_id
callsigns
```

Exemplo:

```http
GET /api/v1/contests/1001/rivals?window=30m&callsigns=CR3W,D4C,K3LR
```

Campos úteis:

```text
callsign
rank
score
gap
delta_score
delta_qso
qso_rate
band deltas
dominant_band_observed
last_update
```

Importante:

> `dominant_band_observed` significa banda com maior crescimento dentro da janela analisada; não significa necessariamente banda instantânea atual.

---

# WATCHLISTS

## 20. Listar watchlists

Futuro, quando houver usuário autenticado:

```http
GET /api/v1/watchlists
```

---

## 21. Obter watchlist

```http
GET /api/v1/watchlists/{watchlistId}
```

Operações de criação/edição serão definidas quando a autenticação de usuários entrar no escopo.

---

# SOURCES / STATUS

## 22. Status público resumido das fontes

```http
GET /api/v1/sources/status
```

Resposta:

```json
{
  "data": [
    {
      "code": "CONTEST_RUN",
      "status": "OK",
      "last_success": "2026-09-11T17:30:00Z",
      "active_contests": 4
    },
    {
      "code": "COSB",
      "status": "DEGRADED",
      "last_success": "2026-09-11T17:27:00Z"
    }
  ]
}
```

Não retornar segredos, URLs privadas ou detalhes internos sensíveis.

---

## 23. Health administrativo

Health detalhado pode existir em rota separada/protegida:

```http
GET /api/v1/admin/health/collectors
```

Não faz parte da API pública do frontend comum.

---

# REALTIME

## 24. WebSocket

Endpoint conceitual:

```text
/livescore/ws
```

ou:

```text
/api/v1/ws
```

A decisão exata depende do framework de backend.

---

## 25. Eventos realtime

Eventos iniciais:

```text
score:update
contest:update
source:status
```

Opcionalmente:

```text
station:update
```

---

## 26. `score:update`

Exemplo:

```json
{
  "event": "score:update",
  "contest_id": 1001,
  "callsign": "CR3W",
  "timestamp": "2026-09-10T22:31:08Z",
  "data": {
    "score": 1763136,
    "qso": 1647,
    "mult": 241
  }
}
```

O evento deve ser publicado somente **depois do commit no MySQL**.

---

## 27. `contest:update`

Usado quando:

```text
contest entra em WARMUP
contest inicia
contest encerra
novo contest é descoberto
metadados mudam
```

---

## 28. Assinatura por contest

Para reduzir tráfego, o cliente poderá assinar somente o contest visível.

Conceito:

```json
{
  "action": "subscribe",
  "contest_id": 1001
}
```

Troca de tela:

```json
{
  "action": "unsubscribe",
  "contest_id": 1001
}
```

---

# ERROR MODEL

## 29. Erro padrão

```json
{
  "error": {
    "code": "CONTEST_NOT_FOUND",
    "message": "Contest not found",
    "details": null
  },
  "meta": {
    "generated_at": "2026-09-11T17:30:00Z"
  }
}
```

---

## 30. Códigos HTTP

```text
200 OK
400 invalid request
401 authentication required
403 forbidden
404 resource not found
409 conflict
422 semantic validation error
429 rate limit
500 internal error
503 service unavailable
```

---

## 31. Error codes internos

Exemplos:

```text
CONTEST_NOT_FOUND
STATION_NOT_FOUND
INVALID_WINDOW
INVALID_CALLSIGN
INVALID_CURSOR
SOURCE_UNAVAILABLE
ANALYTICS_NOT_READY
```

O frontend deve usar `error.code`, não interpretar texto da mensagem.

---

# CACHE

## 32. Cache HTTP

Rotas adequadas podem usar:

```text
ETag
Cache-Control
```

Exemplos:

```text
contests list       cache curto
categories          cache maior
scoreboard live     cache mínimo ou no-cache
history             cacheável após contest
```

---

## 33. Freshness

Toda resposta de live data deve informar:

```text
generated_at
last_update
```

para o frontend distinguir:

```text
dado atual
```

de:

```text
dado stale
```

---

# SECURITY

## 34. API pública versus administrativa

Separar:

```text
/api/v1/...         read API do frontend
/api/v1/admin/...   operações administrativas
```

O frontend público não deve receber:

```text
API keys
passwords
tokens externos
raw auth headers
stack traces
```

---

## 35. Ingestion API fora deste documento

O endpoint usado por N1MM/DXLog para enviar score ao Araucaria é uma API de ingestão, não a API de leitura do frontend.

Exemplo futuro:

```text
POST /api/score
```

ou:

```text
POST /api/v1/ingest/score
```

Seu contrato deverá ser documentado separadamente ou numa futura seção específica.

---

# PERFORMANCE

## 36. Objetivos iniciais

Para dados já no MySQL:

```text
contest list        < 300 ms típico
scoreboard          < 500 ms típico
station detail      < 500 ms típico
analytics simples   < 1 s típico
```

Valores são metas de engenharia, não SLA formal.

---

## 37. Evitar cálculo excessivo no frontend

O backend deve entregar calculado:

```text
rank
delta_score
delta_qso
delta_mult
qso_rate
score_rate
gap
band deltas
```

O browser não deve reconstruir analytics consultando snapshots crus.

---

# CONSISTÊNCIA

## 38. Snapshot canônico

Os endpoints de leaderboard e station detail devem usar o estado selecionado pelo mecanismo de reconciliação definido em:

```text
source-priority-dedup.md
```

A API pode expor a origem:

```json
{
  "source": {
    "code": "ARAUCARIA_DIRECT",
    "source_at": "..."
  }
}
```

---

## 39. Mudança de fonte

Se a estação mudar de fonte canônica:

```text
DIRECT → CONTEST_RUN
```

isso não deve alterar o contrato do endpoint.

O frontend continua recebendo o mesmo schema.

---

# VERSIONAMENTO

## 40. Compatibilidade

Dentro de `/api/v1`:

- novos campos podem ser adicionados;
- campos existentes não devem mudar de significado;
- campos não devem ser removidos sem nova versão;
- clientes devem tolerar campos adicionais.

Breaking changes:

```text
/api/v2
```

---

# ENDPOINTS DO MVP

## 41. Conjunto mínimo

Para a primeira interface funcional:

```text
GET /api/v1/contests/live
GET /api/v1/contests/{id}
GET /api/v1/contests/{id}/categories
GET /api/v1/contests/{id}/scoreboard
GET /api/v1/contests/{id}/stations/{callsign}
GET /api/v1/contests/{id}/stations/{callsign}/history
GET /api/v1/contests/{id}/compare
GET /api/v1/contests/{id}/rivals
GET /api/v1/sources/status
WebSocket score:update
```

---

## 42. Fase seguinte

Depois do MVP:

```text
watchlists
advanced analytics
category overview
map/geography endpoints
QSO stream quando houver QSO-level data
admin collector controls
historical contest search
export endpoints
```

---

## 43. Relação com o layout

### KPI cards

Consomem:

```text
scoreboard
analytics/summary
```

### Live ScoreBoard

```text
/scoreboard
```

### Rival Monitor

```text
/rivals
```

### Quick Comparison

```text
/compare
```

### Recent Snapshots / History

```text
/stations/{callsign}/history
```

### Performance by Band

```text
/stations/{callsign}/bands
```

---

## 44. Decisão oficial

A Internal API será a única interface de dados consumida pelo frontend.

O contrato será:

```text
source-independent
contest-centric
snapshot-backed
analytics-ready
realtime-capable
versioned
```

O frontend jamais deverá conhecer detalhes de endpoints de `contest.run`, COSB ou HAMSCORE.

---

## 45. Documentos relacionados

```text
system-architecture.md
collector-architecture.md
contest-run-api.md
data-normalization.md
source-priority-dedup.md
analytics-engine.md
security.md
```
