# Araucaria LiveScore — Source Priority & Deduplication

> Documento de referência para prioridade de fontes, deduplicação, reconciliação e prevenção de loops no **Araucaria LiveScore**.

---

## 1. Objetivo

O mesmo score pode chegar ao Araucaria por múltiplos caminhos.

Exemplo:

```text
ZW5B
 ├── direto do N1MM
 ├── contest.run
 ├── COSB
 └── HAMSCORE
```

O sistema deve:

- preservar todas as origens relevantes;
- evitar duplicatas inúteis;
- selecionar um estado atual confiável;
- impedir loops de federação;
- nunca perder histórico legítimo.

---

## 2. Regra principal

**Deduplicação e reconciliação são problemas diferentes.**

### Deduplicação

Pergunta:

> Esta mensagem/evento já foi processado?

### Reconciliação

Pergunta:

> Duas fontes diferentes estão descrevendo o mesmo estado da mesma estação; qual deve alimentar o estado atual?

Não tratar os dois problemas como se fossem um só.

---

## 3. Prioridade inicial de fontes

Ordem base:

```text
1. DIRECT LOGGER
2. FEDERATION
3. EXTERNAL SERVER
4. MANUAL
```

Exemplo:

```text
ARAUCARIA_DIRECT
    >
SCOREDISTRIBUTOR
    >
CONTEST_RUN / COSB / HAMSCORE
    >
MANUAL
```

---

## 4. Por que o logger direto tem prioridade

O Araucaria recebe o dado diretamente da estação, sem polling, replicação, atraso intermediário ou transformação por terceiros.

Por isso deve ser a fonte preferencial quando disponível e saudável.

---

## 5. Prioridade não significa apagar dados

Se ZW5B chegar diretamente e também via `contest.run`, preservar ambas as origens em `raw_messages` e no histórico/provenance.

O `current_scores` pode usar o dado direto como estado canônico atual.

---

## 6. Identidade lógica de uma entry

A identidade base é:

```text
contest_id
+
callsign normalizado
```

Modelo inicial:

```text
UNIQUE(contest_id, callsign)
```

Se surgirem casos reais de múltiplas entries legítimas para o mesmo callsign no mesmo contest, evoluir para uma assinatura de categoria.

---

## 7. Deduplicação dentro da mesma fonte

Primeiro nível:

```text
source_id
external_message_id
```

Se a fonte fornece um ID estável de mensagem, usar isso. Caso contrário, gerar fingerprint.

---

## 8. Fingerprint de mensagem

Exemplo:

```text
SHA256(
  source_id +
  contest_external_id +
  callsign +
  source_timestamp +
  score +
  qso_total +
  normalized_payload_subset
)
```

Também armazenar `payload_hash` do raw payload completo.

---

## 9. Não usar score sozinho

Isto é incorreto:

```text
same score → duplicate
```

Uma estação pode manter o mesmo score e ainda assim alterar categoria, multiplicadores, breakdown ou timestamp.

---

## 10. Duplicata exata

Se source, contest, callsign, timestamp, score, QSO e payload/fingerprint forem idênticos, não criar novo `score_snapshot`.

Pode-se incrementar `duplicate_count` ou registrar o novo recebimento operacionalmente.

---

## 11. Mesmo estado com timestamp diferente

Exemplo:

```text
22:31 score 1.732.224
22:32 score 1.732.224
```

Não é necessariamente duplicata. Pode representar heartbeat/update sem progresso.

---

## 12. Cross-source não deve ser descartado cegamente

Exemplo:

```text
22:31:00 contest.run
CR3W score 1.732.224

22:31:05 COSB
CR3W score 1.732.224
```

Provavelmente é o mesmo estado replicado, mas a segunda origem deve continuar preservada como provenance.

---

## 13. Modelo recomendado

Separar conceitualmente:

```text
source observations
```

de:

```text
canonical current state
```

No MVP:

```text
score_snapshots
+
source_id
+
current_scores
```

---

## 14. `score_snapshots`

Campos relevantes:

```text
entry_id
source_id
source_timestamp
received_at
score
qso_total
points_total
mult_total
fingerprint
raw_message_id
```

---

## 15. `current_scores`

Mantém a versão selecionada para uso imediato:

```text
entry_id
canonical_snapshot_id
source_id
score
qso_total
mult_total
last_update
```

---

## 16. Seleção da fonte atual

Critérios sugeridos:

```text
1. source priority
2. freshness
3. completeness
4. health/status da fonte
```

Não usar apenas prioridade fixa.

---

## 17. Freshness

Uma fonte prioritária muito antiga não deve bloquear uma fonte externa atual.

Exemplo:

```text
DIRECT LOGGER
último update: 20 minutos atrás

CONTEST_RUN
último update: 30 segundos atrás
```

O estado atual pode temporariamente usar `contest.run`.

---

## 18. Janela de stale

Configuração inicial conceitual:

```text
DIRECT_STALE_AFTER = 5 min
EXTERNAL_STALE_AFTER = 5 min
```

Valores reais devem ser ajustados conforme o comportamento observado.

---

## 19. Completeness

Entre duas fontes com prioridade semelhante, uma fonte com score + QSO + bands + mult é mais completa que uma fonte com apenas score + QSO.

Isso não implica merge automático campo a campo.

---

## 20. Política inicial recomendada

Escolher um **snapshot canônico completo**, não fazer field-by-field merge automaticamente.

Misturar score de A, QSO de A, bands de B e mult de C pode criar um estado que nunca existiu em nenhuma fonte.

---

## 21. Enriquecimento controlado

No futuro, pode haver enriquecimento por campos auxiliares como club, DXCC, grid, lat/lon e logger, desde que não alterem métricas competitivas e a origem seja preservada.

---

## 22. Estado canônico — algoritmo conceitual

```text
candidates = snapshots recentes da entry

remover candidates stale

ordenar por:
  source_priority DESC
  source_timestamp DESC
  completeness DESC

canonical = primeiro
```

---

## 23. Prioridade entre servidores externos

`CONTEST_RUN`, `COSB` e `HAMSCORE` não precisam ter prioridade absoluta fixa.

Podemos avaliar:

```text
freshness
availability
breakdown completeness
timestamp quality
API stability
```

---

## 24. Fonte preferida por contest

Permitir futuramente `contest_source_preferences` quando determinada fonte tiver suporte superior para um contest específico.

---

## 25. Reconciliation window

Para comparar observações de fontes diferentes, usar inicialmente uma janela aproximada de:

```text
± 60–120 segundos
```

Não assumir igualdade apenas pela proximidade temporal.

---

## 26. Estado equivalente

Critério forte:

```text
same contest
same callsign
score equal
qso equal
timestamp próximo
```

Pode ser marcado como `replicated_equivalent`.

---

## 27. Estado divergente

Se fontes apresentarem score/QSO diferentes, não descartar nenhuma. Classificar como `source divergence` e escolher a fonte canônica conforme prioridade, freshness e health.

---

## 28. Histórico e mudança de fonte

Exemplo:

```text
20:00 DIRECT
20:02 DIRECT
20:04 DIRECT
20:06 contest.run
20:08 contest.run
20:10 DIRECT volta
```

O analytics deve continuar funcionando e cada snapshot mantém `source_id` para auditoria.

---

## 29. Analytics e múltiplas fontes

Para cálculos de delta, preferir snapshots da mesma sequência canônica ou selecionar snapshots compatíveis.

Evitar comparações de fontes estruturalmente divergentes sem uma regra explícita.

---

## 30. Loop de federação

Problema:

```text
N1MM
  ↓
Araucaria
  ↓
COSB
  ↓
federation
  ↓
Araucaria lê COSB
  ↓
Araucaria reenvia
```

Isso não pode acontecer.

---

## 31. Regra outbound

```text
DIRECT LOGGER
→ pode ser forwarded

MANUAL
→ depende de configuração

EXTERNAL SERVER
→ não forward por padrão

FEDERATION
→ não devolver à mesma federação
```

---

## 32. Provenance obrigatório

Todo snapshot deve carregar:

```text
origin_source
ingest_source
```

Exemplo:

```text
origin_source = ARAUCARIA_DIRECT
ingest_source = ARAUCARIA_DIRECT
```

ou:

```text
origin_source = UNKNOWN_EXTERNAL
ingest_source = CONTEST_RUN
```

---

## 33. Forwarding marker

Criar futuramente tabela `outbound_deliveries` com campos como:

```text
snapshot_id
destination_source_id
sent_at
status
response_code
response_body
```

---

## 34. Nunca reenviar observation externa por padrão

Regra segura:

```text
if ingest_source is EXTERNAL_SERVER:
    outbound = false
```

A menos que exista configuração explícita e protocolo seguro de federation.

---

## 35. Dedup de outbound

Antes de enviar, `snapshot_id + destination_source_id` deve ser único.

---

## 36. Hashes

Armazenar dois hashes:

### Raw hash

```text
payload_hash
```

### Normalized fingerprint

```text
fingerprint
```

Isso ajuda a detectar o mesmo conteúdo em formatos diferentes.

---

## 37. Exemplo de normalized fingerprint

```text
SHA256(
  contest_id |
  callsign |
  source_timestamp |
  score |
  qso_total |
  mult_total |
  normalized_band_breakdown
)
```

---

## 38. Idempotência

Todo pipeline deve ser idempotente. Processar o mesmo raw message duas vezes não pode criar dois snapshots idênticos.

---

## 39. Transação

```text
BEGIN

insert raw_message if new
resolve entry
check fingerprint

if duplicate:
    mark duplicate
    COMMIT
    stop

insert score_snapshot
insert band_snapshots
reconcile canonical current state
update current_scores

COMMIT
```

Somente depois publicar evento WebSocket.

---

## 40. Timestamp ausente

Se a fonte não fornece timestamp:

```text
source_timestamp = null
received_at = now()
```

Pode ser necessário dedup window específico para a fonte.

---

## 41. Dedup window

Para fontes sem timestamp, um mesmo contest/callsign/score/QSO/breakdown recebido dentro de uma janela curta pode ser classificado como provável duplicata.

A regra deve ser source-specific.

---

## 42. Heartbeats

Recomendação inicial:

- `raw_messages`: guardar conforme política de retenção;
- `score_snapshots`: inserir quando timestamp muda ou conteúdo competitivo muda;
- permitir configuração por source adapter.

---

## 43. Retenção

Snapshots históricos: manter indefinidamente.

Raw messages: manter inicialmente e depois avaliar compressão, arquivamento e política de retenção.

---

## 44. Observabilidade

Métricas úteis:

```text
duplicates_same_source
replicated_cross_source
source_divergences
canonical_source_switches
stale_sources
outbound_loop_blocks
outbound_duplicate_blocks
```

---

## 45. Política inicial resumida

```text
DIRECT LOGGER
↓
preferir quando recente

FEDERATION
↓
usar quando origem direta ausente

EXTERNAL
↓
usar para rivais e fallback

MANUAL
↓
última prioridade
```

---

## 46. Regras que não devemos quebrar

1. Nunca perder raw provenance.
2. Nunca deduplicar apenas por score.
3. Nunca assumir que duas fontes iguais são independentes.
4. Nunca misturar métricas competitivas de fontes diferentes sem regra explícita.
5. Nunca reenviar automaticamente dados coletados de servidores externos.
6. Nunca bloquear uma fonte fresca apenas porque uma fonte de maior prioridade ficou stale.
7. Nunca sobrescrever histórico.

---

## 47. Decisão oficial

O Araucaria LiveScore utilizará:

```text
deduplication
+
source reconciliation
+
canonical current state
+
full provenance
```

como conceitos separados.

A prioridade padrão será:

```text
DIRECT LOGGER > FEDERATION > EXTERNAL SERVER > MANUAL
```

mas a seleção do estado atual também levará em conta:

```text
freshness
completeness
source health
```

Dados de fontes externas serão preservados, mas **não serão retransmitidos automaticamente**, evitando loops de federação.
