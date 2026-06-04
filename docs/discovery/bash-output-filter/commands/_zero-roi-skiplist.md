# Zero-ROI commands — não criar filtro

Comandos onde a medição empírica mostra que **não vale a pena criar filtro**. Documentar aqui pra evitar repetir análise depois.

Cada entrada: comando + tamanho típico do output + razão.

---

## `du -h --max-depth=1` (e variantes)

- **Medido:** 584 bytes / 14 linhas (no claudin)
- **Razão:** já vem alinhado e compacto. As únicas economias seriam micro (truncate de tabs), <5%.
- **Recomendação:** passthrough sempre.

```
9.0M	/home/viudes/projects/claudin/.git
16K	/home/viudes/projects/claudin/.github
4.0K	/home/viudes/projects/claudin/bin
176K	/home/viudes/projects/claudin/docs
72K	/home/viudes/projects/claudin/python
680K	/home/viudes/projects/claudin/scripts
25M	/home/viudes/projects/claudin/src
448K	/home/viudes/projects/claudin/vscode-extension
385M	/home/viudes/projects/claudin/node_modules
8.0K	/home/viudes/projects/claudin/.claudin
86M	/home/viudes/projects/claudin/.claude
20K	/home/viudes/projects/claudin/.gitea
62M	/home/viudes/projects/claudin/dist
568M	/home/viudes/projects/claudin
```

## `df -h`

- **Medido:** 656 bytes / 12 linhas
- **Razão:** colunas alinhadas, conteúdo todo é informação acionável (sizes, mount points).
- **Possível economia:** <10% se truncar mountpoints redundantes (`/run/credentials/...`).
- **Recomendação:** passthrough; talvez filter trivial só pra strip duplicates de tmpfs/dev.

## `bun install`

- **Medido:** 96 bytes pra 505 packages
- **Razão:** literalmente 1 linha de status final.
- **Recomendação:** built-in nunca aplicar filtro a `^bun\s+install`. Já documentado em [`npm-install.md`](npm-install.md).

## `git diff` (não-stat)

- **Medido:** 6.677 bytes / 5 arquivos. 4% redução máxima alcançável.
- **Razão:** diff é puro sinal — só index hashes removíveis (~50 bytes/file).
- **Recomendação:** Tier 2 ou descartar. Summarizer existente cobre quando >8KB.

## `find` user-filtered

- **Medido:** 0% redução em uso típico (user passa `-not -path "./node_modules/*"`).
- **Razão:** paths são coordenadas, não há fluff.
- **Recomendação:** Tier 2; pode pular na v1.

## `git --version`, `node --version`, `tsc --version`, etc.

- **Medido:** 1 linha (~30-50 bytes).
- **Razão:** já mínimo absoluto.
- **Recomendação:** nunca filtrar.

## `pwd`, `whoami`, `hostname`, `date`

- **Medido:** 1 linha (1-30 bytes).
- **Razão:** menor que o overhead de qualquer marker.
- **Recomendação:** nunca filtrar.

## `which X`, `command -v X`, `type X`

- **Medido:** 1 linha por arg.
- **Razão:** mínimo.
- **Recomendação:** nunca filtrar.

## `read` (bash builtin) e variantes interativas

- **Razão:** `read` é builtin do bash que lê **input do stdin** (interativo). Não produz stdout no contexto típico de agente.
- **Recomendação:** ignorar — fora de escopo.
- **Outros similares fora de escopo:** `select`, `vim`/`nano`/`emacs`, `less`/`more` interativos, `crontab -e`, `git commit -e`, `git rebase -i`.

## `cat` / `head` / `tail` (não-interativo)

- **Medido:** `cat CLAUDE.md` = 12.175 bytes — 100% conteúdo do arquivo (signal puro).
- **Razão:** output é o file content. claudin tem `FileReadTool` dedicado.
- **Recomendação:** **não criar filtro** — passthrough sempre. Summarizer existente já cobre output >10KB via threshold.
- **Detalhe:** ver `cat.md`.

## `git add` (uso normal, sem `--dry-run`/`-v`)

- **Medido:** silent on success.
- **Razão:** sem output significativo. `--dry-run` em massa pode ter ROI mas é caso edge.
- **Recomendação:** **não criar filtro na v1**. Tier 2/3 baixíssima prioridade.
- **Detalhe:** ver `git-add.md`.

## `rg` (ripgrep) sem flags especiais

- **Medido:** 564 bytes para 7 matches em paths relativos.
- **Razão:** rg já é compacto by design — paths relativos, sem decoração.
- **Recomendação:** filter aplicar só em `grep` (paths absolutos), pular `rg`.
- **Detalhe:** ver `grep-rg.md`.

## `bun test` (no claudin repo)

- Análogo a `bun install`.
- **Razão:** bun é compacto by design. Filter wrap só adiciona overhead.
- **Recomendação:** match-pattern do `npm-test`/`vitest` filter deve **rejeitar** `^bun\s+test\b`.

---

## Adicionar aqui se descobrir mais

Quando a análise de novo comando concluir "ROI < 5%", documentar aqui em vez de criar arquivo dedicado.
