# Araucaria LiveScore

Plataforma de live scoring e analytics do **Araucaria DX Group**, com ingestão de loggers, coleta de scoreboards externos, histórico de snapshots, Rival Monitor e análise por banda.

## Documentação

A documentação técnica do projeto fica em [`docs/`](docs/).

Documentos atuais:

- [`system-architecture.md`](docs/system-architecture.md) — arquitetura geral do sistema.
- [`collector-architecture.md`](docs/collector-architecture.md) — descoberta e coleta simultânea de todos os contests ativos.
- [`database-design.md`](docs/database-design.md) — modelo de dados MySQL e histórico de snapshots.
- [`data-normalization.md`](docs/data-normalization.md) — modelo canônico e normalização de fontes.
- [`source-priority-dedup.md`](docs/source-priority-dedup.md) — prioridade, reconciliação, deduplicação e prevenção de loops.
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

## Status

Projeto em fase de especificação técnica e preparação da primeira implementação.