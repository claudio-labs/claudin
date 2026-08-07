# Command: git log

**Match pattern:** `^git(\s+-[^\s]+)*\s+log\b`
**Família:** git
**Tier:** 1
**Estratégia provável:** **forçar `--oneline`** (Opção A) — análise empírica favorece fortemente
**Status:** analyzed
**Estimated reduction:** **~92%** (medido, ver tabela abaixo)

---

## Saída crua representativa (claudin repo, 5 May 2026)

### Amostra 1 — `git log -10 --oneline` (680 bytes)

```
bb98dbf chore(release): v0.1.10
3c1ce42 fix(cache): skip model-options cache scope for non-local provider URLs
41c5b06 fix(providers): accurate token metrics for OpenAI-compat providers (#13)
53b6c6d fix(interrupt): propagate Ctrl+C to exit handler when nothing to cancel (#12)
78c72e7 feat(providers): dynamic model discovery + fixes for OpenAI-compat providers
7e583ad feat: fix cli
a6ed4ba test(cache): regression tests + bench for cc_workload prefix flip (#11)
fc131f8 feat(benches): add 11 token-economy measurement scripts (#10)
6fed263 feat(benches): add 5 token-efficiency measurement scripts (#9)
759d3a6 test(tools): add guard tests + heap probes for lazy-tool registry
```

Já compacto, **passthrough**.

### Amostra 2 — `git log -10` formato default (9.220 bytes)

Mesmos 10 commits, **13× mais bytes** porque cada commit tem:

```
commit bb98dbfd00d7244b2e0fa4cdb8da6a02c87d34c8        ← hash full + label "commit"
Author: claudin-release-bot <release@claudin.local>     ← nome + email completo
Date:   Tue May 5 02:28:59 2026 +0000                   ← timestamp absoluto

    chore(release): v0.1.10                              ← subject indentado

    Reviewed-on: http://git.example.com:3000/...        ← trailers verbose
    Co-authored-by: Viudes <...>
    Co-committed-by: Viudes <...>

    ## Summary                                            ← template do PR vazio
    - what changed
    - why it changed
    ...
```

### Amostra 3 — não capturada

`git log --all` em repo cheio facilmente passa de 100KB. Mesma compressão ~92% se forçar `--oneline`.

---

## Sinal vs ruído

**Sinal (manter):**
- Hash curto (7 chars) — referenciável
- Subject (primeira linha do message)

**Ruído (remover):**
- Hash full (40 chars) — 7 basta
- `Author:` com email — nome basta, ou nem isso (autor é raramente acionável)
- `Date:` absoluta — relativa ou nada
- Body completo do commit — só subject pra log
- Trailers `Co-authored-by`, `Reviewed-on`, `Signed-off-by` — total noise pra contexto LLM
- **Templates de PR não preenchidos** (`## Summary\n- what changed\n- why it changed`) — apareceram em 6/10 dos commits reais coletados, total ruído

---

## Estratégia proposta

### Opção A — forçar `--oneline` (RECOMENDADA, validada)

Reescrever o comando substituindo a saída padrão por `--oneline`. Adicionar `-30` se user não passou `-N` (padrão git é "todos os commits", desastroso pra LLM).

```jsonc
{
  "name": "git-log",
  "matchCommand": "^git(\\s+-[^\\s]+)*\\s+log\\b",
  "matchCommandReject": "--oneline|--format=|--pretty=|--graph|--stat|-p\\b|--patch",
  "rewriteCommand": "git log --oneline -30"
}
```

**Tradeoff:** quebra "preserve user intent". Mas o ganho é tão grande (92%) e o `--oneline` é tão padrão que parece OK.

**Mitigação:** o marker no resultado deve declarar `<bash-output-filtered name="git-log" rewrote-as="--oneline -30">` pra que o usuário/modelo entendam.

### Opção B — pipeline declarativo

Mais conservador, preserva forma:

```jsonc
{
  "matchCommand": "^git(\\s+-[^\\s]+)*\\s+log\\b",
  "stripAnsi": true,
  "replace": [
    { "pattern": "^commit ([0-9a-f]{7})[0-9a-f]{33}$", "replacement": "$1" },
    { "pattern": "^Author: ([^<]+) <[^>]+>$", "replacement": "by $1" },
    { "pattern": "^Date:\\s+.*$", "replacement": "" }
  ],
  "stripLinesMatching": [
    "^\\s*Reviewed-on:",
    "^\\s*Co-authored-by:",
    "^\\s*Co-committed-by:",
    "^\\s*Signed-off-by:",
    "^\\s+##\\s+(Summary|Impact|Testing|Notes)\\s*$",
    "^\\s+-\\s+(what changed|why it changed|user-facing impact|developer/maintainer impact|provider/model path tested|screenshots attached|follow-up work)",
    "^\\s+-\\s+\\[\\s\\]\\s+`bun run",
    "^\\s+-\\s+focused tests:\\s*$",
    "^\\s*$"
  ]
}
```

Estimativa Opção B: ~40-50% (cortar trailers + templates). Bem menos que Opção A.

**Recomendação:** Opção A.

---

## Edge cases / NÃO filtrar quando

- [x] `--oneline`, `--format=`, `--pretty=` → passthrough
- [x] `--graph` ASCII art — preservar
- [x] `-p`/`--patch` (com diff) — output muito maior, fallback pro filtro `git diff` ou passthrough
- [x] `--stat` — passthrough (já é overview)
- [ ] **`git log <file>`** — comportamento idêntico ao A
- [ ] **`git log <ref>..<ref>`** — comportamento idêntico ao A
- [ ] **`git log --since=...`** — idem
- [ ] **`git log -1` ou `-1 HEAD`** — caso especial, user quer ver inteiro um commit. Detectar `\b-1\b` e passthrough.
- [ ] **`git log -p -1`** (último commit com diff) — cair em `git diff` filter
- [ ] **`git log --merges` / `--no-merges`** — padrão A funciona
- [ ] **Repo com history reescrito** (rebase em curso) — não afeta filtro

---

## Estimativa de redução

| Amostra | Antes (bytes) | Depois (bytes) | Redução |
|---|---|---|---|
| `-10 --oneline` (já compacto) | 680 | 680 (passthrough) | 0% |
| `-10` formato default | **9.220** | **680** (Opção A) / ~5.000 (Opção B) | **92%** / 46% |
| `--all` repo cheio (estimado) | ~100.000 | ~10.000 (Opção A com -30 cap) | ~90% |

---

## Open questions

- [ ] Cap em `-30` se user não pediu `-N`? Surpreendente mas necessário pra LLM.
- [ ] Como Opção A trata `git log --since="2 weeks ago"`? `--oneline` preserva o filtro, OK.
- [ ] `git log --first-parent` muda a listagem mas `--oneline` cobre. OK.
- [ ] **Risco:** se user pediu `git log` pra ler corpo de commit específico antes de cherry-pick, Opção A esconde o body. Mitigação: detectar `-1` ou `-N <small>` e passthrough.

---

## Comparativo com rtk

- rtk: `cmds/git/git.rs::run_log` — não inspecionei a fundo, mas comportamento provável similar à Opção A.
- **Confirma:** rtk reporta 80% na tabela de savings; nossa medição mostra 92% no caso default. Tabela do rtk é conservadora.

---

## Findings empíricos (deste discovery)

1. **Templates de PR vazios infestam o log**: `## Summary\n- what changed\n- why it changed` aparece em 6/10 commits do claudin. Ruído puro, mas é específico desse repo (template do gitea/github).
2. **Trailers (`Reviewed-on`, `Co-*`)** valem strip global — comuns em qualquer repo com PR workflow.
3. **A diferença entre formato default e `--oneline` é massiva** (13×). Isso justifica forçar `--oneline` mesmo sob princípio "preserve intent".
