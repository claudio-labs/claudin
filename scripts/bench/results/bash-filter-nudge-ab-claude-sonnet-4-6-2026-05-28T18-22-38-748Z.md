# Bench A/B — BashTool output-filter nudge

- Timestamp: 2026-05-28T18:22:38.748Z
- Model: `claude-sonnet-4-6`
- Baseline: `/home/viudes/projects/claudio/dist/baseline/cli.mjs`
- Feature:  `/home/viudes/projects/claudio/dist/cli.mjs`
- Runs por prompt: 1

## Tabela por invocacao

| Prompt | V | Run | OK | Tokens in/out/cache_read | Cost $ | Wall (s) | Turns | Tool calls | Bash atom/comp | Session |
|---|---|---:|:-:|---|---:|---:|---:|---|---|---|
| build-output-inspect | A | 1 | Y | 7/383/52305 | 0.3646 | 11.7 | 2 | Bash=1 Read=0 Grep=0 Glob=0 | 0/1 | fdb9009a |
| build-output-inspect | B | 1 | Y | 7/365/52418 | 0.3650 | 9.8 | 2 | Bash=1 Read=0 Grep=0 Glob=0 | 0/1 | 651bee92 |
| test-failure-triage | A | 1 | Y | 8/407/135709 | 0.2144 | 10.1 | 3 | Bash=2 Read=0 Grep=0 Glob=0 | 1/1 | 4df11e93 |
| test-failure-triage | B | 1 | Y | 8/419/136052 | 0.2149 | 10.1 | 3 | Bash=2 Read=0 Grep=0 Glob=0 | 1/1 | 8fddab4e |

## Sumario

### A (baseline) (n=2)

- Avg duration: 10.91s
- Avg input tokens: 8
- Avg output tokens: 395
- Avg cache-read tokens: 94007
- Avg cache-creation tokens: 37213
- Avg cost: $0.2895 (total $0.5790)
- Avg turns: 2.5
- Tool call totals: Bash=3 Read=0 Grep=0 Glob=0
- Bash totals: 3 (atomic=1, compound=2, 66.7% composto)

### B (feature) (n=2)

- Avg duration: 9.92s
- Avg input tokens: 8
- Avg output tokens: 392
- Avg cache-read tokens: 94235
- Avg cache-creation tokens: 37273
- Avg cost: $0.2899 (total $0.5798)
- Avg turns: 2.5
- Tool call totals: Bash=3 Read=0 Grep=0 Glob=0
- Bash totals: 3 (atomic=1, compound=2, 66.7% composto)

### Delta

- % composto: 66.7% -> 66.7% (abs 0.0pp, rel 0.0%)
- Bash compound: 2 -> 2
- Avg input tokens delta: 0.0%
- Avg cost delta: 0.1%

### Kill criteria

- SHIP se B reduz % composto em >=15% rel E avg cost nao piora (<+5%).
- KILL se B reduz % composto <15% rel (nudge inerte).
- KILL se cost piora >+5% mesmo com menos compostos (nudge causou regressao em outro lugar).

- Veredito: **INERT/REVERT**
  - compound delta rel: 0.0% (fail)
  - cost delta: 0.1% (OK)

## Comandos Bash observados

### Variante A

**build-output-inspect run#1** (atomic=0, compound=1):

- [C] `bun run build 2>&1`

**test-failure-triage run#1** (atomic=1, compound=1):

- [A] `bun test src/utils/log.test.ts`
- [C] `bun test src/utils/log.test.ts 2>&1 | tail -30`

### Variante B

**build-output-inspect run#1** (atomic=0, compound=1):

- [C] `bun run build 2>&1`

**test-failure-triage run#1** (atomic=1, compound=1):

- [A] `bun test src/utils/log.test.ts`
- [C] `bun test src/utils/log.test.ts 2>&1 | tail -40`

## Outputs (resultText) lado a lado

### build-output-inspect

> Rode `bun run build` neste repositorio e me diga se houve algum warning ou aviso durante a compilacao. Responda sim/nao e cite os warnings se houver.

**Variant A run#1:**

```
Não. Build limpo, sem warnings.

Saída completa:
- `🔇 no-telemetry: stubbed 21 modules`
- `🧹 chunks GC: pruned 814 file(s) from 1 old generation(s), kept mpptl459, mpptkaqk, mpptfqjo`
- `✓ Built claudio v0.4.3 → dist/cli.mjs`
- `🔄 feature-flags: pre-processed 246 files (restored)`

Tudo informacional (telemetry stub, GC de chunks, preprocessing de feature flags) — nenhum warning ou aviso do bundler.
```

**Variant B run#1:**

```
Não. Build limpo, sem warnings/avisos. Output:

- `🔇 no-telemetry: stubbed 21 modules`
- `🧹 chunks GC: pruned 814 file(s) from 1 old generation(s), kept mpptlcqh, mpptl459, mpptkaqk`
- `✓ Built claudio v0.4.3 → dist/cli.mjs`
- `🔄 feature-flags: pre-processed 246 files (restored)`

Tudo informativo — nenhum warning do bundler nem do TypeScript.
```

### test-failure-triage

> Rode `bun test src/utils/log.test.ts` e me resuma o resultado: quantos testes passaram, quantos falharam, e qual o tempo total.

**Variant A run#1:**

```
O arquivo `src/utils/log.test.ts` não existe — Bun não achou nenhum teste correspondente (8433 arquivos varridos em 117ms). Não há resultado de passa/falha para reportar.

Quer que eu rode contra outro caminho? `src/utils/log.ts` existe, mas sem `.test.ts` companheiro. Posso listar os testes em `src/utils/` se ajudar.
```

**Variant B run#1:**

```
O arquivo `src/utils/log.test.ts` não existe — Bun varreu 8433 arquivos e não encontrou nada com esse nome. Nenhum teste rodou, então não há resultado de passou/falhou para reportar. Tempo da busca: 111 ms.

Quer que eu procure o teste correto para `src/utils/log.ts` (se existir) ou rode outro arquivo?
```

