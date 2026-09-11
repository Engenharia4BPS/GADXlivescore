# Araucaria LiveScore — System Architecture

> Documento de referência da arquitetura geral do **Araucaria LiveScore**.
>
> Este documento define os principais componentes, responsabilidades, fluxos de dados e decisões estruturais da primeira versão do sistema.

---

## 1. Objetivo

O Araucaria LiveScore será uma plataforma de monitoramento em tempo real para contests de radioamadorismo, com foco em:

- receber scores diretamente de loggers como N1MM Logger+ e DXLog;
- coletar scores de fontes externas como `contest.run`, Contest Online ScoreBoard e HAMSCORE;
- manter histórico próprio de todos os updates;
- exibir leaderboard em tempo real;
- comparar estações rivais;
- calcular deltas, rates e atividade por banda;
- permitir análises durante e depois do contest;
- retransmitir scores para scoreboards externos quando apropriado.

O sistema deve funcionar como uma camada de **agregação, normalização, histórico e inteligência** sobre múltiplas fontes de live score.

---

## 2. Princípios de arquitetura

### 2.1. O backend coleta independentemente do frontend

A coleta de dados não depende do que o usuário está visualizando.

Exemplo:

```text
BACKEND
coleta todos os contests ativos

FRONTEND
usuário visualiza apenas um deles
```

Selecionar outro contest no site apenas altera a visualização.

Não inicia, interrompe ou modifica a coleta.

### 2.2. Histórico é imutável

Nunca sobrescrever o histórico.

Cada atualização recebida cria um novo snapshot.

```text
20:00 snapshot
20:01 snapshot
20:02 snapshot
20:03 snapshot
```

Isso permite reconstruir toda a evolução da competição.

### 2.3. Múltiplas fontes devem convergir para um modelo interno único

Independentemente da origem:

```text
N1MM
DXLog
contest.run
COSB
HAMSCORE
federation
manual
```

os dados devem ser normalizados antes de alimentar o banco e o frontend.

### 2.4. Fonte de verdade

O MySQL é a fonte de verdade do sistema.

Redis poderá ser adicionado posteriormente como cache e mecanismo de pub/sub, mas não será obrigatório no MVP.

---

## 3. Visão geral

```text
                       ARAUCARIA LIVESCORE

        ┌───────────────────────────────────────────┐
        │              FONTES DIRETAS               │
        │                                           │
        │        N1MM   DXLog   outros loggers      │
        └───────────────────┬───────────────────────┘
                            │
                            │ dynamicresults XML
                            ▼
                    ┌───────────────┐
                    │ Ingestion API │
                    └───────┬───────┘
                            │
                            ▼
                    ┌───────────────┐
                    │  Normalizer   │
                    └───────┬───────┘
                            │
                            ▼
                      ┌──────────┐
                      │  MySQL   │
                      └────┬─────┘
                           │
             ┌─────────────┼─────────────┐
             │             │             │
             ▼             ▼             ▼
       current state    histórico     raw messages
             │             │
             └──────┬──────┘
                    ▼
             ┌──────────────┐
             │   Analytics  │
             └──────┬───────┘
                    │
                    ▼
              REST / WebSocket
                    │
                    ▼
               Web Dashboard


        ┌───────────────────────────────────────────┐
        │             FONTES EXTERNAS               │
        │                                           │
        │ contest.run   COSB   HAMSCORE   outras    │
        └───────────────────┬───────────────────────┘
                            │
                            ▼
                  ┌────────────────────┐
                  │ External Collector │
                  └─────────┬──────────┘
                            │
                            ▼
                       Normalizer
                            │
                            ▼
                          MySQL
```

---

## 4. Componentes principais

### 4.1. Ingestion API

Responsável por receber scores enviados diretamente pelos loggers.

Entrada principal prevista:

```text
HTTP POST
dynamicresults XML
```

Responsabilidades:

- receber payload;
- validar tamanho e formato;
- identificar fonte;
- armazenar payload bruto;
- fazer parsing;
- normalizar;
- identificar contest;
- identificar estação;
- gerar snapshot;
- atualizar estado atual;
- publicar evento realtime após commit.

### 4.2. External Collector

Responsável por consultar periodicamente serviços externos.

Fontes previstas:

```text
contest.run
Contest Online ScoreBoard
HAMSCORE
outras futuras
```

Responsabilidades:

- descobrir contests;
- identificar contests ativos;
- coletar todos os contests ativos;
- escalonar requisições;
- lidar com falhas temporárias;
- salvar raw payload;
- normalizar dados;
- evitar duplicatas;
- gerar snapshots;
- manter o banco atualizado sem depender da interface.

A arquitetura específica está definida em:

```text
collector-architecture.md
```

---

## 5. Normalizer

O Normalizer é a fronteira entre protocolos externos e o modelo interno.

Exemplo de entrada:

```text
contest.run JSON
```

ou:

```text
dynamicresults XML
```

Saída conceitual:

```json
{
  "contest": {
    "internal_id": 1001,
    "source": "CONTEST_RUN",
    "external_id": "40"
  },
  "station": {
    "callsign": "CR3W"
  },
  "timestamp": "2026-09-10T22:31:00Z",
  "score": 1732224,
  "qso": 1619,
  "points": 4872,
  "mult": 240,
  "bands": {
    "80m":  { "qso": 298, "points": 0, "mult": 40 },
    "40m":  { "qso": 403, "points": 0, "mult": 59 },
    "20m":  { "qso": 477, "points": 0, "mult": 67 },
    "15m":  { "qso": 307, "points": 0, "mult": 47 },
    "10m":  { "qso": 134, "points": 0, "mult": 27 }
  }
}
```

O frontend não deve precisar conhecer a origem original do dado.

---

## 6. Banco de dados

Banco principal:

```text
MySQL
```

A infraestrutura já existente no `araucariadx.com` será aproveitada.

Tabelas principais:

```text
contests
contest_external_ids
entries
score_snapshots
band_snapshots
current_scores
sources
raw_messages
watchlists
```

### 6.1. `contests`

Representa uma edição interna de um contest.

```text
id
slug
name
start_at
end_at
status
```

### 6.2. `contest_external_ids`

Relaciona o mesmo contest aos IDs usados por fontes externas.

```text
id
contest_id
source_id
external_id
```

Exemplo:

```text
contest_id  source        external_id
1001        CONTEST_RUN   40
1001        COSB          cqww-cw-2026
1001        HAMSCORE      ...
```

### 6.3. `entries`

Representa a participação de uma estação em um contest.

```text
id
contest_id
callsign
category
club
dxcc
zone
grid
```

### 6.4. `score_snapshots`

Histórico append-only.

```text
id
entry_id
source_timestamp
received_at
score
qso_total
points_total
mult_total
source_id
raw_message_id
```

### 6.5. `band_snapshots`

Breakdown normalizado por banda.

```text
id
snapshot_id
band
mode
qso
points
mult1
mult2
```

### 6.6. `current_scores`

Estado atual para consultas rápidas do leaderboard.

```text
contest_id
entry_id
latest_snapshot_id
score
qso_total
mult_total
last_update
```

### 6.7. `raw_messages`

Payload original de cada mensagem ou coleta.

```text
id
received_at
source_id
content_type
payload
payload_hash
processing_status
error
```

---

## 7. Fontes e prioridade

Prioridade sugerida:

```text
1. DIRECT LOGGER
2. FEDERATION
3. EXTERNAL SERVER
4. MANUAL
```

Exemplo:

```text
ZW5B → ARAUCARIA_DIRECT
CR3W → CONTEST_RUN
D4C  → COSB
K3LR → HAMSCORE
```

Se a mesma estação chegar por múltiplas fontes, o sistema deve:

- detectar que representa a mesma entry;
- preservar a origem;
- evitar snapshots duplicados;
- selecionar a fonte preferencial para o estado atual;
- manter rastreabilidade.

---

## 8. Deduplicação

A deduplicação não deve usar apenas score.

Dois updates legítimos podem ter o mesmo score.

Fingerprint conceitual:

```text
contest
callsign
source_timestamp
score
qso_total
source
payload_hash
```

Quando houver um identificador de mensagem fornecido pela fonte, ele deve ser preferido.

---

## 9. Fluxo transacional de ingestão

Cada atualização deve ser processada em uma transação:

```text
1. salvar raw_message
2. resolver source
3. resolver contest
4. resolver entry
5. inserir score_snapshot
6. inserir band_snapshots
7. atualizar current_scores
8. commit
9. publicar evento realtime
```

O WebSocket só deve receber o evento depois do commit.

---

## 10. Realtime

MVP:

```text
MySQL
  │
Backend
  │
WebSocket
  │
Browser
```

Futuro:

```text
MySQL
  │
  ├── truth/history
  │
Redis
  │
  ├── cache
  ├── pub/sub
  ├── distributed WebSocket
  └── rate limiting
```

---

## 11. Analytics Engine

O motor analítico deverá calcular valores derivados dos snapshots.

Principais métricas:

```text
Δ Score
Δ QSO
Δ Mult
Δ por banda
QSO/h
Score/h
Gap para líder
Gain sobre rival
Dominant band
aceleração
desaceleração
```

Janelas previstas:

```text
último update
10 min
30 min
1h
2h
6h
contest total
```

Rates devem ser calculados usando o tempo real entre snapshots.

Não assumir intervalos fixos.

---

## 12. Seleção do snapshot histórico

Para uma janela como 1 hora:

```text
agora = 20:00
alvo  = 19:00
```

o sistema deve escolher o snapshot mais próximo de 19:00, preferencialmente em ou antes do alvo.

Depois:

```text
delta = snapshot_atual - snapshot_historico
```

Isso evita distorções quando diferentes estações atualizam em intervalos diferentes.

---

## 13. Rival Monitor

O Rival Monitor depende do histórico local.

Exemplo:

```text
CR3W

Score      1.763.136
Gap        -18.420
Gain 1h    +138.000
Δ QSO      +37

80m        +3
40m        +8
20m       +16
15m        +8
10m        +2
```

Mesmo que a fonte externa não ofereça histórico, o Araucaria constrói seu próprio histórico por polling.

---

## 14. Frontend

Tema claro oficial definido em:

```text
layout-claro.md
```

Estrutura principal:

```text
Header
Filters
KPI cards

┌────────────────────────┬──────────────────────┐
│ Live ScoreBoard        │ Rival Monitor        │
│                        │ Quick Compare        │
│                        │ Recent Snapshots     │
└────────────────────────┴──────────────────────┘

Score History
Performance by Band
Category Overview
Quick Insights
```

---

## 15. API interna

O frontend deverá consumir apenas a API do Araucaria.

Nunca acessar diretamente:

```text
contest.run
COSB
HAMSCORE
```

Fluxo correto:

```text
Browser
   │
   ▼
Araucaria API
   │
   ▼
MySQL
```

Isso garante:

- consistência;
- cache;
- deduplicação;
- segurança;
- independência das fontes;
- controle de performance.

---

## 16. Integração outbound

Quando permitido, o Araucaria poderá retransmitir scores recebidos diretamente.

Exemplo:

```text
N1MM / DXLog
      │
      ▼
Araucaria
      │
      ├── MySQL
      │
      ├── COSB
      ├── contest.run
      └── HAMSCORE
```

Deve haver proteção contra loops.

Um score recebido de um servidor externo não deve ser reenviado automaticamente para a mesma federação sem identificação apropriada.

---

## 17. Stack sugerida

```text
DATABASE
MySQL

BACKEND
Node.js + TypeScript

FRONTEND
React / Next.js

REALTIME
WebSocket

CACHE
nenhum no MVP
Redis futuramente

DEPLOY
Docker ou serviço Node no servidor
```

---

## 18. Observabilidade

O sistema deve registrar:

```text
collector status
último poll por source/contest
latência
HTTP status
quantidade de stations recebidas
quantidade de snapshots criados
duplicatas descartadas
erros de parsing
erros de banco
```

Deve ser possível responder rapidamente:

```text
"Estamos recebendo CR3W?"
"Quando foi o último update?"
"De qual servidor veio?"
"O collector está com erro?"
```

---

## 19. Segurança

Princípios:

- segredos nunca no frontend;
- credenciais externas apenas no backend;
- tokens e senhas em variáveis de ambiente;
- ingestão protegida por token/API key quando compatível;
- validação de XML/JSON;
- limite de tamanho de payload;
- rate limiting;
- logs sem exposição de credenciais.

---

## 20. Escalabilidade

O MVP não necessita:

- cluster;
- Kafka;
- TimescaleDB;
- sharding;
- particionamento complexo;
- Redis obrigatório.

Começar simples:

```text
Node.js
MySQL
WebSocket
```

A arquitetura, porém, deve permitir evolução sem alterar o modelo funcional.

---

## 21. Documentos relacionados

```text
layout-claro.md
database-design.md
external-integration-findings.md
contest-run-collection-simulation.md
collector-architecture.md
```

Documentos futuros recomendados:

```text
contest-run-api.md
data-normalization.md
source-priority-dedup.md
internal-api.md
analytics-engine.md
deployment.md
security.md
test-plan.md
```

---

## 22. Decisões oficiais da primeira versão

1. MySQL será o banco principal.
2. Histórico será append-only.
3. Todos os contests ativos serão coletados simultaneamente.
4. A coleta independe do frontend.
5. Dados de múltiplas fontes serão normalizados.
6. `current_scores` será separado do histórico.
7. Raw payloads serão preservados.
8. O frontend consumirá apenas a API interna.
9. Redis não será obrigatório no MVP.
10. O sistema será preparado desde o início para múltiplas fontes e futuras extensões.
