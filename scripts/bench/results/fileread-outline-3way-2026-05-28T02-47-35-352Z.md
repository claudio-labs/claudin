# Bench T6.6 — FileReadTool leitura cirurgica (3-way)

- Timestamp: 2026-05-28T02:47:35.353Z
- Model: `claude-sonnet-4-6`
- Target cwd: `/home/dev/projects/openclaude`
- Runs por prompt: 1
- Variant A (baseline): `/home/dev/projects/claudio/dist/baseline-a/cli.mjs`
- Variant B (description-only): `/home/dev/projects/claudio/dist/feature-b/cli.mjs`
- Variant C (auto-outline): `/home/dev/projects/claudio/dist/feature-c/cli.mjs`

## Tabela por invocacao

| Prompt | V | Run | OK | input+cache | cost $ | wall s | turns | tools | read modes | LSP ops | session |
|---|---|---:|:-:|---:|---:|---:|---:|---|---|---|---|
| outline-first | A | 1 | N | 0 | 0.0000 | 0.0 | 0 | Grep=0 LSP=0 Read=0 Glob=0 | outline=0 symbol=0 range=0 full=0 view-full=0 | - |  |
| outline-first | B | 1 | N | 0 | 0.0000 | 0.0 | 0 | Grep=0 LSP=0 Read=0 Glob=0 | outline=0 symbol=0 range=0 full=0 view-full=0 | - |  |
| outline-first | C | 1 | N | 0 | 0.0000 | 0.0 | 0 | Grep=0 LSP=0 Read=0 Glob=0 | outline=0 symbol=0 range=0 full=0 view-full=0 | - |  |

## Sumario por variante

### A (baseline)

Sem runs validas.

### B (description-only)

Sem runs validas.

### C (auto-outline)

Sem runs validas.

## Outputs (resultText) lado a lado

### outline-first

> No arquivo `src/services/messages/messages.ts` (codebase openclaude), liste todas as funcoes exportadas (`export function` e `export async function`) com seu nome e linha de declaracao. Nao preciso do corpo das funcoes.

