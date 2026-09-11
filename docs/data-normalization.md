# Araucaria LiveScore — Data Normalization

> Documento de referência para a camada de normalização do **Araucaria LiveScore**.
>
> Objetivo: transformar dados vindos de N1MM, DXLog, `contest.run`, COSB, HAMSCORE e futuras fontes em um **modelo interno único**, previsível e independente da origem.

---

## 1. Princípio central

Nenhuma fonte externa deve escrever diretamente no modelo final do banco.

Fluxo oficial:

```text
RAW PAYLOAD
    │
    ▼
SOURCE ADAPTER
    │
    ▼
PARSER
    │
    ▼
NORMALIZER
    │
    ▼
CANONICAL SNAPSHOT
    │
    ▼
DEDUP / RECONCILIATION
    │
    ▼
MYSQL
```

O restante do sistema deve trabalhar apenas com o formato canônico.

---

## 2. Objetivos da normalização

A camada deve resolver diferenças entre fontes como:

- nomes diferentes para o mesmo campo;
- formatos diferentes de data/hora;
- diferentes identificadores de contest;
- bandas representadas de formas distintas;
- categorias com nomenclaturas diferentes;
- ausência de determinados campos;
- valores agregados versus breakdown por banda;
- XML versus JSON versus HTML;
- diferenças entre `0`, `null` e campo inexistente.

---

## 3. Regra de preservação

Sempre guardar:

```text
valor normalizado
+
valor original quando relevante
+
origem
+
raw payload
```

A normalização não substitui a evidência original.

---

## 4. Objeto canônico de snapshot

Exemplo conceitual:

```json
{
  "source": {
    "source_id": 3,
    "source_code": "CONTEST_RUN",
    "external_message_id": null
  },
  "contest": {
    "internal_id": 1001,
    "external_id": "40",
    "name_raw": "CQ WW DX CW"
  },
  "station": {
    "callsign": "CR3W",
    "callsign_raw": "cr3w"
  },
  "category": {
    "operator_class": "MULTI-OP",
    "power": "HIGH",
    "assisted": "ASSISTED",
    "transmitter": "MULTI-TX",
    "band": "ALL",
    "mode": "CW",
    "overlay": null,
    "raw": {}
  },
  "station_meta": {
    "club": "ARAUCARIA DX GROUP",
    "dxcc": "CT3",
    "cq_zone": 33,
    "iaru_zone": null,
    "grid": null,
    "lat": null,
    "lon": null,
    "logger": "DXLog",
    "logger_version": null
  },
  "timestamp": {
    "source_at": "2026-09-10T22:31:00Z",
    "received_at": "2026-09-10T22:31:08Z"
  },
  "totals": {
    "score": 1732224,
    "qso": 1619,
    "points": 4872,
    "mult": 240
  },
  "bands": [
    {
      "band": "80m",
      "mode": "ALL",
      "qso": 298,
      "points": null,
      "mult1": 40,
      "mult2": null
    },
    {
      "band": "40m",
      "mode": "ALL",
      "qso": 403,
      "points": null,
      "mult1": 59,
      "mult2": null
    }
  ],
  "metrics": {},
  "raw": {
    "raw_message_id": 991827
  }
}
```

---

## 5. Campos obrigatórios mínimos

Para gerar um snapshot útil:

```text
source
contest
callsign
source_at ou received_at
```

Para aparecer no scoreboard, idealmente:

```text
score
qso_total
```

Para Rival Monitor completo:

```text
score
qso_total
mult_total
breakdown por banda
timestamp
```

---

## 6. `null` não é igual a `0`

Regra crítica:

```text
campo ausente  → null
valor zero     → 0
```

Se uma fonte não fornece QSO de 160m, usar `null`; `0` significa que a fonte afirmou explicitamente zero.

---

## 7. Callsign

Normalização:

```text
trim
uppercase
```

Preservar `callsign_raw` e não remover automaticamente sufixos como `/P`, `/M`, `/QRP`, `/MM` ou `/5`.

---

## 8. Contest

Cada fonte pode usar um identificador diferente. Todos devem ser mapeados para `contests.id` através de `contest_external_ids`.

Estrutura:

```text
contest_id
source_id
external_id
external_name
```

---

## 9. Matching de contests

Ordem sugerida:

```text
1. external_id já conhecido
2. nome normalizado + datas
3. nome + start_at + end_at + mode
4. revisão manual se ambíguo
```

Nunca criar automaticamente dois contests internos diferentes apenas porque duas fontes usam IDs distintos.

---

## 10. Datas e horários

Regra oficial:

```text
UTC em todo o backend
```

Armazenar separadamente `source_timestamp` e `received_at`.

---

## 11. Datas sem timezone

Se a fonte documentar que o horário é UTC, interpretar como UTC. Caso contrário, preservar raw e registrar a suposição de timezone; não adivinhar silenciosamente.

---

## 12. Score e contadores

Tipos internos:

```text
score        integer/bigint
qso_total    integer/bigint
points_total integer/bigint
mult_total   integer/bigint
```

Não usar floating point.

---

### 12.1. Totais e breakdown do `contest.run`

O POC read-only de 2026-09-11 observou linhas em que os totais agregados não
coincidem com a soma dos campos por banda. Portanto:

```text
qtotal / ptotal / mtotal da fonte são autoritativos
```

O normalizer nunca deve recomputar esses totais a partir de `q160...q10`,
`p160...p10` ou `m160...m10`.

Os campos por banda são observações suplementares de breakdown e devem ser
preservados como tal. Divergência entre total e breakdown não é, por si só, erro
de parsing ou motivo para alterar qualquer um dos valores.

---

## 13. Bandas

Formato canônico:

```text
160m
80m
40m
20m
15m
10m
6m
2m
70cm
23cm
...
```

Não limitar o banco apenas às bandas de HF.

---

## 14. Aliases de banda

Exemplos:

```text
160 / 1.8 / 1800 → 160m
80 / 3.5         → 80m
40 / 7           → 40m
20 / 14          → 20m
15 / 21          → 15m
10 / 28          → 10m
```

A interpretação deve considerar o contexto da fonte.

---

## 15. Modo

Valores canônicos sugeridos:

```text
CW
SSB
RTTY
DIGITAL
MIXED
ALL
```

Aliases comuns:

```text
PHONE / PH / USB / LSB → SSB
DIGI / DATA            → DIGITAL
SSB+CW                 → MIXED
```

---

## 16. Categoria

Campos normalizados:

```text
operator_class
power
assisted
transmitter
band
mode
overlay
station_type
time_category
```

Também preservar `category_raw` ou `category_json`.

No `contest.run`, o POC observou códigos numéricos junto de labels de exibição,
além de sentinelas como `-1`, strings vazias e `null`. O adapter deve preservar
essas diferenças na fronteira da fonte. Não converter sentinelas para uma
categoria canônica, `null` ou zero antes de a regra do campo ser confirmada.

---

## 17. Breakdown por banda

Modelo canônico:

```text
band
mode
qso
points
mult1
mult2
```

Não criar colunas fixas como `qso_80`, `qso_40`, `qso_20` na representação persistida principal.

---

## 18. Métricas específicas de contest

Alguns contests possuem métricas próprias como QTC, zones, countries, prefixes, HQ multipliers, states, sections e grids.

Não forçar tudo para `mult_total`. Usar `metrics JSON` ou futuramente `snapshot_metrics`.

---

## 19. `contest.run` → modelo canônico

Mapeamento observado, sujeito à validação da semântica de cada campo:

```text
sign    → callsign
date    → source_timestamp
score   → score
qtotal  → qso_total autoritativo da fonte
ptotal  → points_total autoritativo da fonte
mtotal  → mult_total autoritativo da fonte
q160... → qso por banda
p160... → points por banda
m160... → mult por banda
soft    → metadado de software bruto; observado como string e número
dxcc    → dxcc
waz     → cq_zone
itu     → iaru_zone
lat     → latitude
lon     → longitude
```

O valor de `date` observado está no formato `YYYY-MM-DD HH:MM:SS`, sem offset.
O adapter deve preservar o valor bruto e a ausência de timezone até que a
semântica temporal seja confirmada.

`qtotalc`, `qtotalp` e `qtotalr` foram observados como números, mas sua
semântica não foi confirmada. No MVP, devem permanecer métricas raw sem
mapeamento canônico.

### 19.1. Tipos externos instáveis

Schemas externos não são contratos internos. O adapter valida e normaliza tipos
na fronteira antes de produzir um `CanonicalScoreSnapshot`. O POC observou
`soft` como string e número; o adapter deve aceitar ambas as formas e preservar
o valor raw quando relevante. O mesmo princípio se aplica a campos futuros que
mudem de tipo, sejam ausentes ou usem sentinelas.

---

## 20. `dynamicresults XML` → modelo canônico

Exemplos de mapeamento:

```text
<contest>   → contest external/raw name
<call>      → callsign
<class ...> → category
<club>      → club
<soft>      → logger
<version>   → logger_version
<cqzone>    → cq_zone
<iaruzone>  → iaru_zone
<grid6>     → grid
<qso>       → qso
<point>     → points
<mult>      → multipliers
<score>     → score
<timestamp> → source_timestamp
```

---

## 21. Fonte sem breakdown

Se a fonte só informar score e QSO total, o snapshot continua válido com `bands: []`. Não inventar breakdown.

---

## 22. Fonte com breakdown parcial

Campo ausente deve permanecer ausente/null, e não ser convertido automaticamente para zero.

---

## 23. Dados derivados não são dados canônicos

Não armazenar como verdade de origem:

```text
Δ Score
Δ QSO
QSO/h
Score/h
Dominant band
Gap
Gain 1h
```

Esses valores devem ser calculados a partir de snapshots.

---

## 24. Validação de monotonicidade

Score e QSO normalmente crescem, mas o sistema não deve rejeitar automaticamente reduções. Guardar o snapshot e, se desejado, marcar `anomaly = true`.

---

## 25. Pipeline de normalização

```text
parse
  │
  ▼
validate syntax
  │
  ▼
normalize identifiers
  │
  ▼
normalize timestamps
  │
  ▼
normalize category
  │
  ▼
normalize totals
  │
  ▼
normalize band breakdown
  │
  ▼
attach provenance
  │
  ▼
canonical snapshot
```

---

## 26. Resultado esperado

Todos estes:

```text
contest.run JSON
COSB XML
COSB HTML
HAMSCORE
N1MM XML
DXLog XML
```

devem terminar em `CanonicalScoreSnapshot`.

---

## 27. Interface conceitual

```text
normalize(rawPayload, source, contestContext)
    → CanonicalScoreSnapshot[]
```

Uma resposta externa pode produzir vários snapshots, um por estação.

---

## 28. Testes obrigatórios

Criar fixtures para:

```text
contest.run normal
dynamicresults normal
campos ausentes
zero explícito
timestamp inválido
callsign lowercase
categoria desconhecida
banda desconhecida
score reduzindo
payload duplicado
```

---

## 29. Critério de sucesso

A normalização estará correta quando o restante do sistema puder processar dados sem perguntar de qual fonte vieram. A origem permanece disponível como metadado, mas não altera o modelo funcional.

---

## 30. Decisão oficial

O Araucaria LiveScore adotará um **modelo canônico interno único**, preservando raw payload e provenance.

Regras essenciais:

1. `null` é diferente de `0`;
2. UTC no backend;
3. score e contadores são inteiros;
4. breakdown de bandas é normalizado em linhas;
5. categorias possuem campos comuns + representação raw;
6. dados derivados são calculados, não tratados como verdade de origem;
7. nenhuma fonte externa escreve diretamente no banco final.
