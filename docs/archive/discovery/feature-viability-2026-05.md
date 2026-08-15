# Análise de Viabilidade — Features Pedidas (vs. estado atual do Claudin)

Data: 2026-05-12
Fonte: 29 agents Explore disparados em paralelo contra `src/`.

## Legenda
- ✅ **JÁ EXISTE** — pronto pra uso
- 🟡 **PARCIAL** — código existe mas dormente / incompleto / com gaps
- 🟠 **FALTA (fácil)** — gap pequeno, dá pra implementar rápido
- 🔴 **FALTA (difícil)** — exige trabalho substancial

---

## Resumo executivo

**13 features já existem** (✅), **8 são parciais** (🟡), **5 faltam mas são fáceis** (🟠), **3 faltam e são difíceis** (🔴).

**Marketing imediato:** Claudin já entrega 13 das 29 features mais pedidas pelo mercado. Algumas (AGENTS.md, /btw, Buddy, /context, vim, Agent Teams) são exatamente o que usuários do Claude Code/opencode estão **abrindo issues pedindo**.

---

## Tabela completa

| # | Feature | Status | Arquivos principais | Notas |
|---|---------|--------|---------------------|-------|
| 1 | **AGENTS.md support** | ✅ JÁ EXISTE | `src/services/instructions/projectInstructions.ts:3-48`, `src/services/instructions/claudemd.ts:900-913` | É o nome **preferido**; CLAUDE.md vira fallback. `/init` escreve AGENTS.md por padrão. Dogfooding: o próprio repo ainda usa CLAUDE.md (renomear seria simbólico). |
| 2 | **Buddy / companion mode** | ✅ JÁ EXISTE | `src/terminal/buddy/companion.ts`, `observer.ts`, `prompt.ts`, `CompanionSprite.tsx`; flag `BUDDY: true` em `scripts/build.ts:47` | Completo: sprite gacha, per-turn observer, slash command `/buddy`. |
| 3 | **Multi-account profile switching** | 🔴 FALTA (difícil) | `src/platform/config/config.ts:624-627`, `src/services/api/providerProfiles.ts` | Só tem multi-PROVIDER, não multi-USER. Histórico, MCP, credenciais são globais. Workaround: `CLAUDIN_CONFIG_DIR` per-shell. Exigiria namespacing de `~/.claudin/projects/`, `.credentials.json`, MCP. |
| 4 | **XDG Base Directory** | 🟠 FALTA (fácil) | `src/shared/envUtils.ts:5-28`, `src/shared/fs/xdg.ts` (helpers existem!) | Helpers XDG já existem em `xdg.ts` mas não são usados pelo config dir. Adicionar fallback `$XDG_CONFIG_HOME/claudin` em `resolveClaudinConfigHomeDir` é trivial. |
| 5 | **Claude.ai Projects integration** | 🔴 FALTA (difícil) | n/a (apenas MCP fetch em `src/services/mcp/claudeai.ts`) | Conflita com postura anti-telemetry. Aproximação possível: MCP servers para Drive/Notion/Gmail já existem via `claudeai-proxy`. |
| 6 | **VS 2026 (full IDE) extension** | 🔴 FALTA (difícil) | `src/platform/ide/ide.ts` (só suporta vscode + jetbrains) | Requer VSIX novo (modelo de extensão diferente de VS Code), `ideKind: 'visualstudio'` em toda a stack. |
| 7 | **Expand pasted-text blocks** | ✅ JÁ EXISTE | `src/terminal/prompt-input/PromptInput.tsx:1249-1266`, `src/terminal/input/promptEditor.ts:138-188`, keybind `Ctrl+G` / `Ctrl+X Ctrl+E` | Auto-expande no submit; integra `$EDITOR` (vê + edita + re-colapsa). Falta só "expand inline" sem editor — mas o caminho via $EDITOR cobre o caso. |
| 8 | **Always-show-thinking config** | 🟡 PARCIAL | `src/components/messages/AssistantThinkingMessage.tsx:39`, `verbose` setting | `"verbose": true` já força expand de thinking. Adicionar setting dedicado (`alwaysShowThinking`) é trivial (1 linha). |
| 9 | **Clean copy/paste no terminal** | 🟡 PARCIAL | `src/terminal/ink/selection.ts:773`, `NoSelect.tsx`; bug em `HighlightedThinkingText.tsx:91,145` e `UserCommandMessage.tsx:47,84` | Sistema de seleção robusto existe; assistant prefix `●` está com `NoSelect`. Bug: user prompt `>` não está wrapped → vaza no copy. Fix: 4 linhas. |
| 10 | **Auto theme follow system** | 🟡 PARCIAL | `src/terminal/theme/systemTheme.ts`, `theme.ts`; flag `AUTO_THEME` ausente em `featureFlags`; `systemThemeWatcher.ts` não existe | Código de detecção (COLORFGBG, OSC 11) está pronto, mas dormente. Precisa adicionar flag + criar watcher module. |
| 11 | **/btw out-of-band command** | ✅ JÁ EXISTE | `src/commands/btw/index.ts`, `btw.tsx`; `src/utils/sideQuestion.ts`, `forkedAgent.ts` | Modal Ink, fork com cache-safe params, não polui transcript. Exatamente o que opencode #16992 (235 reactions) pede. |
| 12 | **Cursor CLI provider** | 🔴 FALTA (difícil) | `src/services/api/providerConfig.ts:569` | Cursor CLI não é OpenAI-compat; exige shim dedicado tipo `codexShim.ts`. |
| 13 | **Agent Teams (multi-agent flat)** | ✅ JÁ EXISTE | `src/tools/TeamCreateTool/`, `SendMessageTool/`, `src/coordinator/swarm/`, gated em `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` | Mais completo que o opencode #12661 pede: peer-to-peer messaging, broadcast `"*"`, cross-session via UDS_INBOX, prompt indicator colorido por teammate. |
| 14 | **Voice/STT input** | 🟡 PARCIAL (dormente) | `src/terminal/voice/`, `src/terminal/voice/voiceStreamSTT.ts`, flag `VOICE_MODE: false` em `scripts/build.ts:28` | Stack inteira existe mas requer Anthropic infra (claude.ai OAuth → voice_stream WebSocket). Não é Whisper local. |
| 15 | **Vim motions no prompt** | ✅ JÁ EXISTE | `src/terminal/vim/motions.ts`, `operators.ts`, `textObjects.ts`; `VimTextInput.tsx`; slash `/vim` | hjkl, w/b/e, dd, ciw/diw/caw/daw, operators d/c/y, counts, tudo. opencode #1764 (158 reactions) é resolvido. |
| 16 | **Custom system prompts** | ✅ JÁ EXISTE | `src/utils/systemPrompt.ts:41-119`, `claudemd.ts` (memory hierarchy) | 11 mecanismos diferentes: managed/user/project/local CLAUDE.md, `--system-prompt`, `--append-system-prompt`, agent-driven, coordinator, override. |
| 17 | **Auto-discover models via /v1/models** | ✅ JÁ EXISTE | `src/utils/model/openaiModelDiscovery.ts` | Hits `/v1/models` em qualquer endpoint OpenAI-compat (Ollama, LM Studio, llama.cpp, vLLM); fallback pra `/api/tags` do Ollama nativo; cacheia context_length real. opencode #6231 (118 reactions) resolvido. |
| 18 | **cd mid-session** | 🟠 FALTA (fácil) | `src/platform/bootstrap/state.ts:515-521` (`setCwdState`), `src/shared/fs/cwd.ts` | Infra existe (worktree usa `setCwdState`). Falta só um slash `/cd` que valide path e chame `setCwdState`. Trivial. |
| 19 | **/context token breakdown** | ✅ JÁ EXISTE | `src/commands/context/`, `src/services/context/analyzeContext.ts:992-1128`, `src/components/ContextVisualization.tsx` | Grid colorido com breakdown: system prompt / tools (sys+MCP+deferred) / agents / memory / skills / messages / free space. opencode #6152 (88 reactions) resolvido. |
| 20 | **One Premium Request per turn (Copilot)** | 🔴 FALTA (difícil) | `src/QueryEngine.ts`, `src/services/api/openaiShim.ts:1616` (branch Copilot) | Não tem batching/coalescing. Cada tool call = 1 request. Para Copilot quota seria preciso inlinar Haiku-summaries, cachear cadeias triviais, e diferir sub-agent reports. |
| 21 | **Tolerant tool-call parser (Ollama)** | 🟠 FALTA (fácil-médio) | `src/services/api/openaiShim.ts:1097-1179` | Hoje só parseia `delta.tool_calls` estruturado. Se modelo emite JSON no `content`, vira texto. Adicionar sniffer de JSON/XML-tag-style no content é factível. |
| 22 | **Memory leak / OOM handling** | ✅ JÁ EXISTE (exemplar) | `src/services/compact/postCompactCleanup.ts:165`, `bin/claudin:20-80` (jemalloc + --expose-gc + 8GB cap), `src/tools/BashTool/BashTool.tsx` cleanup paths, `scripts/profile/long-session-bench.ts` | Estado da arte: compaction multi-tier, post-compact cleanup hint GC, jemalloc preload, abort+cleanup+kill em todos paths do BashTool. opencode #20695 (74 reactions) seria resolvido. |
| 23 | **Remote Ollama / Tailscale** | ✅ JÁ EXISTE (com gaps) | `src/services/api/openaiShim.ts:1702-1731` (api key optional), `cacheMetrics.ts:204-205` (CGNAT) | Funciona sem dummy key. Gap: `isLocalProviderUrl` em `providerConfig.ts:107-118` não cobre CGNAT 100.64.0.0/10 → toolless retry e loopback retry não disparam. Fix: 5 linhas. |
| 24 | **/provider hot-swap mid-session** | ✅ JÁ EXISTE | `src/services/api/activeProvider.ts:43-52,93-104`, `src/components/ProviderManager.tsx:762-815` | Cache invalidado em `onGlobalConfigChange`; SDK rebuilt per request a partir de `tryGetActiveProvider()`. Hot-swap genuíno. openclaude #695 resolvido. |
| 25 | **Per-model context window override** | 🟠 FALTA (fácil) | `src/platform/config/config.ts:208-228` (`ProviderProfileExtras`) | Schema do profile não tem `contextWindow` / `maxOutputTokens`. Adicionar 2 campos em `ProviderProfileExtras` e usar em `withRetry.ts` / `context.ts`. openclaude #478. |
| 26 | **Custom agent persistence (Windows)** | ✅ JÁ EXISTE | `src/tools/AgentTool/loadAgentsDir.ts`, `src/services/instructions/markdownConfigLoader.ts`, `src/shared/fs/file.ts:570` (`normalizePathForComparison`) | Robusto: re-scan a cada sessão, normalização de path Windows, fallback realpath, dedup inode. 2 caveats menores em `getFileIdentity` e hot-reload. openclaude #452 resolvido. |
| 27 | **Show & switch active agent live (/agents)** | 🟠 FALTA (fácil) | `src/commands/agents/agents.tsx`, `src/components/agents/AgentsMenuWithTabs.tsx` | `/agents` hoje gerencia sub-agents do Task tool. Não mostra agent ativo da sessão nem permite switch live. openclaude #526. |
| 28 | **Headless Codex/ChatGPT OAuth** | 🟡 PARCIAL | `src/services/api/codexOAuth.ts:183`, `useCodexOAuthFlow.ts`, `ProviderManager.tsx:393-406` | Funciona WSL2 (localhost hairpin) e SSH com port-forward manual. NÃO funciona em headless puro (callback exige localhost:1455 no mesmo host do browser). Workaround: copiar `~/.codex/auth.json` de outra máquina. Solução: device-code flow ou OOB. openclaude #519. |
| 29 | **CLAUDIN_CONFIG_DIR override** | ✅ JÁ EXISTE | `src/shared/envUtils.ts:5-28`, `src/platform/config/claudinMigration.ts:498-511` | Confirmado. Legado `~/.claude/` só lido para migration, nunca escrito. openclaude #454 resolvido. |

---

## Recomendações de roadmap

### Quick wins (FALTA fácil — alto ROI)
1. **`/cd` slash command** (#18) — infra já existe via `setCwdState`. **~30 linhas.**
2. **XDG fallback no config dir** (#4) — helpers já em `src/shared/fs/xdg.ts`. **~10 linhas em `envUtils.ts`.**
3. **Fix copy/paste do user prompt `>`** (#9) — wrap em `<NoSelect>`. **4 linhas.**
4. **Per-model context window** (#25) — 2 campos em `ProviderProfileExtras`. **~50 linhas.**
5. **Setting dedicado `alwaysShowThinking`** (#8) — 1 linha em `AssistantThinkingMessage.tsx:39`.
6. **CGNAT 100.64/10 em `isLocalProviderUrl`** (#23) — **5 linhas.**
7. **`/agents` mostrar + switch agent ativo** (#27) — adicionar header + ação no menu existente.

### Médio esforço (alto valor de mercado)
8. **AUTO_THEME** (#10) — criar `systemThemeWatcher.ts` + adicionar flag em `featureFlags`. Código de detecção já pronto.
9. **Tolerant tool-call parser** (#21) — sniffer de JSON no `content` quando provider é Ollama/local.
10. **Codex OAuth device-flow** (#28) — implementar OOB ou device-code path.

### Marketing imediato (já existe, divulgar)
- **AGENTS.md preferido** (Claude Code #6235, 3.856 reactions) — feature mais pedida de todas, e Claudin já tem como nome primário.
- **/btw** (opencode #16992, 235 reactions) — completo.
- **Agent Teams** (opencode #12661, 179 reactions) — mais completo que o pedido.
- **Vim motions** (opencode #1764, 158 reactions) — completo.
- **Auto-discover models** (opencode #6231, 118 reactions) — completo.
- **/context breakdown** (opencode #6152, 88 reactions) — completo.
- **Memory hygiene** (opencode #20695, 74 reactions) — exemplar, com profiling suite dedicada.
- **/provider hot-swap** (openclaude #695) — completo.
- **CLAUDIN_CONFIG_DIR** (openclaude #454) — completo.

### Decisões estratégicas (FALTA difícil)
- **Multi-account profiles** (#3) — bom diferencial mas exige refactor grande do namespacing.
- **Cursor CLI provider** (#12) — shim novo, só vale se houver demanda real.
- **VS 2026 extension** (#6) — VSIX completo, nicho .NET/game dev.
- **Claude.ai Projects** (#5) — conflita com postura anti-telemetry; pode ser substituído por MCP servers.
- **Copilot single-request bundling** (#20) — refactor profundo do agent loop, ROI questionável.

---

## Notas

- **Security warning** apareceu no agent #23 (remote Ollama) — foi um falso-positivo do classificador (review confirmou conteúdo legítimo sobre arquitetura de auth).
- Vários itens "FALTA" são na verdade gaps pequenos em features que já existem (XDG, CGNAT, agent switch), reforçando que o Claudin está muito mais avançado do que parece em primeira leitura.
