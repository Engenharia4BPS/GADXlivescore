# Araucaria LiveScore — Deployment

> Documento de referência para implantação, operação e atualização do **Araucaria LiveScore** em produção.

---

## 1. Objetivo

Definir como os componentes do Araucaria LiveScore devem ser executados no ambiente do `araucariadx.com`, incluindo:

- backend Node.js/TypeScript;
- frontend web;
- MySQL;
- collector de fontes externas;
- WebSocket;
- reverse proxy;
- variáveis de ambiente;
- logs;
- health checks;
- backup;
- atualização e rollback.

O MVP deve privilegiar simplicidade operacional sem impedir evolução futura.

---

## 2. Princípios

1. **MySQL é a fonte de verdade.**
2. O collector continua rodando mesmo sem usuários no frontend.
3. Frontend nunca acessa diretamente `contest.run`, COSB ou HAMSCORE.
4. Configuração sensível fica fora do repositório.
5. Deploy deve ser repetível.
6. Toda versão implantada deve ser identificável por commit/tag.
7. Falha de uma fonte externa não deve derrubar a aplicação.

---

## 3. Topologia do MVP

```text
Internet
   │
   ▼
Reverse Proxy / HTTPS
   │
   ├── /livescore/             → Frontend
   ├── /livescore/api/v1/*     → Backend API
   ├── /livescore/ws            → WebSocket
   └── /livescore/ingest/*     → Logger ingestion
                                  │
                                  ▼
                         Node.js / TypeScript
                          │       │       │
                          │       │       └── External Collector
                          │       │
                          │       └── Analytics Engine
                          │
                          ▼
                        MySQL
```

Redis não é obrigatório no MVP.

---

## 4. Componentes de processo

Recomendação inicial: um único projeto backend com módulos separados, mas processos logicamente distintos.

```text
api
collector
worker/analytics
frontend
```

No MVP, `api`, `collector` e tarefas de analytics podem compartilhar o mesmo runtime Node se isso simplificar o deploy.

A arquitetura deve permitir separá-los depois sem alterar o contrato funcional.

---

## 5. Estratégia de execução

### Opção recomendada inicialmente

Docker Compose:

```text
frontend
backend
mysql (se o MySQL não for externo)
```

Se o servidor já possuir MySQL administrado fora do Compose, não duplicar o banco em container.

### Alternativa

Node.js executado como serviço `systemd` ou via process manager.

A escolha operacional deve considerar o ambiente real do `araucariadx.com`.

---

## 6. Estrutura sugerida de repositório

```text
/
├── apps/
│   ├── web/
│   └── api/
├── packages/
│   ├── domain/
│   ├── adapters/
│   └── shared/
├── migrations/
├── docs/
├── docker/
├── docker-compose.yml
├── .env.example
└── README.md
```

A estrutura final pode variar, mas deve manter separação entre domínio, adapters externos, persistência e apresentação.

---

## 7. Ambientes

No mínimo:

```text
local
production
```

Recomendado posteriormente:

```text
local
staging
production
```

Nunca testar POSTs destrutivos ou integrações experimentais diretamente no ambiente de produção sem controle explícito.

---

## 8. Variáveis de ambiente

Exemplo de `.env.example`:

```text
NODE_ENV=production
APP_PORT=3000
APP_BASE_PATH=/livescore

MYSQL_HOST=
MYSQL_PORT=3306
MYSQL_DATABASE=gadx_livescore
MYSQL_USER=
MYSQL_PASSWORD=

COLLECTOR_ENABLED=true
DISCOVERY_INTERVAL_SECONDS=600
DEFAULT_POLL_INTERVAL_SECONDS=60
PRE_START_WINDOW_SECONDS=1800
POST_END_WINDOW_SECONDS=3600
HTTP_TIMEOUT_SECONDS=20
MAX_CONCURRENT_PER_SOURCE=3

INGEST_MAX_BODY_BYTES=262144
LOG_LEVEL=info
```

Credenciais reais nunca devem entrar no Git.

---

## 9. MySQL

O banco já existente no ecossistema `araucariadx.com` deve ser reaproveitado quando possível.

Requisitos recomendados:

```text
MySQL 8.x preferencial
utf8mb4
InnoDB
UTC
```

A versão exata do servidor deve ser confirmada antes do DDL final.

---

## 10. Migrations

Mudanças de schema devem ser versionadas.

Fluxo:

```text
código novo
   │
   ▼
migration versionada
   │
   ▼
backup
   │
   ▼
aplicar migration
   │
   ▼
subir aplicação
```

Nunca depender de alterações manuais não registradas no banco de produção.

---

## 11. Reverse proxy

O reverse proxy deve terminar TLS e encaminhar:

```text
/livescore/             frontend
/livescore/api/         backend HTTP
/livescore/ws           WebSocket upgrade
/livescore/ingest/      backend ingest
```

Headers relevantes:

```text
X-Forwarded-For
X-Forwarded-Proto
X-Forwarded-Host
```

O backend deve confiar nesses headers apenas quando vierem do proxy conhecido.

---

## 12. HTTPS

Produção deve operar exclusivamente em HTTPS para interfaces públicas.

Requisitos:

- TLS válido;
- redirecionamento HTTP → HTTPS;
- WebSocket seguro (`wss://`) quando exposto externamente;
- nenhuma credencial em URL pública quando houver alternativa segura.

---

## 13. Collector

O collector deve iniciar automaticamente junto com o backend ou como serviço separado.

Responsabilidades operacionais:

```text
discovery contínuo
polling escalonado
retry/backoff
persistência de raw payload
normalização
health status
```

O collector nunca depende de página aberta no navegador.

---

## 14. Scheduler

Configuração inicial:

```text
Discovery: 5–10 min
Polling: ~60 s por contest ativo
Warmup: 30 min antes
Finishing: até 60 min depois
```

O scheduling deve ser distribuído ao longo do minuto para evitar burst de requisições.

---

## 15. WebSocket

O WebSocket publica eventos somente depois do commit no MySQL.

Eventos iniciais:

```text
score:update
contest:update
source:status
```

Em deploy com uma única instância Node não é necessário broker externo.

Se houver múltiplas instâncias no futuro, Redis/pub-sub pode ser introduzido.

---

## 16. Logs

Formato recomendado:

```text
structured JSON
UTC timestamp
level
component
source
contest_id
request_id/job_id
message
```

Exemplo conceitual:

```json
{
  "level": "info",
  "component": "collector",
  "source": "CONTEST_RUN",
  "contest_external_id": "40",
  "stations_received": 72,
  "snapshots_created": 19,
  "duplicates": 53
}
```

Nunca registrar senha, token ou Authorization header.

---

## 17. Health checks

Endpoints internos recomendados:

```text
GET /api/v1/health
GET /api/v1/admin/health/collectors
```

`/health` verifica:

```text
process alive
MySQL reachable
```

Health detalhado verifica:

```text
last discovery
last poll
last success por fonte
active contests
failure count
queue/backlog
```

---

## 18. Readiness e liveness

Separar conceitualmente:

```text
liveness  = processo está vivo?
readiness = consegue atender corretamente?
```

Se MySQL estiver indisponível, a aplicação pode estar viva porém não pronta.

---

## 19. Observabilidade mínima

Registrar/medir:

```text
HTTP request latency
HTTP 5xx
collector poll duration
poll success rate
HTTP 429 externos
active contest count
snapshots/min
raw messages/min
duplicates/min
WebSocket clients
DB query errors
```

---

## 20. Backup

O banco contém histórico único construído ao longo do contest.

Backup mínimo recomendado:

```text
dump diário
retenção rotativa
backup antes de migrations
```

Durante grandes contests, considerar backup adicional ao final do evento.

Raw payloads importantes também devem estar incluídos no backup.

---

## 21. Restore

O procedimento de restore deve ser testado antes de depender dele.

Checklist:

```text
restaurar banco em ambiente separado
validar migrations
validar count de contests
validar snapshots
validar current_scores
subir backend contra banco restaurado
```

Backup nunca deve ser considerado confiável sem teste de restauração.

---

## 22. Deploy de nova versão

Fluxo recomendado:

```text
1. merge/testes concluídos
2. identificar commit/tag
3. backup se houver migration
4. build
5. aplicar migration
6. restart controlado
7. health check
8. smoke test
9. observar logs/collector
```

---

## 23. Zero/minimal downtime

No MVP, alguns segundos de reinício podem ser aceitáveis.

O importante é não perder dados durante restart prolongado.

O collector deve retomar automaticamente discovery e polling.

Como cada fonte externa expõe estado atual, o sistema voltará a coletar após o restart; porém updates intermediários podem ser perdidos, portanto reinícios durante contests devem ser breves.

---

## 24. Rollback

Toda release deve ter caminho de rollback.

```text
app rollback → versão anterior
DB rollback  → somente se migration permitir
```

Preferir migrations backward-compatible quando possível.

Nunca fazer migration destrutiva junto com release sem backup e plano explícito.

---

## 25. CI/CD

Pipeline recomendado futuramente:

```text
lint
unit tests
integration tests
build
migration validation
container build
```

Deploy automático em produção pode ser adicionado depois.

No início, deploy manual controlado com checklist é aceitável.

---

## 26. Recursos

O MVP não exige infraestrutura pesada.

Esperado:

```text
1 backend Node
1 frontend
MySQL existente
sem Kafka
sem cluster
sem Redis obrigatório
```

O volume principal vem de snapshots periódicos, não de QSO individual em alta frequência.

---

## 27. Escala futura

Se necessário:

```text
API instances múltiplas
collector separado
Redis
job queue
read replicas
partitioning histórico
object storage para raw antigo
```

Essas otimizações só devem ser introduzidas quando métricas reais justificarem.

---

## 28. Retenção

Proposta inicial:

```text
score_snapshots   permanente
band_snapshots    permanente
current_scores    estado atual
raw_messages      manter inicialmente; política futura baseada em volume
logs              rotação configurada
```

---

## 29. Timezone

Backend e banco devem operar em UTC.

Frontend converte para timezone do usuário apenas para exibição.

Nunca armazenar timestamps competitivos em horário local sem timezone explícito.

---

## 30. Diretórios e persistência em Docker

Persistência deve ficar fora do filesystem efêmero do container.

Exemplo:

```text
MySQL data → volume persistente
logs       → stdout/stderr + agregação/rotação
```

Não depender do container para guardar arquivos únicos.

---

## 31. Configuração por ambiente

Código idêntico entre ambientes.

Diferenças entram por configuração:

```text
URLs
DB
credenciais
poll intervals
log level
feature flags
```

---

## 32. Feature flags úteis

```text
COLLECTOR_CONTEST_RUN_ENABLED
COLLECTOR_COSB_ENABLED
COLLECTOR_HAMSCORE_ENABLED
OUTBOUND_COSB_ENABLED
OUTBOUND_CONTEST_RUN_ENABLED
WEBSOCKET_ENABLED
```

Isso permite desabilitar uma integração problemática sem novo deploy.

---

## 33. Runbook mínimo

Operador deve saber responder:

```text
A API está viva?
MySQL está acessível?
Collector está rodando?
Qual foi o último poll?
Quantos contests estão ativos?
Qual fonte está falhando?
Há HTTP 429?
Há backlog?
```

---

## 34. Critérios de aceitação de produção

Antes de liberar o MVP:

1. build reproduzível;
2. migrations automatizadas/versionadas;
3. HTTPS funcionando;
4. health check funcionando;
5. collector reinicia automaticamente;
6. logs sem segredos;
7. backup configurado;
8. restore testado;
9. rollback documentado;
10. smoke test de ingestão e leitura concluído.

---

## 35. Decisão oficial

O deployment inicial do Araucaria LiveScore deve ser simples e previsível:

```text
Reverse Proxy + HTTPS
        │
        ▼
Node.js/TypeScript
   │          │
   │          └── Collector
   │
   ├── REST/WebSocket
   └── MySQL
```

Docker Compose é a opção preferencial caso seja compatível com a infraestrutura atual do `araucariadx.com`, mantendo MySQL externo se já houver serviço existente.