# Command: npm install / pnpm install / yarn install / bun install

**Match pattern:** `^(npm|pnpm|yarn|bun)\s+(install|i|add)\b`
**Família:** js
**Tier:** **DEPENDE DO MANAGER** (split em filtros separados)
**Estratégia provável:** declarative com `match_output` + `unless`
**Status:** parcialmente analyzed
**Estimated reduction:** **0% (bun) a ~60% (npm verbose)**

---

## Saída crua representativa

### Amostra 1 — `bun install` no claudio repo (96 bytes!)

```
bun install v1.3.11 (af24e281)

Checked 704 installs across 505 packages (no changes) [30.00ms]
```

**Já máximo de compacto.** Nada a filtrar.

### Amostra 2 — `npm install` (não capturado)

Estrutura típica em projeto fresh (tamanho real ~5-50KB):

```
npm WARN deprecated foo@1.2.3: use bar@2 instead
npm WARN deprecated baz@0.5: package no longer maintained
...
added 247 packages, and audited 248 packages in 12s

23 packages are looking for funding
  run `npm fund` for details

found 0 vulnerabilities
```

### Amostra 3 — `pnpm install` (não capturado)

```
Lockfile is up to date, resolution step is skipped
Already up to date

dependencies:
+ react 18.2.0

Done in 1.2s
```

### Amostra 4 — `yarn install` v1 (não capturado)

```
yarn install v1.22.19
[1/4] Resolving packages...
[2/4] Fetching packages...
[3/4] Linking dependencies...
[4/4] Building fresh packages...
warning Lockfile has incorrect entry for "foo@^1.2.3". Ignoring it.
success Saved lockfile.
Done in 5.43s.
```

---

## Sinal vs ruído (varia por manager)

### npm (verboso, alvo principal)

**Sinal:**
- `npm WARN deprecated` — algumas vezes acionável
- `npm WARN peer` — peer dep mismatch, importante
- `added/removed/changed N packages` — confirmação
- `found N vulnerabilities`
- Errors completos (`npm ERR!`)

**Ruído:**
- `npm notice` — anúncios de versão nova do npm
- `idealTree:linkDependencies` — debug interno
- Linhas de progress / spinner (já não chegam ao stdout em CI)

### pnpm (já compacto)

Nada significativo a filtrar.

### yarn

**Sinal:** warnings, errors, success/done
**Ruído:** linhas `[1/4] Resolving...` se não há nada a fazer

### bun

**Já mínimo, passthrough sempre.**

---

## Estratégia proposta

**Filtros separados por manager** — confirmado pela análise rtk (`npm_cmd.rs` e `pnpm_cmd.rs` distintos).

### `npm install` filter

```jsonc
{
  "name": "npm-install",
  "matchCommand": "^npm\\s+(install|i|add|ci)\\b",
  "stripAnsi": true,
  "stripLinesMatching": [
    "^npm notice ",
    "^\\s*$"
  ],
  "matchOutput": [
    {
      "pattern": "^added \\d+ packages?(?:, and audited)?",
      "message": "✓ npm install completed",
      "unless": "(?i)\\b(error|err!|deprecated|vulnerab|peer dep)\\b"
    },
    {
      "pattern": "up to date",
      "message": "✓ npm: up to date",
      "unless": "(?i)\\b(error|err!|warn|deprecated)\\b"
    }
  ],
  "maxLines": 30
}
```

### `pnpm install` filter

```jsonc
{
  "name": "pnpm-install",
  "matchCommand": "^pnpm\\s+(install|i|add)\\b",
  "matchOutput": [
    {
      "pattern": "^Done in [\\d.]+s$",
      "message": "✓ pnpm install completed",
      "unless": "(?i)\\b(error|warn)\\b"
    }
  ]
}
```

### `bun install` filter

**Não criar filtro.** Already minimal.

```jsonc
// não inclui no built-in set
```

### `yarn install` filter

```jsonc
{
  "name": "yarn-install",
  "matchCommand": "^yarn\\s+(install|add)\\b",
  "stripLinesMatching": [
    "^\\[\\d+/\\d+\\] (Resolving|Fetching|Linking|Building) packages\\.\\.\\.$"
  ],
  "matchOutput": [
    {
      "pattern": "^Done in [\\d.]+s\\.$",
      "message": "✓ yarn install completed",
      "unless": "(?i)\\b(error|warning)\\b"
    }
  ]
}
```

---

## Edge cases / NÃO filtrar quando

- [x] `is_error: true` → passthrough
- [x] `--silent` / `-s` flag → passthrough
- [x] `--verbose` flag → passthrough (user pediu detalhe)
- [x] `--dry-run` → passthrough (semântica diferente)
- [ ] **`npm ci`** — comportamento similar a `npm install`, mesmo filtro
- [ ] **Lockfile mismatch** (`npm ERR! ELOCKVERIFY`) — preservar inteiro
- [ ] **Vulnerability summary** com tabela — preservar (regex `unless` cobre)
- [ ] **`yarn install` Berry (v2+)** — output completamente diferente do v1, precisa filtro separado se for relevante
- [ ] **Workspace install** — output 10× maior, mesmo filtro deveria comprimir bem
- [ ] **`npm publish`** / `npm pack` — comportamento totalmente diferente, fora de escopo

---

## Estimativa de redução

| Manager / cenário | Antes (bytes) | Depois | Redução |
|---|---|---|---|
| `bun install` (no changes) | 96 | 96 | 0% (passthrough) |
| `npm install` clean | ~3.000 | ~150 (`match_output`) | 95% |
| `npm install` com 5 warnings | ~5.000 | ~2.500 | 50% |
| `pnpm install` (already up to date) | ~150 | ~50 | 67% |
| `yarn install` clean | ~800 | ~80 | 90% |

**ACHADO:** o ROI varia drasticamente por manager. **`bun install` deve ser explicitamente excluído** — qualquer filtro só adiciona overhead.

---

## Open questions

- [ ] **Não capturei amostras reais de npm/pnpm/yarn.** Esses números são estimativas baseadas em comportamento conhecido. Coletar amostras reais antes de decidir filtros.
- [ ] **`yarn` v1 vs Berry (v2+)** — outputs muito diferentes. Detectar versão? Provavelmente assumir v1 e v2 ter output suficientemente diferente que regex de v1 não case em v2 = degrada graceful para passthrough.
- [ ] **`npm install <pkg>`** vs `npm install` (sem args) — ambos passam no regex; comportamento similar.
- [ ] **`pnpm add <pkg> -w`** workspace flag — preservar info de qual workspace.

---

## Comparativo com rtk

- rtk: filtros separados `cmds/js/npm_cmd.rs` e `cmds/js/pnpm_cmd.rs`. **Confirma split por manager.**
- rtk reporta 92% (`npm install` na tabela) — alinhado com nossa estimativa pra caso clean.
- rtk não trata `bun` — confirma "já compacto, sem filtro".

---

## Findings empíricos

1. **`bun install` é puro sinal — 96 bytes pra 505 packages.** Marker explícito de "skip" no built-in set.
2. **Filtros têm que ser por manager** — outputs incompatíveis.
3. **`match_output` com `unless` é o motor principal** desses filtros — a maioria das instalações sucede sem incidente, e nesses casos colapsar pra "✓ done" é a economia toda.
4. **Sample collection pendente** pra npm/pnpm/yarn — nossas estimativas precisam validação.
5. **Bom candidato pra Fase 0:** medir frequência real de cada manager por sessão claudio.
