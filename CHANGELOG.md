# Changelog

## [unreleased]

### feat

- **`/autofix-pr` substitui `/pr-comments`:** Novo slash command que coleta comentários de review do PR atual, triage em 8 labels (`ok`, `change_request`, `nit`, `praise`, `incorrect`, `pr_questionable`, `unclear`, `out_of_scope`), aplica fixes, roda typecheck+test, commita, dá push e responde nas threads. Faz loop até 5 iterações com anti-stall em `(comment_id, updated_at)`. Suporta `--dry-run` para paridade 1:1 com o antigo `/pr-comments` (listagem read-only). Guarda contra rodar na default branch, HEAD detached, sem `gh auth` ou sem PR aberta.

- **Bash output filter — default-on (Phase 7):** O filtro de saída de comandos Bash agora está ativo por padrão em todas as instalações novas. Economiza ~50k tokens por sessão típica de 30min (~72% de redução de custo de input) filtrando noise de ~35 comandos (pytest, cargo, bundle install, git log, ls, ps aux, etc.). Toggle disponível em `/config` → "Bash output filter". Para desativar: `/config` → toggle off, ou `bashOutputFilterEnabled: false` em `~/.claudio/settings.json`. ([docs/tech/bash-output-filter/](docs/tech/bash-output-filter/))

- **Tip de performance:** Nova tip `bash-output-filter-token-saving` informando sobre o ganho de tokens do filtro. Aparece após 5 startups quando o filtro está ativo, cooldown de 20 sessões.

### chore

- `shouldFilterOutput`: gate alterado de `=== true` para `!== false` — `undefined` (config nova) agora ativa o filtro sem necessidade de valor explícito.
