# Command: gh pr list / gh issue list / gh run list

**Match pattern:** `^gh\s+(pr|issue|run|workflow)\s+(list|view)\b`
**Família:** github
**Tier:** 1.5 (alta frequência esperada em workflow PR/issue)
**Estratégia provável:** declarative (truncate columns + `--json` rewrite considerar)
**Status:** **NOT analyzed** (`gh` instalado mas claudin não tem remote GitHub configurado)
**Estimated reduction:** ~60-75% (estimado)

---

## Saída crua representativa

**⚠️ Não capturado** — o `gh` no ambiente local falhou com:
> `none of the git remotes configured for this repository point to a known GitHub host.`

Estrutura típica conhecida:

### `gh pr list` (estimado)

```
Showing 5 of 23 open pull requests in owner/repo

#142  fix(api): handle 429 from openai compat        feat-rate-limit  about 2 hours ago   draft
#141  feat(cli): add /provider doctor command        provider-doctor  about 5 hours ago   review-requested
#140  refactor(tools): lazy-load FileEditTool        lazy-tools       about 1 day ago     approved
#139  docs: clarify privacy guarantees               privacy-docs     about 2 days ago    open
#138  fix(perf): cache prompt for foundry            perf-foundry     about 3 days ago    open
```

### `gh pr view 142` (estimado, ~3-8KB)

Header + body markdown + comments + labels + reviewers — verboso.

### `gh run list` (estimado)

```
completed  success  Build & Test     CI    main    push   12345678  10m12s  about 2 hours ago
completed  failure  Type Check       CI    main    push   12345677   2m34s  about 2 hours ago
in_progress queued   Deploy           CD    main    push   12345676   --     about 30 minutes ago
...
```

---

## Sinal vs ruído

**Sinal (manter):**
- PR/issue number
- Title
- Author / status (open/closed/merged/draft)
- Branch name (PR list)

**Ruído:**
- Timestamps relativos (`about 2 hours ago`) — varia entre rodadas, mata cache
- URLs longas (em `gh pr view`)
- Body com markdown longo (em `view`)
- Footer "Showing N of M" se N == M

---

## Estratégia proposta

### Opção A — forçar `--json` por trás

`gh pr list --json number,title,author,state,baseRefName,headRefName --jq 'limit(20; .[])'`

Output estruturado, ~5× menor. **Quebra "preserve user intent"** mas é tão padrão que vale.

### Opção B — pipeline declarativo

```jsonc
{
  "name": "gh-pr-list",
  "matchCommand": "^gh\\s+(pr|issue|run)\\s+list\\b",
  "matchCommandReject": "--json|--limit\\s+\\d+",
  "stripAnsi": true,
  "replace": [
    { "pattern": "\\s+about\\s+\\d+\\s+(seconds?|minutes?|hours?|days?|weeks?|months?)\\s+ago\\b", "replacement": "" },
    { "pattern": "https://github\\.com/[^\\s]+", "replacement": "<url>" }
  ],
  "maxLines": 30
}
```

---

## Edge cases

- [x] `--json` flag — passthrough
- [x] `--limit N` — passthrough (já reduzido)
- [x] `is_error: true` — passthrough
- [ ] **`gh pr view`** com body markdown longo — possivelmente aplicar filtro próprio (`gh-pr-view`)
- [ ] **`gh run view`** com logs — output pode ser MASSIVO (logs de CI), filtro separado

---

## Open questions

- [ ] **Capturar amostras reais** — bloqueador. Configurar gh com repo GitHub público (ex: anthropics/claude-code).
- [ ] Separar `gh pr list` de `gh pr view` em filtros diferentes? Provável.
- [ ] **`gh run view --log`** — output multi-MB de logs CI. Tratar separadamente.

---

## Comparativo com rtk

- rtk: tem `cmds/git/gh_cmd.rs` — implementa filtro nativo.
- **Confirma valor da feature.**

---

## Findings empíricos

**ZERO empirical findings** — não capturado. Bloqueador documentado, não bloqueia spec.
