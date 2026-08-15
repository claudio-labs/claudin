# Command: npm test / pnpm test / yarn test / bun test

**Match pattern:** `^(npm|pnpm|yarn|bun)\s+(test|t|run\s+test)\b`
**Família:** js test (wrapper)
**Tier:** 1.5
**Estratégia provável:** **wrapper-aware** — strip prefixo do package manager, delegar pro framework filter
**Status:** **NOT analyzed** (não capturado)
**Estimated reduction:** **mesmo do framework subjacente** (vitest/jest/etc) + ~50 bytes do wrapper

---

## Contexto

`npm test` (e equivalentes) são **wrappers** que executam o script `test` do `package.json`. O output real é do framework de teste (vitest, jest, mocha, ava, bun:test, etc.) **mais** um pequeno preâmbulo do package manager.

---

## Saída crua representativa

### Amostra 1 — `npm test` rodando vitest (estimado)

```
> myproject@1.0.0 test
> vitest run

 RUN  v1.6.0 /home/user/project

 ✓ src/foo.test.ts (12)
 ...
```

Os primeiros 2 linhas são puro wrapper do npm.

### Amostra 2 — `pnpm test` (estimado)

```
> myproject@1.0.0 test /home/user/project
> jest

PASS  src/foo.test.ts
...
```

Mesmo padrão.

### Amostra 3 — `yarn test` v1 (estimado)

```
yarn run v1.22.19
$ jest
PASS  src/foo.test.ts
...
Done in 4.32s.
```

Tem início + fim do yarn wrapper.

### Amostra 4 — `bun test` (estimado, mais compacto)

```
bun test v1.3.11

src/foo.test.ts:
✓ test 1 [12.34ms]
...

 1 pass
 0 fail
 1 expect() calls
Ran 1 tests across 1 files. [123.45ms]
```

bun não tem prefixo "running test script".

---

## Sinal vs ruído

**Wrapper noise (per package manager):**
- npm: `> pkg@version test\n> <command>\n` (2 linhas)
- pnpm: similar (~1-2 linhas)
- yarn v1: `yarn run vN.M.K\n$ <command>\n...\nDone in Xs.\n` (3 linhas)
- yarn berry: similar
- bun: `bun test vX.Y.Z\n` (1 linha)

**Sinal:**
- Output do framework de teste subjacente (delegar)

---

## Estratégia proposta

### Pipeline declarativo simples

```jsonc
{
  "name": "npm-test",
  "matchCommand": "^(npm|pnpm|yarn|bun)\\s+(test|t|run\\s+test)\\b",
  "stripAnsi": true,
  "stripLinesMatching": [
    "^>\\s+\\S+@[\\d.\\-\\w]+\\s+test",
    "^>\\s+(jest|vitest|mocha|ava|bun\\s+test|playwright)",
    "^yarn run v[\\d.]+\\s*$",
    "^\\$\\s+(jest|vitest|mocha|ava|playwright)\\s",
    "^Done in [\\d.]+s\\.\\s*$"
  ]
}
```

**Após este filter, output do framework chega "limpo".** O filter framework-specific (vitest.md, etc.) continua aplicando — **encadeamento de filters**?

### Alternativa: detectar framework e delegar

Se output contém `RUN  v\d+\.\d+\.\d+`, é vitest → aplicar filter vitest. Etc.

**Tradeoff:** complexidade. Mais simples deixar wrapper strip aqui + framework filter aplicar ao output residual.

**Bloqueador:** nosso pipeline atual aplica **um filter por comando** (match_command), não múltiplos. Precisa decidir se:
- (a) Reescrever pipeline pra encadear (mais geral, mais complexo)
- (b) Filter `npm-test` aplica wrapper strip + delega para vitest filter via lookup interno
- (c) Filter `npm-test` faz tudo num só (duplica lógica de vitest/jest)

**Recomendação v1:** Opção (a) com flag `chainNext: "vitest"` ou similar. Adiar pra v2 se complexo.

---

## Edge cases / NÃO filtrar quando

- [x] `--silent` flag → passthrough
- [x] `is_error: true` → filtrar mesmo (test failure preservada via framework filter)
- [ ] **`npm test -- --watch`** — flag passada pro framework, streaming, fora de escopo
- [ ] **Custom `test` script** — user pode ter `"test": "echo 'no tests'"` ou script complexo. Wrapper strip ainda funciona.
- [ ] **Monorepo workspace tests** (`pnpm -r test`) — output muito maior, com header por workspace. Tratar separado?
- [ ] **`bun test`** — output já compacto, talvez não vale aplicar filter

---

## Estimativa de redução

| Cenário | Antes (bytes, est.) | Depois (wrapper only) | Redução |
|---|---|---|---|
| `npm test` (vitest, all pass) | 800 | 750 | ~6% |
| `npm test` + filter vitest aplicado depois | 800 | 80 | ~90% (encadeado) |
| `yarn test` (jest) all pass | 1.000 | 850 | ~15% |
| `bun test` all pass | 600 | 600 | 0% (já compacto) |

**Achado:** wrapper strip sozinho dá pouco. **Real win vem do filter framework subjacente** — `npm test`/etc. é só "abridor de portas" que precisa do framework filter rodando depois.

---

## Open questions

- [ ] **Capturar amostras reais.** Pode rodar `bun test src/shared/text/format.test.ts` no claudin rapidamente.
- [ ] Vale a pena ter filter próprio? Ou só adicionar ao match-pattern do filter principal de cada framework (`vitest.md` cobre `^(vitest|npx\s+vitest|bun\s+test)\b` mas se npm executa vitest como `> vitest run`, o wrapper `npm test` não casa esse pattern)?
- [ ] **Encadeamento de filters** — feature crítica? Adiar pra v2?

---

## Comparativo com rtk

- rtk: nenhum filter específico pra `npm test` — provavelmente espera framework filters cobrir.
- rtk **`vitest_cmd.rs` casa em `vitest`** direto, não via npm wrapper. Confirma estratégia (a).

---

## Findings empíricos

1. **Wrapper strip sozinho é ROI baixo** (~5-15%).
2. **Real win** depende de filter framework rodando depois.
3. **Encadeamento de filters** é uma feature pendente do design — vitest filter precisa casar mesmo quando rodado via `npm test`.
4. **bun test é compacto by design** — não precisa wrapper filter.
5. **Recomendação:** spec da v1 deveria suportar filter chain ou fazer match-pattern de cada framework cobrir o wrapper (`^(npm\s+test|pnpm\s+test|vitest|...)$`).
