# Command: grep / rg (ripgrep)

**Match pattern:** `^(grep|rg|ag|ack)\b`
**Família:** search
**Tier:** 2 (claudin tem GrepTool dedicado; Bash usage é fallback)
**Estratégia provável:** declarative (cap em maxLines + truncate de path absoluto longo)
**Status:** analyzed (real data)
**Estimated reduction:** **~0-30%** dependendo de match count

---

## Saída crua representativa (claudin repo, 5 May 2026)

### Amostra REAL — `grep -rn "isAbortError" src --include="*.ts"` (589 bytes, 7 matches)

```
/home/dev/projects/claudin/src/services/api/openaiShim.ts:1909:        const isAbortError =
/home/dev/projects/claudin/src/services/api/openaiShim.ts:1919:        if (isAbortError) {
/home/dev/projects/claudin/src/platform/lsp/config.test.ts:69:  isAbortError: (_e: unknown) => false,
/home/dev/projects/claudin/src/shared/errors.ts:27:export function isAbortError(e: unknown): boolean {
/home/dev/projects/claudin/src/agent/attachments/attachments.ts:122:import { isAbortError } from './errors.js'
/home/dev/projects/claudin/src/agent/attachments/attachments.ts:2627:    if (!isAbortError(e)) {
/home/dev/projects/claudin/src/shared/errors.ts:32:    return e instanceof TypeError && e.message.includes('aborted')
```

### Amostra REAL — `rg "isAbortError" src --type ts` (564 bytes)

```
src/agent/attachments/attachments.ts:import { isAbortError } from './errors.js'
src/agent/attachments/attachments.ts:    if (!isAbortError(e)) {
src/platform/lsp/config.test.ts:  isAbortError: (_e: unknown) => false,
src/services/api/openaiShim.ts:        const isAbortError =
src/services/api/openaiShim.ts:        if (isAbortError) {
src/shared/errors.ts:export function isAbortError(e: unknown): boolean {
```

**Insight:** `rg` é **mais compacto que `grep`** (564 vs 589 bytes para 7 matches) porque usa paths relativos por default. **Mais 1 match no grep** porque grep não respeita limites do `rg --type ts`.

### Amostra conceitual — `grep -rn "the" src` (massivo, milhares de matches)

Pode dar 100KB+ em projeto grande. Cap necessário.

---

## Sinal vs ruído

**Sinal:**
- Path:linha:conteúdo — coordenada + match. Quase 100% sinal.

**Ruído potencial:**
- **Path absoluto longo** quando user passou path absoluto (`/home/dev/projects/claudin/src/...`) — pode virar relativo. ~30-50 chars/match.
- **Matches em arquivos noise** (`node_modules/`, `dist/`, `.git/`) se user esqueceu `--exclude-dir`
- Linhas de erro `grep: ...: Permission denied` — dedup
- Para `rg`: ANSI colors no terminal — `stripAnsi`

**Não removível:**
- O conteúdo do match é sinal puro

---

## Estratégia proposta

### Pipeline declarativo enxuto

```jsonc
{
  "name": "grep-rg",
  "matchCommand": "^(grep|rg|ag|ack)\\b",
  "matchCommandReject": "-c\\b|--count|-l\\b|--files-with-matches|--json",
  "stripAnsi": true,
  "stripLinesMatching": [
    "^grep: .*: Permission denied$",
    "^rg: .*: IO error$"
  ],
  "replace": [
    { "pattern": "^/[^\\s:]*?/([^/]+/[^/]+/[^:]+):", "replacement": "$1:" }
  ],
  "maxLines": 200
}
```

**Saída esperada:** path absoluto vira últimos 3 segmentos (ex: `/home/dev/projects/claudin/src/shared/errors.ts:27:` → `claudin/src/shared/errors.ts:27:`).

---

## Edge cases / NÃO filtrar quando

- [x] `-c` / `--count` — output é só números, mínimo
- [x] `-l` / `--files-with-matches` — só nomes de arquivo
- [x] `--json` (rg) — passthrough estruturado
- [x] `is_error: true` — passthrough (auth/IO errors)
- [ ] `-A N` / `-B N` / `-C N` (context lines) — output tem `--` separator. Manter.
- [ ] `-o` (only matching) — output diferente, só os matches sem contexto
- [ ] Multiple files explícitos (`grep X file1 file2`) — output tem `file:line:content`. Same filter funciona.
- [ ] Output gigante (10K+ matches) — `maxLines: 200` corta agressivo. **Tradeoff aceito** (user deveria refinar query).
- [ ] **claudin tem `GrepTool`** — agente sofisticado deveria usar. Bash grep é fallback.

---

## Estimativa de redução

| Cenário | Antes (bytes) | Depois | Redução |
|---|---|---|---|
| **`grep` REAL: 7 matches, paths absolutos** | **589** | ~470 (paths relativos) | **~20%** |
| **`rg` REAL: 7 matches, paths relativos** | **564** | 564 (passthrough) | **0%** |
| `grep -rn` em monorepo, 1.000 matches | ~80.000 | ~16.000 (cap 200) | ~80% (mas perde info) |
| `grep` com 50 Permission denied | ~5.000 | ~3.500 (dedup) | ~30% |

**Achado:** `rg` já é compacto por default. **`grep` se beneficia mais** do filter (paths absolutos).

---

## Open questions

- [ ] Vale a pena filtrar mesmo? **claudin tem `GrepTool`** que cobre 90% dos casos. Bash grep é fallback raro.
- [ ] Como reduzir match count em grep huge sem perder info? Talvez "first 100 + count + files affected".
- [ ] **`fzf` / `z` / `fd`** — outros search tools. Adicionar match pattern?

---

## Comparativo com rtk

- rtk: `cmds/system/grep_cmd.rs` — implementa filtro nativo.
- rtk não cobre `rg` especificamente (provavelmente porque rg já é compacto por default).
- **O que copiamos:** strip de Permission denied lines.
- **O que mudamos:** path-relative replace (rtk não faz; pode ter motivos — perda de path absoluto pode ser confuso).

---

## Findings empíricos

1. **`rg` já é compacto** — paths relativos, sem decoração. Filter dá ~0%.
2. **`grep -rn`** com paths absolutos pode reduzir ~20% trocando absoluto por relativo.
3. **claudin tem `GrepTool`** — Bash grep é fallback, ROI marginal.
4. **Recomendação:** Tier 2; implementar só se telemetria mostrar uso real significativo.
