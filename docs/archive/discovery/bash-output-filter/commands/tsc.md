# Command: tsc / tsc --noEmit

**Match pattern:** `^(tsc|npx\s+tsc|bun\s+(?:run\s+)?typecheck)\b`
**Família:** typescript
**Tier:** 1 (validar com Fase 0; volume de output é massivo)
**Estratégia provável:** declarative (dedup repetitive hints)
**Status:** analyzed
**Estimated reduction:** **~10-25%** (medido — output é majoritariamente sinal)

---

## Saída crua representativa (claudin repo, 5 May 2026)

### Amostra 1 — `bun run typecheck` em projeto com erros (REAL: **590.700 bytes**, ~6.000 linhas)

Essa medição em si é um achado: **TS errors em projeto grande passam fácil de 500KB**.

Estrutura:

```
$ tsc --noEmit
src/QueryEngine.ts(10,3): error TS2305: Module '"src/entrypoints/agentSdkTypes.js"' has no exported member 'PermissionMode'.
src/QueryEngine.ts(11,3): error TS2305: Module '"src/entrypoints/agentSdkTypes.js"' has no exported member 'SDKCompactBoundaryMessage'.
...
src/QueryEngine.ts(726,50): error TS2550: Property 'findLastIndex' does not exist on type 'Message[]'. Do you need to change your target library? Try changing the 'lib' compiler option to 'es2023' or later.
src/QueryEngine.ts(727,15): error TS7006: Parameter 'm' implicitly has an 'any' type.
... (~6000 linhas similares)
src/utils/userAgent.ts(20,46): error TS2304: Cannot find name 'MACRO'.
```

### Amostra 2 — projeto clean

```
$ tsc --noEmit
$
```

Passthrough.

### Amostra 3 — alguns erros (típico em PR)

```
$ tsc --noEmit
src/foo.ts(42,15): error TS2322: Type 'string' is not assignable to type 'number'.
src/foo.ts(58,3): error TS2304: Cannot find name 'undefinedVariable'.

Found 2 errors in src/foo.ts.
```

---

## Sinal vs ruído

**Sinal (manter):**
- Path + linha:col (`src/foo.ts(42,15):`) — coordenada do erro
- Error code (`TS2322`) — categoria
- Mensagem principal (`Type 'string' is not assignable to type 'number'`)
- Linha final (`Found N errors in M files`) — quando aparece

**Ruído moderado:**
- Hint repetitivo `Try changing the 'lib' compiler option to 'es2023' or later` — apareceu **vezes seguidas** no output real (mesmo erro `TS2550` em arquivos diferentes)
- Hint `Did you mean 'HOOK_EVENTS'?` — útil 1ª vez, ruído em massa
- Linha do `$ tsc --noEmit` no início (echo do bun)

**Não removível:**
- Cada erro tem path único e mensagem específica → 95%+ é sinal puro

---

## Estratégia proposta

### Pipeline declarativo

```jsonc
{
  "name": "tsc",
  "matchCommand": "^(tsc|npx\\s+tsc|bun\\s+(?:run\\s+)?typecheck)\\b",
  "stripAnsi": true,
  "stripLinesMatching": [
    "^\\$\\s+tsc\\s+--noEmit\\s*$"
  ],
  "replace": [
    { "pattern": "\\. Do you need to change your target library\\? Try changing the 'lib' compiler option to 'es\\d+' or later\\.", "replacement": "." },
    { "pattern": "\\. Did you mean '\\w+'\\?", "replacement": "." }
  ]
}
```

**Saída esperada:** mesmo conteúdo do raw, mas sem o hint repetido. Reduz ~10-15%.

### Estratégia mais agressiva: agrupar por código de erro

```
[TS2305 × 8 — has no exported member]
  src/QueryEngine.ts(10,3): 'PermissionMode'
  src/QueryEngine.ts(11,3): 'SDKCompactBoundaryMessage'
  ... (6 mais)

[TS2307 × 3 — Cannot find module]
  ...

[TS2550 × 12 — Property '...' does not exist]
  ...
```

Adiciona complexidade (parser de erros), ganho potencial 30-40%. **Adiar pra v2.**

### Estratégia "first N + count"

Se output > 100 erros, mostrar os primeiros 50 + linha final `[+N more errors with codes: TS2305(8), TS2307(3), ...]`.

**Tradeoff:** modelo perde visibilidade dos outros erros. Em workflow "fix all errors" isso quebra. Mas se o user só quer começar a consertar, primeiros 50 já dão trabalho.

---

## Edge cases / NÃO filtrar quando

- [x] `is_error: true` (exit ≠ 0) — **NÃO** passthrough; tsc exit ≠ 0 = erros encontrados, e o output filtrado é exatamente o que precisa ser visto
- [x] `--watch` mode → streaming, não chega no BashTool de forma tradicional
- [x] `--listFiles`, `--listEmittedFiles` — flags diagnósticas, passthrough
- [x] `--pretty=false` ou `TS_NODE_PRETTY=false` — output já compacto
- [ ] **Output com cores** (`--pretty=true` default em TTY) — `stripAnsi` cobre
- [ ] **`Found N errors in M files.`** trailer (TS 4.x+) — preservar (sumário útil)
- [ ] **Erros multi-linha** (alguns têm chained type info de 5-10 linhas) — preservar inteiro

---

## Estimativa de redução

| Amostra | Antes (bytes) | Depois (bytes) | Redução |
|---|---|---|---|
| 0 erros | ~20 | 20 (passthrough) | 0% |
| 2 erros (típico PR) | ~250 | ~230 | ~8% |
| **6.000 erros (REAL claudin em estado quebrado)** | **590.700** | ~500.000 (Opção A) / ~400.000 (com agrupamento v2) | **~15%** / ~32% |

**ACHADO IMPORTANTE:** mesmo após filtro, output **continua massivo** (500KB). O **summarizer existente** já cobre via threshold (8KB) com head-tail genérico. Talvez para `tsc` o melhor seja deixar pro summarizer com threshold específico mais alto (50KB?) e estratégia de agrupamento por código de erro. Discutir.

---

## Open questions

- [ ] **Vale o filtro próprio?** Output massivo, mas sinal denso. Talvez melhor um "summarizer strategy" novo que sabe agrupar por código TS, em vez de filtro Bash genérico.
- [ ] Como detectar `Found N errors`? Pra mostrar preview compacto + "ver todos" via persisted output.
- [ ] **Inclui na Tier 1 mesmo com 15% de ROI?** Volume absoluto é tão alto que 15% de 500KB = 75KB salvos por turno.

---

## Comparativo com rtk

- rtk: `cmds/js/tsc_cmd.rs` — implementa filtro
- Verificar o que rtk faz especificamente — pode ter agrupamento por arquivo ou código.

---

## Findings empíricos

1. **Volume de output é o problema, não a densidade.** Cada erro é puro sinal.
2. **Hints redundantes** (`Try changing the 'lib' option`) aparecem em loop — easy win com `replace`.
3. **Recomendação inverter:** considerar adicionar `tsc` como nova **strategy do summarizer**, não como filtro Bash. O summarizer já tem boa abstração.
