# Araucaria LiveScore — Analytics Engine

> Documento de referência para o motor analítico do **Araucaria LiveScore**.
>
> Objetivo: definir as regras matemáticas, temporais e de qualidade usadas para transformar snapshots históricos em métricas de competição, Rival Monitor, scoreboard e gráficos.

---

## 1. Princípio central

O Analytics Engine nunca deve inventar estado.

Ele trabalha sobre snapshots persistidos e calcula métricas derivadas de forma reproduzível.

Fluxo oficial:

```text
score_snapshots
band_snapshots
current_scores
      │
      ▼
Analytics Engine
      │
      ├── deltas
      ├── rates
      ├── gaps
      ├── gains
      ├── band activity
      ├── ranking
      └── trend indicators
      │
      ▼
Internal API / WebSocket / Frontend
```

Dados derivados nunca substituem os snapshots de origem.

---

## 2. Métricas principais

O MVP deve calcular:

```text
Δ Score
Δ QSO
Δ Mult
Δ Points
Δ QSO por banda
Δ Mult por banda
QSO/h
Score/h
Gap para líder
Gap para rival
Gain/Loss sobre rival
posição atual
variação de posição
banda dominante observada
aceleração/desaceleração
freshness/staleness
```

---

## 3. Janelas oficiais

As janelas iniciais serão:

```text
last
10m
30m
1h
2h
6h
contest
```

Significados:

- `last`: comparação com o snapshot canônico anterior;
- `10m`: aproximadamente últimos 10 minutos;
- `30m`: aproximadamente últimos 30 minutos;
- `1h`: aproximadamente última hora;
- `2h`: aproximadamente últimas 2 horas;
- `6h`: aproximadamente últimas 6 horas;
- `contest`: desde o primeiro snapshot útil do contest/entry.

---

## 4. Nunca assumir intervalo fixo

Mesmo que o collector tente coletar a cada 60 segundos, o Analytics Engine não deve assumir:

```text
1 poll = 60 segundos
```

Sempre usar o tempo real entre snapshots.

Exemplo:

```text
snapshot A: 19:30:11
snapshot B: 20:00:37
```

Tempo real:

```text
30 min 26 s
```

Esse tempo é usado nas fórmulas de rate.

---

## 5. Seleção do snapshot histórico

Para uma janela `W`:

```text
target_time = current_snapshot_time - W
```

Exemplo:

```text
agora:        20:00:37
janela:       30m
alvo:         19:30:37
```

A regra preferencial é:

> escolher o snapshot canônico mais próximo **em ou antes** do alvo.

Exemplo:

```text
19:29:58  ← candidato preferido
19:30:11
19:31:04
```

Pode haver tolerância configurável para evitar usar um snapshot excessivamente antigo.

---

## 6. Tolerância da janela

Sugestão inicial:

```text
10m → tolerância máxima de 3m
30m → tolerância máxima de 5m
1h  → tolerância máxima de 10m
2h  → tolerância máxima de 15m
6h  → tolerância máxima de 30m
```

Se não houver snapshot histórico dentro da tolerância:

```text
metric_status = INSUFFICIENT_HISTORY
```

Não fabricar delta usando um ponto muito distante sem indicar isso.

---

## 7. Timestamp analítico

Preferência:

```text
source_timestamp
```

Fallback:

```text
received_at
```

Se a fonte não fornecer timestamp confiável, o engine pode usar `received_at`, mas deve manter essa informação no contexto da métrica.

---

## 8. Delta de Score

```text
delta_score = current.score - past.score
```

Exemplo:

```text
19:30  1.500.000
20:00  1.620.000

Δ Score = +120.000
```

Score negativo é permitido como resultado analítico se a fonte corrigiu o valor para baixo.

---

## 9. Delta de QSO

```text
delta_qso = current.qso_total - past.qso_total
```

Exemplo:

```text
1500 → 1548

Δ QSO = +48
```

Não forçar resultado negativo para zero.

Uma redução pode ser uma correção legítima do logger.

---

## 10. Delta de multiplicadores

```text
delta_mult = current.mult_total - past.mult_total
```

Se `mult_total` estiver ausente em qualquer extremidade:

```text
delta_mult = null
```

Nunca converter ausência para zero.

---

## 11. Delta de pontos

```text
delta_points = current.points_total - past.points_total
```

Útil para separar crescimento por QSO de crescimento por multiplicador quando a regra do contest permitir.

---

## 12. Delta por banda

Para cada banda presente nos dois snapshots:

```text
delta_qso_band = current.qso_band - past.qso_band
```

Exemplo:

```text
80m   +2
40m  +11
20m  +37
15m   +8
10m    0
```

Se uma banda está ausente em um dos snapshots:

```text
delta = null
```

Não assumir zero.

---

## 13. QSO Rate

Fórmula:

```text
elapsed_hours = elapsed_seconds / 3600

qso_rate = delta_qso / elapsed_hours
```

Exemplo:

```text
19:30:11 → 1500 QSO
20:00:37 → 1548 QSO

ΔQSO = 48
elapsed = 1826 s = 0,5072 h

QSO Rate ≈ 94,6 QSO/h
```

---

## 14. Score Rate

```text
score_rate = delta_score / elapsed_hours
```

Exemplo:

```text
ΔScore = +180.000
elapsed = 0,5 h

Score Rate = 360.000 pontos/h
```

---

## 15. Taxas em janelas muito curtas

Uma extrapolação de 1 minuto pode produzir números matematicamente corretos, porém operacionalmente enganosos.

Exemplo:

```text
12 QSO em 1 min
→ 720 QSO/h
```

Classificação inicial recomendada:

```text
< 3 min   → VERY_PROVISIONAL
3–5 min   → PROVISIONAL
5–10 min  → USABLE
>= 10 min → STABLE
```

A interface pode optar por:

- não destacar rates `VERY_PROVISIONAL`;
- exibir indicador visual;
- preferir 10m/30m para decisões operacionais.

---

## 16. Gap para o líder

Para uma estação `S`:

```text
gap_to_leader = S.score - leader.score
```

Assim:

```text
leader → 0
atrás  → valor negativo
```

Exemplo:

```text
Leader 2.180.000
ZW5B   2.100.000

Gap = -80.000
```

Essa convenção facilita mostrar ganho/perda consistentemente.

---

## 17. Gap para um rival

```text
gap_to_rival = our_score - rival_score
```

Exemplo:

```text
ZW5B  2.100.000
CR3W  2.180.000

Gap = -80.000
```

Se ZW5B estiver à frente:

```text
Gap > 0
```

---

## 18. Gain/Loss sobre rival

Comparar a evolução do gap entre dois momentos.

```text
gain_vs_rival = current_gap - past_gap
```

Exemplo:

Há 1h:

```text
ZW5B 1.700.000
CR3W 1.820.000
Gap = -120.000
```

Agora:

```text
ZW5B 2.100.000
CR3W 2.180.000
Gap = -80.000
```

Logo:

```text
Gain 1h = (-80.000) - (-120.000)
        = +40.000
```

Interpretação:

> ZW5B tirou 40 mil pontos da diferença na última hora.

---

## 19. Perda para rival

Se:

```text
past_gap    = -50.000
current_gap = -80.000
```

então:

```text
gain_vs_rival = -30.000
```

Interpretação:

> perdemos 30 mil pontos de terreno na janela.

---

## 20. Velocidade de fechamento do gap

Opcionalmente:

```text
gap_rate = gain_vs_rival / elapsed_hours
```

Exemplo:

```text
+40.000 em 1h
→ +40.000 pontos/h
```

Pode alimentar futura estimativa de catch-up, mas o MVP não deve prometer previsão determinística.

---

## 21. ETA para alcançar rival — futura/experimental

Somente quando:

```text
gap < 0
gap_rate > 0
janela suficientemente estável
```

Fórmula simples:

```text
hours_to_catch = abs(gap) / gap_rate
```

Exemplo:

```text
gap = -80.000
gap_rate = +40.000/h

ETA ≈ 2h
```

Essa métrica deve ser marcada como `ESTIMATE`, nunca como previsão garantida.

---

## 22. Ranking atual

Ranking padrão:

```text
score DESC
```

Empates podem ser resolvidos por:

```text
1. score
2. qso_total
3. mult_total
4. source_timestamp mais recente
5. callsign ASC
```

Essa regra é apenas para apresentação do live scoreboard, não substitui a regra oficial do contest.

---

## 23. Ranking por categoria

Comparações devem respeitar categoria quando solicitado.

Exemplo:

```text
MULTI-OP HIGH ALL BAND
```

Uma estação de outra categoria não deve aparecer como rival direto quando a tela está filtrada por categoria, salvo opção explícita de comparação geral.

---

## 24. Variação de posição

Para a mesma janela:

```text
rank_change = past_rank - current_rank
```

Exemplo:

```text
past_rank = 5
current_rank = 3

rank_change = +2
```

Interpretação:

> subiu duas posições.

---

## 25. Banda dominante observada

Sem QSO-level data, não podemos afirmar:

> "a estação está agora em 20m".

Podemos afirmar:

> "20m foi a banda dominante no intervalo observado".

Regra inicial:

```text
dominant_band_observed = banda com maior delta_qso positivo na janela
```

Exemplo:

```text
80m   +2
40m  +11
20m  +37
15m   +8
10m    0

Dominant band observed = 20m
```

---

## 26. Empate de bandas

Se duas bandas tiverem o mesmo maior delta:

```text
dominant_band_observed = null
```

ou retornar:

```json
{
  "bands": ["20m", "15m"],
  "status": "TIE"
}
```

Não escolher arbitrariamente uma banda.

---

## 27. Banda dominante por Score

Futura opção quando pontos por banda forem confiáveis:

```text
dominant_band_by_points
```

Ela pode diferir de:

```text
dominant_band_by_qso
```

As duas métricas devem permanecer distintas.

---

## 28. Atividade por banda

Para cada banda, calcular quando possível:

```text
delta_qso
qso_rate_band
delta_mult
share_of_qso_growth
```

Exemplo:

```text
20m:
ΔQSO = 37
Total ΔQSO = 58

share = 37 / 58 = 63,8%
```

---

## 29. Aceleração

Comparar duas janelas consecutivas de mesmo tamanho.

Exemplo:

```text
QSO rate últimos 10m      = 120/h
QSO rate 10m anteriores   = 90/h
```

```text
acceleration = +30 QSO/h
```

Pode ser representado como:

```text
ACCELERATING
STABLE
DECELERATING
```

---

## 30. Threshold de tendência

Evitar classificar pequenas oscilações como tendência.

Sugestão inicial:

```text
|diferença| < 10% → STABLE
>= +10%             → ACCELERATING
<= -10%             → DECELERATING
```

Threshold configurável.

---

## 31. Freshness

Cada estação deve ter:

```text
age_seconds = now - latest_source_timestamp
```

ou fallback para `received_at`.

Status sugerido:

```text
<= 2 min  → FRESH
2–5 min   → AGING
5–15 min  → STALE
> 15 min  → VERY_STALE
```

Esses limites são iniciais e configuráveis.

---

## 32. Estação stale

Uma estação stale:

- permanece no scoreboard;
- mantém último valor conhecido;
- recebe indicador de idade;
- não deve ser tratada como se estivesse parada operacionalmente com certeza.

Ausência de update não significa necessariamente ausência de QSOs.

---

## 33. Dados faltantes

Regra:

```text
null permanece null
```

Exemplo:

Se `mult_total` não existe:

```text
delta_mult = null
```

Se 20m não existe no snapshot histórico:

```text
delta_qso_20m = null
```

Nunca usar zero como substituto automático.

---

## 34. Score ou QSO reduzindo

Reduções devem ser preservadas.

Exemplo:

```text
20:00 qso = 1200
20:02 qso = 1194
```

Resultado:

```text
ΔQSO = -6
```

Marcar opcionalmente:

```text
anomaly = COUNTER_DECREASE
```

Não corrigir silenciosamente.

Contadores competitivos - score, QSO, multiplicadores e valores por banda - não
são garantidamente monotônicos. Deltas negativos são observações válidas e
resets ou correções devem permanecer na sequência canônica.

Se uma janela de rate incluir redução ou reset de contador, a taxa deve receber
um status anômalo, por exemplo:

```text
rate_status = ANOMALO_RESET_OU_CORRECAO
```

O engine não deve substituir o delta negativo por zero. Uma atualização apenas
de timestamp também não cria atividade de QSO, score, multiplicador ou banda.

---

## 35. Mudança de fonte

Exemplo:

```text
20:00 DIRECT
20:02 DIRECT
20:04 DIRECT
20:06 CONTEST_RUN
20:08 CONTEST_RUN
20:10 DIRECT
```

O Analytics Engine deve preferir o histórico **canônico reconciliado**.

Se houver quebra grande por mudança de fonte:

```text
metric_status = SOURCE_TRANSITION
```

ou selecionar snapshots compatíveis quando possível.

---

## 36. Snapshot canônico

Analytics de usuário final deve, por padrão, usar:

```text
canonical snapshots
```

não todas as observações de todas as fontes misturadas.

Dados por fonte podem existir em ferramentas de diagnóstico.

---

## 37. Comparação de estações com timestamps diferentes

Rivais raramente atualizam exatamente no mesmo segundo.

Para comparar A e B:

```text
reference_time = horário analítico da consulta
```

Cada estação deve usar seu snapshot canônico mais recente aceitável.

Exibir também:

```text
age
```

para o usuário entender a assimetria.

---

## 38. Gap com estação stale

Se o rival estiver stale além do limite configurado:

```text
gap_status = STALE_RIVAL
```

O gap numérico pode ser exibido, mas não deve parecer uma medição perfeitamente sincronizada.

---

## 39. Contest total

Para `window=contest`:

Usar:

```text
primeiro snapshot útil da entry
```

como baseline.

Se a estação começou a publicar horas depois do início oficial:

> o delta representa o período observado pelo Araucaria, não necessariamente todo o contest real.

A API deve poder informar:

```text
observed_since
```

---

## 40. Last update

Para `window=last`:

```text
current snapshot
versus
canonical snapshot imediatamente anterior
```

Essa janela é útil para:

```text
Δ desde último update
```

mas não deve ser usada como rate principal quando o intervalo é muito curto.

---

## 41. Fastest Gainer

Dentro de uma janela:

```text
fastest_gainer = station com maior delta_score
```

Opcionalmente por categoria.

Não confundir com:

```text
maior score_rate
```

se os elapsed times forem diferentes.

Para comparação justa, preferir `score_rate` quando as janelas efetivas diferirem materialmente.

---

## 42. Highest QSO Rate

```text
station com maior qso_rate válido
```

Excluir ou marcar rates:

```text
VERY_PROVISIONAL
INSUFFICIENT_HISTORY
STALE
```

conforme contexto.

---

## 43. Most Active Band do contest

Pode ser calculada somando deltas por banda das estações observadas:

```text
sum(delta_qso_band)
```

Isso representa:

> atividade observada no universo de estações monitoradas.

Não representa necessariamente toda a atividade mundial do contest.

---

## 44. Gap to leader no KPI "Our Station"

Quando houver estação configurada como nossa estação:

```text
our_station_callsign
```

calcular:

```text
position
gap_to_leader
score_rate
qso_rate
rank_change
```

O callsign da estação local deve ser configuração do contest/watchlist, não hardcoded.

---

## 45. Rival Monitor

Para cada rival:

```text
callsign
rank
score
gap_to_our_station
delta_score
gain_vs_our_station
delta_qso
qso_rate
delta_mult
band_deltas
dominant_band_observed
trend
age
```

---

## 46. Quick Comparison

Comparação entre poucas estações deve usar a mesma janela e mesmas regras do Analytics Engine.

Nunca recalcular métricas de forma diferente no frontend.

O frontend recebe valores já calculados pela Internal API.

---

## 47. Score History

Gráfico deve usar snapshots históricos.

Possíveis resoluções:

```text
raw
1m
5m
15m
1h
```

Ao reduzir resolução, escolher estratégia explícita:

```text
last value in bucket
```

para score acumulado.

Não usar média de score acumulado.

---

## 48. Downsampling de contadores acumulativos

Para:

```text
score
qso_total
mult_total
```

usar:

```text
último snapshot disponível dentro do bucket
```

Exemplo bucket 5m:

```text
20:00–20:04:59
→ usar o último snapshot desse intervalo
```

---

## 49. Downsampling de rates

Para rates em gráfico, preferir recalcular a partir dos pontos downsampled ou armazenar agregados específicos.

Não calcular média simples de rates instantâneos sem necessidade.

---

## 50. Cache de analytics

O MVP pode calcular sob demanda.

Depois, resultados populares podem ser cacheados:

```text
contest + entry + window + snapshot_version
```

Exemplo:

```text
1001:CR3W:30m:991827
```

Novo snapshot invalida o cache relacionado.

---

## 51. Materialização futura

Se volume crescer, poderão existir tabelas como:

```text
analytics_windows
entry_rollups
contest_rollups
```

Mas não são obrigatórias no MVP.

Os valores devem continuar reproduzíveis a partir dos snapshots.

---

## 52. Status de uma métrica

Além do valor, métricas sensíveis podem carregar:

```text
OK
PROVISIONAL
VERY_PROVISIONAL
INSUFFICIENT_HISTORY
STALE
STALE_RIVAL
SOURCE_TRANSITION
MISSING_DATA
ANOMALY
```

Exemplo:

```json
{
  "qso_rate": 94.6,
  "qso_rate_status": "STABLE"
}
```

---

## 53. Precisão e arredondamento

Internamente:

```text
usar precisão de ponto flutuante normal para rates
```

API:

```text
1 casa decimal para QSO/h
0 ou 1 casa para Score/h conforme necessidade
```

Frontend pode formatar milhares visualmente.

Scores e contadores permanecem inteiros.

---

## 54. Timezone

Toda análise usa UTC internamente.

Conversão para horário local é responsabilidade da apresentação.

Nunca fazer cálculo de janela baseado em horário local sem timezone explícito.

---

## 55. Escopo por categoria

Analytics agregados devem aceitar:

```text
category_id
```

Exemplo:

```text
leader geral
```

pode ser diferente de:

```text
leader MULTI-OP HIGH
```

A API deve informar claramente o escopo.

---

## 56. Escopo por watchlist

Rival Monitor pode operar sobre:

```text
watchlist
```

em vez do scoreboard completo.

Isso afeta apenas o conjunto comparado, não o cálculo básico de cada estação.

---

## 57. API interna relacionada

Endpoints já previstos em `internal-api.md`:

```text
GET /api/v1/contests/{contestId}/scoreboard?window=...
GET /api/v1/contests/{contestId}/analytics/summary?window=...
GET /api/v1/contests/{contestId}/compare?callsigns=...&window=...
GET /api/v1/contests/{contestId}/rivals?window=...
GET /api/v1/contests/{contestId}/stations/{callsign}/history
GET /api/v1/contests/{contestId}/stations/{callsign}/bands
```

Todos devem usar as mesmas regras deste documento.

---

## 58. Exemplo completo — janela de 30 minutos

Snapshot histórico:

```text
CR3W
19:30:11
score 1.721.856
qso   1610
mult  239

80m 298
40m 401
20m 472
15m 305
10m 134
```

Snapshot atual:

```text
CR3W
20:00:37
score 1.763.136
qso   1647
mult  241

80m 301
40m 409
20m 488
15m 313
10m 136
```

Resultado:

```text
elapsed       30m26s
Δ Score       +41.280
Δ QSO         +37
Δ Mult        +2

80m           +3
40m           +8
20m          +16
15m           +8
10m           +2

QSO Rate      ~72,9/h
Score Rate    ~81.400/h
Dominant Band 20m
```

---

## 59. Exemplo completo — Rival Gain

Há 1 hora:

```text
ZW5B  1.700.000
CR3W  1.820.000
Gap ZW5B = -120.000
```

Agora:

```text
ZW5B  2.100.000
CR3W  2.180.000
Gap ZW5B = -80.000
```

Então:

```text
Gain vs CR3W = +40.000
```

Interpretação operacional:

```text
Ainda estamos 80 mil atrás,
mas recuperamos 40 mil na última hora.
```

---

## 60. Erros que o engine não deve cometer

Não fazer:

```text
rate = delta × fator fixo sem usar elapsed real
```

Não fazer:

```text
campo ausente = zero
```

Não afirmar:

```text
"está operando em 20m agora"
```

quando só há snapshots acumulados por banda.

Não misturar silenciosamente:

```text
score de uma fonte
band breakdown de outra
```

Não descartar automaticamente:

```text
deltas negativos
```

---

## 61. Testes obrigatórios

Fixtures devem cobrir pelo menos:

```text
janela exata
snapshot antes do alvo
snapshot fora da tolerância
rate com elapsed irregular
rate de 1 minuto
score negativo por correção
qso negativo por correção
campo null
banda ausente
empate de dominant band
estação stale
rival stale
mudança de fonte
gap positivo
gap negativo
gain positivo
gain negativo
rank change
contest total com observação iniciada tarde
```

---

## 62. Critérios de aceitação do MVP

O Analytics Engine estará validado quando:

1. reproduzir os mesmos resultados para o mesmo conjunto de snapshots;
2. usar elapsed real em todas as taxas;
3. respeitar `null` versus `0`;
4. calcular corretamente todas as janelas oficiais;
5. suportar múltiplas estações com timestamps diferentes;
6. sinalizar dados stale e histórico insuficiente;
7. calcular gap/gain de rivais de forma consistente;
8. calcular breakdown por banda sem inferir banda instantânea;
9. funcionar sobre o histórico canônico reconciliado;
10. fornecer uma única regra matemática para backend, API e frontend.

---

## 63. Decisão oficial

O Araucaria LiveScore adotará um Analytics Engine baseado em **snapshots históricos canônicos**, com janelas temporais explícitas e cálculo pelo tempo real observado.

As métricas centrais serão:

```text
ΔScore
ΔQSO
ΔMult
QSO Rate
Score Rate
Gap
Gain/Loss
Band Deltas
Dominant Band Observed
Trend
Freshness
```

As janelas oficiais do MVP serão:

```text
last / 10m / 30m / 1h / 2h / 6h / contest
```

O frontend não deverá implementar fórmulas próprias; ele consumirá os resultados calculados pelo backend conforme as regras deste documento.
