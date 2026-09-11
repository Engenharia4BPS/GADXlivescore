# Araucaria LiveScore

Plataforma de live scoring e analytics do **Araucaria DX Group**, com ingestão de loggers, coleta de scoreboards externos, histórico de snapshots, Rival Monitor e análise por banda.

## Documentação

A documentação técnica do projeto fica em [`docs/`](docs/).

Documentos atuais:

- [`system-architecture.md`](docs/system-architecture.md) — arquitetura geral do sistema.
- [`collector-architecture.md`](docs/collector-architecture.md) — descoberta e coleta simultânea de todos os contests ativos.
- [`contest-run-api.md`](docs/contest-run-api.md) — endpoints, schema e integração com `contest.run`.
- [`data-normalization.md`](docs/data-normalization.md) — modelo canônico e normalização de fontes.
- [`source-priority-dedup.md`](docs/source-priority-dedup.md) — prioridade, reconciliação, deduplicação e prevenção de loops.
- [`internal-api.md`](docs/internal-api.md) — contrato da API consumida pelo frontend.
- [`analytics-engine.md`](docs/analytics-engine.md) — regras de deltas, rates, janelas e Rival Monitor.
- [`deployment.md`](docs/deployment.md) — implantação, operação, logs, backup, health checks e rollback.
- [`security.md`](docs/security.md) — autenticação, validação, rate limiting, segredos e hardening.
- [`test-plan.md`](docs/test-plan.md) — plano de testes unitários, integração, E2E, resiliência e segurança.
- [`database-design.md`](docs/database-design.md) — modelo de dados MySQL e histórico de snapshots.
- [`external-integration-findings.md`](docs/external-integration-findings.md) — descobertas sobre contest.run, COSB e outras fontes.
- [`contest-run-collection-simulation.md`](docs/contest-run-collection-simulation.md) — POC simulada do collector do contest.run.
- [`layout-claro.md`](docs/layout-claro.md) — referência funcional e visual do dashboard em tema claro.

## Decisões já estabelecidas

- MySQL como banco principal.
- Histórico de score append-only.
- Coleta de **todos os contests ativos simultaneamente**, independente do contest aberto no frontend.
- Normalização de múltiplas fontes para um modelo interno único.
- Prioridade inicial: `DIRECT LOGGER > FEDERATION > EXTERNAL SERVER > MANUAL`.
- `contest.run` como primeira fonte externa estruturada para a POC.
- Backend como única camada de acesso do frontend aos dados externos.
- API interna versionada em `/api/v1`.
- Analytics calculado sobre snapshots históricos usando tempo real decorrido.
- Segurança em camadas para ingestão, collectors, API e outbound.

## Status

Projeto em fase de especificação técnica e preparação da primeira implementação.