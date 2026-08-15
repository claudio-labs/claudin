# 03 — Prompts em `.md` via text-import

## O que omp faz

```ts
import explorePrompt from "./explore.md" with { type: "text" };
```

Em `packages/agent/src/task/agents.ts:9-19`. Bundler resolve `.md` como string em build-time. Bun e esbuild suportam nativamente.

Vantagens observadas:
- Diff de prompt vira diff de texto puro, sem `\n` e `'` escapados
- Editor render markdown com syntax highlight
- Sem fs-read em runtime
- AGENTS.md deles explicitamente proíbe prompts inline

## Como Claudin faz hoje

Mistura:
- `src/tools/*/prompt.ts` exportando string literal
- Prompts coordenador inline em `src/agent/coordinator/`
- System prompts montados via template TS em vários lugares

Build system já tem stub para `.md`/`.txt` imports (`scripts/build.ts`) — mas atualmente eles viram stub. Bastaria deixar passar via `loader: { '.md': 'text' }`.

## Perguntas em aberto

- Quais prompts são "produção" vs experimentais? Migrar todos ou um diretório-piloto (`src/prompts/`)?
- Como manter feature-flag gating (`feature('X')`) sobre conteúdo de prompt?
- Hot-reload em dev?
- Como testar prompts (snapshot diff?)

## Referência

- `packages/agent/src/task/agents.ts:9-19` (omp)
- `scripts/build.ts` (claudin) — onde adicionar loader
