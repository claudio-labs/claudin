# Top 10 Features Mais Pedidas — Claude Code, opencode, openclaude (maio/2026)

Pesquisa baseada em issues do GitHub ordenadas por reações, Reddit, Hacker News, GitHub Discussions e changelogs. Cada item traz issue, contagem de reações/comentários e fontes.

---

## 1. Claude Code (anthropics/claude-code)

| # | Feature | Descrição | Popularidade | Fontes |
|---|---------|-----------|--------------|--------|
| 1 | **Suporte nativo a AGENTS.md** | Adotar o padrão cross-tool `AGENTS.md` (Codex, Cursor, Amp, Copilot, ~20k repos OSS) com fallback pro CLAUDE.md. Comunidade enquadra como maior gap de interop: "Codex trata AGENTS.md como contrato, Claude trata CLAUDE.md como sugestão". | #6235 — **3.856 👍, 367 hearts, 303 rockets, 272 hooray, 294 comments** (de longe a issue mais reagida); duplicata #31005 também aberta | [#6235](https://github.com/anthropics/claude-code/issues/6235), [#31005](https://github.com/anthropics/claude-code/issues/31005), [marmelab tips](https://marmelab.com/blog/2026/04/24/claude-code-tips-i-wish-id-had-from-day-one.html) |
| 2 | **Trazer "Buddy" de volta** | Restaurar o modo companheiro removido — sidekick leve que observava sem tomar controle da sessão. | #45596 — top-2 por reações; marcada como duplicata mas continua acumulando | [#45596](https://github.com/anthropics/claude-code/issues/45596) |
| 3 | **Multi-account profile switcher** | Trocar contas (trabalho/pessoal, múltiplas Max) com history/MCP/settings separados; hotkey Cmd+Shift+]. Cobre Desktop e Mobile. | #18435 — 492 👍, 84 comments; gêmeo mobile #36151 também no top-20 | [#18435](https://github.com/anthropics/claude-code/issues/18435), [#36151](https://github.com/anthropics/claude-code/issues/36151) |
| 4 | **XDG Base Directory no Linux** | Parar de poluir `~` com `~/.claude.json` e `~/.claude/`; honrar `XDG_CONFIG_HOME/DATA_HOME/CACHE_HOME`. Open há >1 ano. | #1455 — 353 👍, 55 comments, label bug+enhancement | [#1455](https://github.com/anthropics/claude-code/issues/1455) |
| 5 | **Conectar a Claude.ai Projects** | Project do Claude.ai como knowledge base compartilhada com a CLI (specs, design docs, refs) com cache. | #2511 — 328 👍, 99 hearts, 52 rockets, 29 eyes, 44 comments | [#2511](https://github.com/anthropics/claude-code/issues/2511) |
| 6 | **Extensão VSIX para Visual Studio 2026** | Dev C++/Win32/.NET/games querem painel Claude dockável no VS completo (não VS Code), com diff nativo, sync de arquivo ativo + seleção + build errors, `/ide` linkage. | #15942 — 281 👍, 21 rockets, 19 hooray, 11 hearts, 106 comments | [#15942](https://github.com/anthropics/claude-code/issues/15942) |
| 7 | **Ver/editar texto colado antes de enviar** | Paste colapsa pra `[Pasted text +34 lines]` sem preview/edit. Hotkey pra expandir + config pra desativar collapse + integração `$EDITOR`. Necessidade real de acessibilidade pra usuários de ditado. | #3412 — 253 👍, 14 hearts, 73 comments, reaberta | [#3412](https://github.com/anthropics/claude-code/issues/3412) |
| 8 | **"Show thinking" sempre on** | v2.0.0 escondeu thinking mesmo no verbose, quebrou workflow de quem dirige raciocínio. Pedem `CLAUDE_CODE_ALWAYS_SHOW_THINKING=true` ou settings.json em vez de Ctrl+O → Ctrl+E. | #8477 — 251 👍, 24 eyes, 81 comments | [#8477](https://github.com/anthropics/claude-code/issues/8477) |
| 9 | **Copy/paste limpo no terminal** | Copiar saída arrasta indentação do prompt `>`/`·` e padding direito até a largura do terminal. Fix anterior regrediu. | #18170 — 235+ 👍, 107+ comments | [#18170](https://github.com/anthropics/claude-code/issues/18170) |
| 10 | **Tema auto light/dark seguindo OS** | Terminais que trocam com macOS/Linux deixam Claude Code preso na paleta errada (texto ilegível). Piorou na 2.0. | #2990 — 240 👍, 48 comments, area:tui+enhancement, assigned mas aberta | [#2990](https://github.com/anthropics/claude-code/issues/2990) |

**Menções honrosas Claude Code:**
- Permissões compostas no Bash (`cd /x && git status`) — #16561 (149 👍)
- Mostrar path no READ collapsed — #21151 (185 👍, 131 comments)
- MCP sampling via Max subscription — #1785 (113+42 reactions, 54 comments)
- Múltiplos connectors mesmo tipo (2 GitHubs, 2 Gmails) — #27302 (226 👍, 79 hearts, 171 comments)
- Iniciar Claude Code Web em branch não-default — #10018
- Plugin Neovim/Emacs oficial — #1234
- Honestidade sobre conclusão / não comitar testes quebrados — recorrente Reddit/HN vs Codex
- Guardrails contra ops destrutivas (pós-incidente Terraform RDS) — [HN 47500015](https://news.ycombinator.com/item?id=47500015)
- Qualidade em long-context >200k/300k tokens — Reddit/VentureBeat

---

## 2. opencode (sst/opencode)

| # | Feature | Descrição | Popularidade | Fontes |
|---|---------|-----------|--------------|--------|
| 1 | **Comando `/btw`** | "By the way" pra injetar clarificação no meio de uma run sem matar o agente. | #16992 — 235 reactions / 96 👍 | [#16992](https://github.com/sst/opencode/issues/16992) |
| 2 | **Integração com Cursor** | Sidecar + diff view + approvals dentro do Cursor IDE. | #2072 — 231 / 169 👍 | [#2072](https://github.com/sst/opencode/issues/2072) |
| 3 | **Expandir texto colado** | Placeholder colapsado vira expansível, editável, re-visualizável inline. | #8501 — 219 / 160 👍 | [#8501](https://github.com/sst/opencode/issues/8501) |
| 4 | **Agent Teams (multi-agente)** | Coordinator + workers nativos, equivalente a sub-agents do Claude. | #12661 — 179 / 110 👍 | [#12661](https://github.com/sst/opencode/issues/12661) |
| 5 | **Speech-to-text** | Push-to-talk direto no TUI. | #4695 — 174 / 144 👍 | [#4695](https://github.com/sst/opencode/issues/4695) |
| 6 | **Vim motions no input** | `hjkl`, `dw`, `ci"` no prompt. | #1764 — 158; PR #12679 — 94 | [#1764](https://github.com/sst/opencode/issues/1764), [PR #12679](https://github.com/sst/opencode/pull/12679) |
| 7 | **System prompts customizados global/projeto** | `~/.config/opencode/prompt/<name>.txt` + `.opencode/prompt/`. | #7101 — 135 / 101 👍 | [#7101](https://github.com/sst/opencode/issues/7101) |
| 8 | **Auto-descobrir modelos via `/v1/models`** | Bater no endpoint OpenAI-compat e listar; sem PR no models.dev. | #6231 — 118 / 112 👍 | [#6231](https://github.com/sst/opencode/issues/6231) |
| 9 | **Trocar cwd no meio da sessão** | Sem restart; essencial em monorepo. | #2177 — 95 / 94 👍 | [#2177](https://github.com/sst/opencode/issues/2177) |
| 10 | **Medidor de contexto da sessão** | Indicador live de tokens + breakdown (system prompt / tools / files / MCP / turns). | #6152 — 88; relacionados #5374 (67), #6146 | [#6152](https://github.com/sst/opencode/issues/6152), [#5374](https://github.com/sst/opencode/issues/5374) |

**Menções honrosas opencode:**
- VSCode extension oficial — #11176 (82 reactions)
- Multi-account OAuth com auto-relogin — PR #11832 (81 reactions, 35 comments)
- Async / background sub-agent delegation — #5887 (78)
- Model fallback/failover entre modelos diferentes — #7602 (75)
- **Memory leak megathread** (aberta pelo @thdxr) — #20695 (74 reactions, 75 comments)
- Clickable links no TUI — #1168 (73)
- Mobile / Web UI — #10288 (70)
- Tracking de Copilot premium-request quota — #768 (70, 33 comments)
- `/skills` command — #7846 (69)
- Hot-reload de agents/skills/commands — #8751 (68)
- **Defaults de segurança** (pós-RCE não-autenticado jan/2026, [HN 432 pts](https://cy.md/opencode-rce/)) — #5076 (68)
- `mcp-search` / MCP tools lazy-loaded — #8625 (61), PR #12520
- SSH remote do Desktop app — #7790 (59)

---

## 3. openclaude (Gitlawb/openclaude)

**Existe e tem tração:** ~26.4k stars, ~8.4k forks, 78 open issues. Fork não-oficial de Claude Code retargetado pra OpenAI-compatible, Gemini, Ollama, GitHub Models, Codex OAuth ([OSS Insight](https://ossinsight.io/analyze/Gitlawb/openclaude)). Reddit/HN tem pouco; comunidade vive nas issues/Discussions.

| # | Feature | Descrição | Popularidade | Fontes |
|---|---------|-----------|--------------|--------|
| 1 | **1 Premium Request por user turn** | Bundlar sub-agents/tool-calls em uma única request upstream — hoje uma task complexa queima 50%+ da quota mensal Copilot porque cada sub-step é faturado. | #678 — top por reactions | [#678](https://github.com/Gitlawb/openclaude/issues/678) |
| 2 | **Tool-calling funcional pra Ollama / locais** | qwen2.5-coder, llama3.1, deepseek-r1, codellama emitem JSON cru ou prosa em vez de `tool_calls` OpenAI-format; reads/edits falham silenciosamente. Pedem parser tolerante + fallback harness. | #433 (9 comments), #486 (4 comments) — ambas no top-10 | [#433](https://github.com/Gitlawb/openclaude/issues/433), [#486](https://github.com/Gitlawb/openclaude/issues/486) |
| 3 | **Memory-leak / OOM em sessões longas** | "JavaScript heap out of memory" multi-step (~2 GB peak). 3 leaks identificados: bash children órfãos, outputs grandes retidos no transcript, idle bloat. Pedem cleanup + compaction + idle GC. | #546 (#1 por comments), #402, Discussion "Memory Optimization Proposal" | [#546](https://github.com/Gitlawb/openclaude/issues/546), [#402](https://github.com/Gitlawb/openclaude/issues/402) |
| 4 | **Ollama remoto / Tailscale sem dummy key** | `OPENAI_API_KEY required when CLAUDE_CODE_USE_OPENAI=1 and OPENAI_BASE_URL is not local` bloqueia qualquer Ollama fora de RFC1918. Pedem auto-detect (porta 11434, hostname "ollama", range Tailscale 100.64.0.0/10). | #369 — top-5 por comments; PR #952 em vôo | [#369](https://github.com/Gitlawb/openclaude/issues/369) |
| 5 | **`/provider` hot-swap real** | Trocar provider no REPL não re-binda o cliente — sessão continua hitando endpoint antigo até restart. | #695 — top-10 reactions | [#695](https://github.com/Gitlawb/openclaude/issues/695) |
| 6 | **Context window / max-output por modelo** | Modelo OpenAI-compat custom (DeepSeek V4 Pro, Kimi K2.5) sem campo pra declarar context real → trunca pro default seguro. | #478 — top-7 enhancement | [#478](https://github.com/Gitlawb/openclaude/issues/478) |
| 7 | **Custom agents persistirem em Windows** | `.openclaude/agents/` aparece na sessão ativa mas some após restart em Win11/PowerShell — arquivos existem, não recarregam. | #452 — 7 comments, reaberta abr/12 | [#452](https://github.com/Gitlawb/openclaude/issues/452) |
| 8 | **Trocar agent ativo via `/agents`** | Hoje só na inicialização; querem mostrar o atual no topo do diálogo e trocar live via `useAppState`. | #526 — 7 comments, enhancement | [#526](https://github.com/Gitlawb/openclaude/issues/526) |
| 9 | **ChatGPT Pro / Codex OAuth headless e WSL-friendly** | Browser flow falha em WSL/servers headless; pedem device-flow estilo opencode + entry explícita "ChatGPT Pro". | #519 — 5 comments, "valid request, leaving open" | [#519](https://github.com/Gitlawb/openclaude/issues/519) |
| 10 | **`OPENCLAUDE_CONFIG_DIR` dedicado** | Compartilhar `~/.claude/` com o Claude Code real clobbera configs nos dois lados. Workaround circula: `export CLAUDE_CONFIG_DIR="$HOME/.openclaude"`. PR #935 não merged. | #454 — top reactions entre enhancements | [#454](https://github.com/Gitlawb/openclaude/issues/454) |

**Menções honrosas openclaude:**
- Compaction de request 20MB no Groq (até "hi!" falha) — #736
- Passar `reasoning_content` em retries DeepSeek V4 / Kimi — #859, #904
- Gemini-on-Vertex (não só Claude-on-Vertex) — #275
- Auto-instalador / self-update — #533
- Retry transient failures (`fetch failed`, 5xx) — #370, #490
- Web dashboard / browser UI — Discussion
- YOLO mode — Discussion
- `/loop` funcional — Discussion #245
- VSCode extension polida — #961

---

## Overlap entre os três

Features pedidas em **ao menos 2 dos 3** projetos — alvo prioritário porque demanda é validada por múltiplas comunidades:

1. **Checkpoint/rollback de um toque antes de edits destrutivos** — Claude Code (HN guardrails pós-Terraform RDS), Codex `/undo` + `/rewind`, opencode (gambiarras git-hook).
2. **Medidor live de contexto / tokens / custo no TUI** — opencode #6152/#11176/#7602, openclaude implícito (OOM #546), Claude Code threads recorrentes.
3. **Multi-conta / profile switcher** — Claude Code #18435 + #27302, openclaude #695 (provider hot-swap), opencode #2177.
4. **Multi-agent coordinator + workers nativo** — opencode #12661 (Agent Teams), Claude Code Managed Agents, openclaude #526 (active agent).
5. **Texto colado expansível/editável** — Claude Code #3412, opencode #8501, openclaude (pasta longa em prompts).
6. **Tool-calling tolerante pra modelos não-Anthropic** — openclaude #433/#486 (Ollama), opencode #6231 (auto-models), Claude Code (BYOK pedidos).
7. **Honestidade sobre conclusão (não dizer "done" com testes vermelhos)** — Claude Code recorrente Reddit/HN, openclaude implícito em retries.

---

## Como isso se relaciona com Claudin (estado atual)

**Já temos parcial ou total — marketing pode capitalizar:**
- ✅ Multi-provider/profile via `/provider` (cobre Claude Code #18435 e openclaude #519/#695 parcialmente)
- ✅ `CLAUDIN_CONFIG_DIR` override + migração `~/.claude/`→`~/.claudin/` (resolve openclaude #454, Claude Code #1455 espirito)
- ✅ Coordinator + worker agents (`COORDINATOR_MODE`) — opencode #12661, openclaude #526
- ✅ Bash output filter (~50K tokens/sessão, -72% input cost) — endereça openclaude #1, #3
- ✅ AGENTS.md poderia ser trivial — issue #6235 do Claude Code é a #1 mais reagida (3.856 👍); Claudin já lê CLAUDE.md, adicionar fallback é low-effort/high-impact
- ✅ Telemetria stub-out — endereça preocupações pós-vazamento Claude Code

**Gaps com demanda comprovada (oportunidade):**
- ❌ Checkpoint/undo de edits destrutivos (overlap dos 3)
- ❌ Medidor live de contexto/tokens no TUI (parcial via `/usage` em config, falta inline)
- ❌ Texto colado expansível com `$EDITOR`
- ❌ Voice / speech-to-text
- ❌ Tool-calling tolerante pra Ollama (parser fallback)
- ❌ XDG Base Directory no Linux
- ❌ `/btw` interrupt sem matar agente
- ❌ Hot-reload de custom agents em Windows

---

## Fontes agregadas

- [anthropics/claude-code issues sort:reactions](https://github.com/anthropics/claude-code/issues?q=is%3Aissue+is%3Aopen+sort%3Areactions-desc)
- [sst/opencode issues sort:reactions](https://github.com/sst/opencode/issues?q=is%3Aissue+is%3Aopen+sort%3Areactions-desc)
- [Gitlawb/openclaude issues sort:reactions](https://github.com/Gitlawb/openclaude/issues?q=is%3Aissue+is%3Aopen+sort%3Areactions-%2B1-desc)
- [openai/codex issues sort:reactions](https://github.com/openai/codex/issues?q=is%3Aissue+is%3Aopen+sort%3Areactions-desc)
- [OSS Insight: Gitlawb/openclaude](https://ossinsight.io/analyze/Gitlawb/openclaude)
- [Marmelab: Claude Code tips](https://marmelab.com/blog/2026/04/24/claude-code-tips-i-wish-id-had-from-day-one.html)
- [Anthony Maio: Codex got better because Claude Code got weird](https://anthonymaio.substack.com/p/codex-got-better-because-claude-code)
- [MacRumors: Rate limit drain bug](https://www.macrumors.com/2026/03/26/claude-code-users-rapid-rate-limit-drain-bug/)
- [HN: Update on Claude Code quality](https://news.ycombinator.com/item?id=47878905)
- [HN: Source leak](https://news.ycombinator.com/item?id=47586778)
- [HN: Codex vs Claude](https://news.ycombinator.com/item?id=47750069)
- [HN: Terraform RDS incident](https://news.ycombinator.com/item?id=47500015)
- [aitooldiscovery: Claude Reddit synthesis](https://www.aitooldiscovery.com/guides/claude-reddit)
- [Simon Willison: Code w/ Claude 2026](https://simonwillison.net/2026/May/6/code-w-claude-2026/)
