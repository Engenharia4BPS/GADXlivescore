# Araucaria LiveScore — Security

> Documento de referência para segurança do **Araucaria LiveScore**.
>
> Este documento cobre ingestão pública, credenciais, autenticação, rate limiting, validação de payload, proteção de dados, logging, dependências e resposta a incidentes.

---

## 1. Objetivo

Proteger:

- ingestão enviada por N1MM/DXLog;
- API pública de leitura;
- endpoints administrativos;
- credenciais de fontes externas;
- banco MySQL;
- WebSocket;
- pipeline de outbound/federation;
- histórico e raw payloads.

O sistema deve ser seguro por padrão sem tornar impossível a compatibilidade com loggers legados.

---

## 2. Superfícies de ataque

Principais superfícies:

```text
/livescore/                  frontend público
/livescore/api/v1/*          API pública
/livescore/ws                WebSocket
/livescore/ingest/*          ingestão de logger
/admin/*                     administração
MySQL                        persistência
external collectors          conexões outbound
outbound forwarding          POSTs para terceiros
```

---

## 3. Princípio de menor privilégio

Cada componente deve ter somente as permissões necessárias.

Exemplo:

```text
frontend → somente API pública
collector → leitura externa + escrita no banco via backend/repository
admin → rotas protegidas
DB user da aplicação → sem permissões administrativas globais
```

---

## 4. HTTPS obrigatório

Produção deve usar HTTPS.

Regras:

- redirecionar HTTP para HTTPS nas interfaces próprias;
- usar `wss://` para WebSocket público;
- nunca expor credenciais em tráfego sem TLS;
- validar certificados em chamadas externas HTTPS.

Exceção: alguma fonte legada pode publicar apenas HTTP. Isso deve ser tratado como risco conhecido e isolado no adapter.

---

## 5. Ingestão de loggers

A ingestão direta é uma superfície sensível porque aceita dados enviados da Internet.

Endpoint conceitual:

```text
POST /livescore/ingest/score
```

O backend deve:

1. limitar tamanho;
2. validar Content-Type;
3. autenticar quando possível;
4. validar XML/JSON;
5. armazenar raw payload com segurança;
6. não executar conteúdo recebido;
7. aplicar rate limiting;
8. responder sem revelar detalhes internos.

---

## 6. Autenticação da ingestão

Preferência:

```text
API key/token por estação ou integração
```

Porém N1MM/DXLog podem impor limitações sobre headers customizados.

Por isso devem ser suportados, conforme compatibilidade comprovada:

```text
Authorization header
Basic Auth
path token
query token
```

Ordem de preferência:

```text
header > Basic Auth > path token > query token
```

Query tokens são menos desejáveis porque podem aparecer em logs e históricos.

---

## 7. Credenciais por estação

Evitar uma única senha global.

Modelo recomendado:

```text
ingest_credentials
- id
- callsign/entry
- token_hash
- enabled
- created_at
- last_used_at
```

Tokens devem ser armazenados em hash quando não houver necessidade de recuperar o segredo original.

---

## 8. Rotação e revogação

Deve ser possível:

```text
revogar token sem deploy
emitir novo token
ter período curto de sobreposição se necessário
```

Credenciais comprometidas não devem exigir alteração de código.

---

## 9. Segredos

Nunca versionar:

```text
DB password
API keys
Basic Auth passwords
outbound credentials
session secrets
```

Usar:

```text
environment variables
ou secret manager futuro
```

O repositório deve conter apenas `.env.example` sem valores reais.

---

## 10. Logging de segredos

Sanitizar:

```text
Authorization
Cookie
Set-Cookie
password
passwd
token
api_key
secret
```

URLs com query token devem ser mascaradas antes do log.

---

## 11. Limite de payload

Definir limite de corpo para ingestão.

Valor inicial sugerido:

```text
256 KiB
```

Ajustar após observar payloads reais.

Requisições acima do limite:

```text
HTTP 413 Payload Too Large
```

---

## 12. XML seguro

Ao processar `dynamicresults XML`:

- desabilitar external entities;
- desabilitar DTD quando possível;
- impedir XXE;
- limitar profundidade/tamanho;
- usar parser mantido e seguro.

Nunca utilizar parser XML com resolução externa habilitada para payload não confiável.

---

## 13. JSON/HTML externo

Collectors tratam conteúdo remoto como não confiável.

Regras:

- validar schema/tipos;
- impor timeout;
- limitar tamanho de resposta;
- não executar HTML/JavaScript;
- sanitizar strings antes de exibir;
- rejeitar valores estruturalmente inválidos.

---

## 14. SQL injection

Todo acesso ao MySQL deve usar:

```text
prepared statements
parameterized queries
ORM/query builder seguro
```

Nunca concatenar diretamente callsign, contest, filtros ou parâmetros HTTP em SQL.

---

## 15. XSS

Dados vindos de callsigns, nomes de contests, clubs e fontes externas devem ser tratados como texto.

Frontend:

- escape padrão do framework;
- evitar `dangerouslySetInnerHTML`;
- sanitizar qualquer HTML explicitamente permitido.

O sistema não precisa aceitar HTML vindo das fontes de score.

---

## 16. CORS

Se frontend e API estiverem no mesmo domínio/path, preferir same-origin.

Não configurar:

```text
Access-Control-Allow-Origin: *
```

para endpoints autenticados sem necessidade.

---

## 17. CSRF

APIs públicas somente GET têm risco reduzido.

Quando houver sessões/cookies e endpoints mutáveis administrativos:

- SameSite cookies;
- CSRF token quando aplicável;
- preferir Authorization bearer para APIs programáticas.

---

## 18. Rate limiting

Aplicar políticas diferentes por rota.

Exemplo inicial:

```text
API pública GET      → limite por IP
WebSocket connect    → limite por IP
Ingest               → limite por credential + IP
Admin                → limite mais restritivo
```

Não usar limites tão agressivos que prejudiquem loggers legítimos.

---

## 19. Proteção contra abuso da ingestão

Monitorar:

```text
payloads inválidos
falhas de autenticação
callsign incompatível com credential
frequência excessiva
score impossível/estranho
origem IP incomum
```

Anomalia não deve necessariamente apagar o dado; pode ser rejeitada ou marcada conforme natureza.

---

## 20. Vincular credential ao callsign

Quando possível:

```text
credential PY5XT
```

não deve publicar arbitrariamente:

```text
CR3W
```

sem permissão explícita.

Para operações multi-op e clubes, permitir scopes configuráveis.

---

## 21. Modelo de scopes futuro

Exemplo:

```text
score:write:self
score:write:station
admin:collector
admin:contest
admin:credentials
```

Não é obrigatório no primeiro POC, mas o modelo deve permitir evolução.

---

## 22. API pública

Rotas de leaderboard e analytics podem ser públicas.

Devem expor apenas dados necessários ao produto.

Não retornar:

```text
credenciais
raw Authorization
DB IDs sensíveis sem necessidade
stack traces
config interna
filesystem paths
```

---

## 23. Endpoints administrativos

Rotas administrativas devem exigir autenticação forte.

Exemplos:

```text
/api/v1/admin/health/collectors
/api/v1/admin/credentials
/api/v1/admin/sources
```

No MVP, se não houver UI administrativa, podem ficar inacessíveis publicamente e disponíveis apenas em rede local/VPN.

---

## 24. WebSocket

Regras:

- validar Origin quando aplicável;
- limitar conexões por IP;
- não confiar em mensagens do cliente;
- no MVP, preferir socket majoritariamente server→client;
- heartbeat/ping-pong;
- desconectar clientes abusivos.

---

## 25. MySQL

Recomendado:

```text
DB não exposto publicamente
bind/rede privada
usuário dedicado da aplicação
senha forte
backup protegido
TLS se DB remoto fora de rede confiável
```

O usuário da aplicação não deve ter `GRANT OPTION` ou privilégios globais desnecessários.

---

## 26. Raw messages

Raw payloads podem conter informações não previstas.

Regras:

- acesso administrativo;
- não renderizar diretamente como HTML;
- não expor em API pública;
- política de retenção;
- criptografia de disco/backup conforme infraestrutura disponível.

---

## 27. Source priority e spoofing

Um atacante não deve conseguir publicar um score falso com prioridade `DIRECT LOGGER` apenas adicionando um campo ao payload.

A classificação da fonte deve ser determinada pelo backend a partir de:

```text
endpoint
credential
adapter
configuração interna
```

Nunca confiar em `source=direct` informado pelo cliente.

---

## 28. Deduplicação como segurança operacional

Dedup impede amplificação involuntária, mas não substitui autenticação.

Fingerprint e payload hash não devem ser tratados como prova de identidade.

---

## 29. Outbound/federation

Regra crítica:

```text
external observations não são retransmitidas por padrão
```

Somente dados autorizados como originários podem ser enviados para terceiros.

Isso reduz:

- loops;
- spoofing;
- amplificação;
- publicação indevida.

---

## 30. SSRF

URLs das fontes externas devem vir de configuração controlada, não diretamente de parâmetros do usuário.

Não permitir endpoint público como:

```text
/api/fetch?url=http://...
```

Collectors usam allowlist de hosts/URLs configurados.

---

## 31. Timeouts de rede

Toda chamada externa deve ter timeout.

Exemplo inicial:

```text
20 segundos
```

Além disso:

- limite de redirects;
- limite de tamanho;
- backoff;
- circuit breaker quando necessário.

---

## 32. DNS e redirects

Não seguir redirects ilimitadamente.

Quando uma fonte conhecida mudar de host, revisar explicitamente.

Evitar que redirect inesperado leve o collector a rede interna.

---

## 33. Dependências

Manter:

```text
lockfile
Dependabot/Renovate opcional
npm audit/scan no CI
```

Atualizações críticas de segurança devem ter prioridade.

---

## 34. Headers de segurança

No frontend/reverse proxy considerar:

```text
Content-Security-Policy
X-Content-Type-Options: nosniff
Referrer-Policy
Strict-Transport-Security
frame-ancestors via CSP
```

Configuração deve respeitar embeds legítimos se houver.

---

## 35. Erros

Resposta pública não deve conter stack trace.

Exemplo:

```json
{
  "error": {
    "code": "INVALID_PAYLOAD",
    "message": "Payload inválido"
  }
}
```

Detalhe técnico fica no log interno correlacionado por request ID.

---

## 36. Request IDs

Gerar identificador por request/job.

Usar para correlacionar:

```text
HTTP request
raw message
snapshot
error log
outbound delivery
```

---

## 37. Backups

Backups devem ser protegidos como o banco de produção.

Não deixar dumps SQL acessíveis dentro do web root.

Verificar:

```text
permissions
encryption/storage
retention
delete policy
restore procedure
```

---

## 38. Acesso ao servidor

Boas práticas:

- SSH por chave;
- desabilitar senha quando viável;
- mínimo de usuários administrativos;
- firewall;
- sistema atualizado;
- serviços desnecessários fechados.

---

## 39. Auditoria administrativa

Ações futuras de administração devem registrar:

```text
quem
quando
o que mudou
valor anterior quando apropriado
request_id
```

Exemplos:

```text
credential revoked
source disabled
contest mapping edited
manual snapshot inserted
```

---

## 40. Privacy

O projeto trabalha principalmente com dados públicos de competição.

Mesmo assim, não coletar ou expor dados pessoais desnecessários.

Preservar apenas metadados necessários ao live score e à operação técnica.

---

## 41. Threat scenarios mínimos

Testar explicitamente:

```text
XML com XXE
payload gigante
JSON malformado
SQL injection em callsign/filtros
XSS em club/name
credential inválida
brute force de ingest
WebSocket flood
fonte externa retornando HTML inesperado
redirect malicioso
replay do mesmo payload
spoof de source priority
```

---

## 42. Resposta a incidente

Runbook mínimo:

```text
1. identificar componente
2. preservar logs
3. desabilitar source/credential via feature flag/config
4. bloquear origem abusiva se necessário
5. revogar segredo comprometido
6. avaliar dados inseridos
7. restaurar/corrigir
8. documentar causa e prevenção
```

---

## 43. Security checklist de release

Antes da produção:

1. HTTPS ativo;
2. segredos fora do Git;
3. XML parser seguro;
4. body limit configurado;
5. rate limiting configurado;
6. SQL parametrizado;
7. stack traces ocultos;
8. admin protegido;
9. DB não público;
10. logs sanitizados;
11. outbound loop protection ativo;
12. backup protegido;
13. dependency scan sem vulnerabilidade crítica conhecida.

---

## 44. Decisão oficial

O Araucaria LiveScore adota segurança em camadas:

```text
TLS
  +
authentication
  +
input validation
  +
rate limiting
  +
source provenance
  +
least privilege
  +
secure persistence
  +
observability
```

A compatibilidade com loggers nunca deve ser usada como justificativa para confiar cegamente em payloads recebidos da Internet.