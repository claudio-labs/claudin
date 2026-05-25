# 01 — BM25 tool gating dinâmico

## O que omp faz

`packages/agent/src/tool-discovery/tool-index.ts` mantém um índice BM25 sobre nome/descrição/schema de cada tool. A cada turno, só as tools "relevantes" para o prompt corrente são anexadas ao request do modelo.

Resultado: schemas de tools que o modelo provavelmente não vai usar não pagam tokens de input.

## Por que importa para Claudio

- Hoje Claudio carrega ~25 schemas built-in em todo turno + MCP tools + skills + agents.
- `scripts/measure-tool-schemas.test.ts` já mede o custo — então a dor é conhecida.
- Maior alvo: usuários OpenAI-compatible (DeepSeek, Groq, OpenRouter, LM Studio) onde cada token de input dói mais e onde alguns modelos degradam tool-calling com schema grande demais.

## Perguntas em aberto

- BM25 é estável o suficiente para não esconder tools óbvias (ex: Bash) num turno onde elas seriam úteis?
- Como lidar com tools "always-on" (Read, Edit, TaskCreate) vs gated (WebResearcher, Skill, Schedule)?
- Conflita com prompt caching da Anthropic (que prefere prefix estável)?
- Vale por trás de feature flag `BM25_TOOL_GATING`?

## Referência

- `packages/agent/src/tool-discovery/tool-index.ts` (omp)
- `scripts/measure-tool-schemas.test.ts` (claudio)
