# Araucaria LiveScore — Test Plan

> Documento de referência para validação funcional, técnica e operacional do **Araucaria LiveScore**.
>
> Objetivo: provar que coleta, ingestão, normalização, deduplicação, analytics, API interna e realtime funcionam corretamente antes da produção.

---

## 1. Escopo

Este plano cobre:

- ingestão direta de N1MM/DXLog;
- descoberta de contests;
- coleta simultânea de todos os contests ativos;
- normalização;
- persistência MySQL;
- deduplicação;
- source priority;
- analytics;
- API interna;
- WebSocket;
- segurança básica;
- resiliência;
- deploy/restore.

---

## 2. Estratégia de testes

Camadas:

```text
unit
integration
contract
end-to-end
load/resilience
security
operational smoke tests
```

Cada camada deve validar uma responsabilidade específica.

---

## 3. Critério geral de sucesso

O sistema deve conseguir rodar por horas durante múltiplos contests simultâneos, sem:

- misturar contests;
- perder consistência;
- gerar duplicatas indevidas;
- travar quando uma fonte falha;
- calcular deltas incorretamente;
- depender do frontend aberto.

---

## 4. Fixtures

Criar fixtures versionadas para:

```text
contest.run normal
contest.run payload parcial
dynamicresults N1MM
dynamicresults DXLog
score repetido
timestamp repetido
score diminuindo
breakdown ausente
breakdown parcial
categoria desconhecida
payload inválido
```

Fixtures devem ser pequenas, legíveis e determinísticas.

---

## 5. Unit tests — normalização

Validar:

```text
callsign → uppercase
trim de strings
null != 0
UTC
score integer
band aliases
mode aliases
category mapping
contest external id mapping
```

Casos obrigatórios:

```text
q20 ausente → null
q20=0 → 0
" cr3w " → "CR3W"
PH → SSB
28 → 10m
```

---

## 6. Unit tests — analytics

Validar:

```text
Δ Score
Δ QSO
Δ Mult
QSO/h
Score/h
Gap
Gain/Loss
band deltas
dominant band observed
```

Usar timestamps não exatamente alinhados.

Exemplo:

```text
19:30:11 qso 1500
20:00:37 qso 1548
```

O rate deve usar elapsed real, não 30 min fixos.

---

## 7. Unit tests — snapshot selection

Para janela de 30 min:

```text
alvo 19:30:37
```

Testar:

```text
snapshot 19:30:11 → selecionado
snapshot 19:31:00 → não preferido se regra for at/before
sem snapshot próximo → window quality degradada
```

---

## 8. Unit tests — deduplicação

Casos:

```text
mesmo payload, mesma fonte → duplicate
mesmo score, timestamp novo → não necessariamente duplicate
mesmo score, breakdown diferente → novo snapshot
mesmo estado em duas fontes → replicated equivalent
fontes divergentes → preservar ambas
```

Nunca testar igualdade apenas por score.

---

## 9. Unit tests — source priority

Validar:

```text
DIRECT fresco > EXTERNAL fresco
DIRECT stale < EXTERNAL fresco
source priority não apaga provenance
```

Exemplo:

```text
DIRECT último update 20 min atrás
CONTEST_RUN último update 30 s atrás
```

O current canonical pode usar CONTEST_RUN.

---

## 10. Integration test — banco

Com MySQL real de teste:

```text
insert raw_message
resolve contest
resolve entry
insert score_snapshot
insert band_snapshots
update current_scores
commit
```

Verificar foreign keys, indexes e transação.

---

## 11. Integration test — rollback transacional

Forçar erro após inserir `score_snapshot` e antes de `current_scores`.

Resultado esperado:

```text
nenhum estado parcial persistido
```

---

## 12. Integration test — contest discovery

Simular retorno:

```text
Contest A ACTIVE
Contest B ACTIVE
Contest C UPCOMING
```

Validar:

```text
A e B ganham jobs de poll
C entra em registry mas não em polling normal antes da janela configurada
```

---

## 13. Integration test — múltiplos contests

Simular pelo menos 5 contests ativos simultaneamente.

Validar:

```text
jobs independentes
staggering
contest_id correto
nenhuma mistura de entries
```

---

## 14. Integration test — contest novo durante execução

Sequência:

```text
T0 discovery → A e B
T+10min      → A, B e C
```

Sem restart:

```text
C deve ser registrado
categorias carregadas
polling iniciado
```

---

## 15. Integration test — finalização

Quando:

```text
agora > end_at + POST_END_WINDOW
```

validar:

```text
job de polling encerra
histórico permanece acessível
```

---

## 16. Contract test — contest.run

Testar contra fixtures e, quando possível, endpoint real:

```text
/api/contest/nearest
/api/contest/month/{month}
/api/category/contest/{id}
/api/displayscore/{id}
```

Verificar:

- HTTP status;
- JSON parseável;
- campos mínimos;
- tipos;
- tolerância a campos novos.

Mudança externa não deve derrubar todo o collector.

---

## 17. Contract test — dynamicresults

Validar parser com XML representativo de N1MM/DXLog.

Campos:

```text
contest
call
class
club
qth
breakdown
score
timestamp
```

Também testar XML com elementos opcionais ausentes.

---

## 18. End-to-end — ingestão direta

Fluxo completo:

```text
POST dynamicresults
      │
      ▼
raw_messages
      │
      ▼
normalize
      │
      ▼
score_snapshots
band_snapshots
current_scores
      │
      ▼
GET scoreboard
```

Validar que o valor enviado aparece corretamente na API.

---

## 19. End-to-end — collector externo

Fluxo:

```text
mock contest.run
      │
      ▼
discovery
      │
      ▼
poll
      │
      ▼
normalize
      │
      ▼
MySQL
      │
      ▼
API
```

---

## 20. End-to-end — Rival Monitor

Criar histórico controlado de duas estações.

Validar:

```text
gap atual
gap anterior
gain/loss
delta score
delta qso
dominant band observed
```

---

## 21. End-to-end — WebSocket

Depois de inserir um novo snapshot e commit:

```text
score:update
```

deve ser emitido.

Não emitir antes do commit.

Se a transação falhar:

```text
nenhum evento deve sair
```

---

## 22. API tests

Cobrir:

```text
GET /api/v1/contests
GET /api/v1/contests/live
GET /api/v1/contests/{id}
GET /api/v1/contests/{id}/scoreboard
GET /api/v1/contests/{id}/stations/{call}
GET /api/v1/contests/{id}/stations/{call}/history
GET /api/v1/contests/{id}/compare
GET /api/v1/contests/{id}/rivals
GET /api/v1/sources/status
```

Validar status codes, schema, null handling e paginação.

---

## 23. API errors

Casos:

```text
contest inexistente → 404
callsign inexistente → 404
window inválida → 400
cursor inválido → 400
erro interno → 500 sem stack trace
```

---

## 24. Teste de paginação

Criar >100 entries.

Validar:

```text
limit
next_cursor
sem duplicação entre páginas
sem perda entre páginas
```

---

## 25. Teste de freshness/stale

Criar uma fonte que pare de atualizar.

Validar:

```text
status stale
canonical source troca se outra fonte estiver fresca
frontend recebe last_update correto
```

---

## 26. Teste de divergência entre fontes

Exemplo:

```text
contest.run: score 1.000.000 qso 1000
COSB:        score   990.000 qso  990
```

Validar:

```text
ambas observações preservadas
canonical escolhido pela política
divergence metric registrada
```

---

## 27. Teste de loop outbound

Fluxo simulado:

```text
DIRECT → Araucaria → external server
external server → collector → Araucaria
```

Resultado:

```text
observation externa não deve ser retransmitida automaticamente
```

---

## 28. Resiliência — timeout externo

Fonte demora além do timeout.

Validar:

```text
request abortada
erro registrado
outros contests continuam
backoff aplicado
```

---

## 29. Resiliência — HTTP 429

Validar:

```text
Retry-After respeitado quando presente
intervalo aumenta
não gerar loop agressivo
```

---

## 30. Resiliência — HTTP 500

Fonte retorna 5xx por vários polls.

Validar:

```text
backoff exponencial
collector continua nas demais fontes
```

---

## 31. Resiliência — JSON inválido

Resposta externa inválida:

```text
raw preservado
processing_status=error
nenhum snapshot corrompido criado
```

---

## 32. Resiliência — restart

Reiniciar backend durante contest.

Validar:

```text
startup saudável
discovery retomado
polling retomado
sem duplicação indevida
current_scores consistente
```

---

## 33. Load test — API pública

Gerar carga representativa de usuários consultando scoreboard.

Medir:

```text
p50
p95
p99
error rate
DB load
```

Meta inicial deve ser definida após primeiro baseline real.

---

## 34. Load test — collector

Simular:

```text
10 contests ativos
200 stations por contest
poll 60s
```

Verificar:

```text
CPU
memory
DB writes
poll duration
backlog
```

---

## 35. Soak test

Executar por pelo menos algumas horas, idealmente duração de um contest.

Monitorar:

```text
memory leak
connection leak
crescimento de fila
latência crescente
reconnects
```

---

## 36. Security tests mínimos

Testar:

```text
XXE
payload gigante
SQL injection
XSS
credential inválida
replay
rate limit
source spoofing
admin sem auth
WebSocket flood básico
```

Detalhes estão em `security.md`.

---

## 37. XML XXE test

Enviar payload com external entity.

Resultado esperado:

```text
não resolver entidade
não acessar arquivo/rede
request rejeitada ou tratada de forma segura
```

---

## 38. Teste de body limit

Payload acima do limite configurado.

Esperado:

```text
413 Payload Too Large
```

Nenhum processamento parcial.

---

## 39. Teste de autenticação de ingestão

Casos:

```text
token válido
token inválido
token revogado
credential de outra estação
```

Validar scopes quando implementados.

---

## 40. Teste de logs

Garantir que logs não contenham:

```text
password
token completo
Authorization
DB password
```

Testar também request IDs e correlação.

---

## 41. Teste de migration

Para cada migration:

```text
aplicar em banco vazio
aplicar em banco com versão anterior
rodar testes
```

Migration deve falhar de modo claro se pré-condições não forem atendidas.

---

## 42. Teste de backup/restore

Obrigatório antes de produção.

Fluxo:

```text
popular banco
backup
restaurar em banco novo
subir aplicação
comparar contests/snapshots/current_scores
```

---

## 43. Smoke test pós-deploy

Após cada deploy:

```text
GET health
GET contests/live
GET scoreboard de contest conhecido
verificar collector last_success
verificar MySQL
abrir WebSocket
```

Se houver ingestão de teste segura, enviar payload controlado.

---

## 44. Teste com General QSO Test

Para testes reais do ecossistema `contest.run`, usar um ambiente/contest de teste apropriado quando disponível, evitando publicar scores falsos em contest ativo real.

Qualquer POST externo deve ser explícito e controlado.

---

## 45. Dados de produção

Nunca alterar score real de terceiros para testar.

Leitura pública pode ser usada para contract tests passivos.

Writes devem utilizar:

```text
ambiente de teste
contest de teste
credential própria
```

---

## 46. Regression suite

Todo bug corrigido deve gerar um teste.

Exemplo:

```text
bug: timestamp duplicate gerava snapshot duplo
→ adicionar fixture + regression test
```

---

## 47. CI mínimo

Em PR/commit relevante:

```text
lint
unit tests
integration tests selecionados
build
```

Em pipeline mais completo:

```text
MySQL service container
migrations
API integration tests
security static scan
```

---

## 48. Critérios de aceite do MVP

O MVP está pronto quando:

1. recebe score direto com segurança básica;
2. descobre contests automaticamente;
3. coleta todos os contests ativos simultaneamente;
4. armazena histórico append-only;
5. normaliza breakdown por banda;
6. deduplica corretamente;
7. troca canonical source quando necessário;
8. calcula analytics conforme `analytics-engine.md`;
9. API responde conforme `internal-api.md`;
10. WebSocket só publica após commit;
11. falha de fonte externa não derruba o sistema;
12. backup/restore está testado;
13. smoke test pós-deploy passa.

---

## 49. Matriz resumida

```text
NORMALIZATION     unit
ANALYTICS         unit + integration
DEDUP             unit + integration
DATABASE          integration
COLLECTOR         integration + E2E
INGEST             integration + E2E + security
API               integration + contract
WEBSOCKET         integration + E2E
DEPLOY            smoke + restore
SECURITY          targeted security tests
```

---

## 50. Decisão oficial

O projeto não considerará uma funcionalidade concluída apenas porque funciona visualmente no frontend.

Cada fluxo crítico deve possuir validação automatizada ou procedimento reproduzível, com prioridade para:

```text
ingestão
coleta
persistência
dedup
analytics
resiliência
```

O objetivo do test plan é garantir que o Araucaria LiveScore permaneça confiável justamente durante os períodos de maior importância: contests longos, múltiplas fontes e alta atividade.