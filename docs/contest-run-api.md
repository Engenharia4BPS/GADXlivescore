# Araucaria LiveScore — contest.run API Reference

> Documento de referência da integração com `contest.run`.
>
> Objetivo: registrar apenas o que já foi observado em clientes públicos e investigações do projeto, separando claramente fatos confirmados, comportamento observado e pontos ainda pendentes de teste.

---

## 1. Status da documentação

Legenda usada neste documento:

```text
CONFIRMADO  comportamento observado em código cliente público ou rota pública conhecida
OBSERVADO   evidência prática indireta, ainda não validada pelo nosso collector
INFERIDO    conclusão técnica plausível, não usar como contrato sem teste
TODO        precisa de validação real
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

---

## 3. Endpoints de leitura identificados

### 3.1. Contests próximos

**Status: CONFIRMADO**

```http
GET https://contest.run/api/contest/nearest
```

Uso:

- descobrir contests próximos/atuais;
- obter `testid`;
- alimentar o Contest Registry.

Campos usados por cliente público:

```text
testid
name
startdate
enddate
```

Exemplo conceitual:

```json
[
  {
    "testid": 40,
    "name": "General QSO Test",
    "startdate": "...",
    "enddate": "..."
  }
]
```

O exemplo acima é apenas ilustrativo; o formato exato de datas deve ser capturado numa POC real.

---

### 3.2. Contests por mês

**Status: CONFIRMADO em código cliente público**

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

Pendente:

- confirmar semântica exata do parâmetro `month`;
- confirmar se o endpoint depende do ano atual;
- verificar paginação ou limite.

---

### 3.3. Categorias de um contest

**Status: CONFIRMADO**

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

Uso no Araucaria:

- mapear categorias do contest;
- permitir filtros no scoreboard;
- auxiliar no matching entre categorias externas e o modelo canônico.

As categorias não precisam ser consultadas a cada poll de score.

---

### 3.4. Scoreboard / displayscore

**Status: CONFIRMADO**

```http
GET https://contest.run/api/displayscore/{testid}
```

Exemplo:

```http
GET https://contest.run/api/displayscore/40
```

Este é o endpoint principal para o External Collector.

Um cliente público já usa esse endpoint em polling periódico e processa a resposta como JSON.

---

## 4. Schema observado de `displayscore`

Campos identificados no modelo do cliente público:

```text
auth
ctassis
ctband
ctmode
ctopera
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

rownum
score
sign
soft
wac
waz
```

---

## 5. Mapeamento principal para o modelo canônico

```text
contest.run        Araucaria
-----------        ---------
sign            → callsign
date            → source_timestamp
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
soft            → logger
```

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

O cliente público trata `date` como:

```text
YYYY-MM-DD HH:MM:SS
```

 e o interpreta como UTC.

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

O Araucaria não deve selecionar apenas um `testid`.

Fluxo:

```text
GET /api/contest/nearest
GET /api/contest/month/{month}
        │
        ▼
identificar contests ativos
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

TODO:

- testar resposta com User-Agent simples do Araucaria.

---

## 16. Autenticação da API de leitura

**Status observado:** o cliente público consulta os endpoints GET sem credenciais explícitas.

Portanto, a hipótese atual é:

```text
read API pública
```

TODO:

- validar diretamente todos os endpoints;
- confirmar se há restrições por IP, sessão ou headers.

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

## 27. Pontos ainda pendentes de engenharia reversa / teste

```text
[ ] formato real completo de /contest/nearest
[ ] formato real completo de /contest/month/{month}
[ ] timezone oficial das datas
[ ] comportamento quando contest termina
[ ] rate limits oficiais
[ ] headers mínimos necessários
[ ] ETag / Last-Modified / cache headers
[ ] paginação, se existir
[ ] significado de todos os campos m*total
[ ] semântica completa dos campos ct*
[ ] endpoint oficial atual de POST
[ ] HTTPS versus HTTP na escrita
[ ] autenticação e credenciais de escrita
[ ] códigos de resposta de POST
```

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
