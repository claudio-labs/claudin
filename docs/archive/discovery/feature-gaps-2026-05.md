# Gaps — Features que o Claudin NÃO tem (ou tem parcialmente)

Data: 2026-05-12
Filtrado de `feature-viability-2026-05.md` — só o que falta.

## 🟠 FALTA (fácil — quick wins)

### 1. `/cd` slash command para mudar cwd mid-session
- **Issue:** opencode-equivalent — usuários querem mudar diretório sem reabrir o REPL.
- **Estado:** infra existe — `setCwdState` em `src/platform/bootstrap/state.ts:515-521` já é usado pelo worktree mode.
- **Falta:** slash command que valide path e chame `setCwdState`.
- **Esforço:** ~30 linhas.

### 2. XDG Base Directory fallback
- **Issue:** usuários Linux pedem `$XDG_CONFIG_HOME/claudin` em vez de `~/.claudin`.
- **Estado:** helpers XDG **já existem** em `src/shared/fs/xdg.ts` mas não são consumidos.
- **Falta:** plugar em `resolveClaudinConfigHomeDir` (`src/shared/envUtils.ts:5-28`).
- **Esforço:** ~10 linhas.

### 3. Copy/paste do user prompt `>` vaza no clipboard
- **Issue:** quando usuário seleciona/copia transcript, o caractere `>` do prompt user vem junto.
- **Estado:** sistema `<NoSelect>` existe e já cobre o assistant prefix `●`.
- **Falta:** wrap do `>` em `src/components/messages/UserCommandMessage.tsx:47,84` e dos blocos de thinking em `HighlightedThinkingText.tsx:91,145`.
- **Esforço:** 4 linhas.

### 4. Per-model context window override
- **Issue:** openclaude #478 — usuários querem forçar context window menor (rate-limit) ou maior (modelos novos não detectados).
- **Estado:** `ProviderProfileExtras` em `src/platform/config/config.ts:208-228` não tem os campos.
- **Falta:** adicionar `contextWindow` / `maxOutputTokens` em `ProviderProfileExtras`, consumir em `withRetry.ts` e `context.ts`.
- **Esforço:** ~50 linhas.

### 5. CGNAT (Tailscale) em `isLocalProviderUrl`
- **Issue:** usuários Tailscale com IP 100.64.0.0/10 perdem otimizações local-provider (toolless retry, loopback retry).
- **Estado:** `src/services/api/providerConfig.ts:107-118` cobre 127/8, 192.168, 10/8, mas falta 100.64/10.
- **Falta:** adicionar range CGNAT.
- **Esforço:** 5 linhas.

> **Nota:** "always-show-thinking" como setting dedicado foi descartado — `verbose: true` já cobre o caso.

### 6. `/agents` mostrar e trocar agent ativo da sessão
- **Issue:** openclaude #526 — hoje `/agents` só gerencia sub-agents do Task tool.
- **Estado:** `src/commands/agents/agents.tsx`, `src/components/agents/AgentsMenuWithTabs.tsx`.
- **Falta:** header mostrando agent ativo + ação "switch active agent".
- **Esforço:** ~80 linhas no menu existente.

---

## 🟡 PARCIAL (existe mas dormente / incompleto)

### 7. Clean copy/paste (ver #3 acima)

### 8. Auto theme follow system
- **Estado:** `src/terminal/theme/systemTheme.ts` e `theme.ts` têm código de detecção (COLORFGBG, OSC 11 query). Está **dormente**.
- **Falta:** criar `systemThemeWatcher.ts` (watch loop), adicionar flag `AUTO_THEME` em `featureFlags` (`scripts/build.ts`), expor em `/config`.
- **Esforço:** médio (~150 linhas + plumbing).

### 9. Voice / STT input
- **Estado:** stack inteira existe em `src/terminal/voice/` e `src/terminal/voice/voiceStreamSTT.ts`. Flag `VOICE_MODE: false` em `scripts/build.ts:28`.
- **Falta (estrutural):** requer infra Anthropic (claude.ai OAuth + voice_stream WebSocket). **Não é Whisper local.**
- **Caminho aberto possível:** trocar backend pra Whisper local (whisper.cpp) ou OpenAI Whisper API — exige re-arquitetura do `voiceStreamSTT.ts`.
- **Esforço:** alto se for trocar backend.

### 10. Remote Ollama / Tailscale (parcial)
- **Estado:** funciona em LAN/Tailscale com API key vazia (`src/services/api/openaiShim.ts:1702-1731`).
- **Falta:** detecção CGNAT (ver #5 acima) para que retry loopback dispare.

### 11. Headless Codex/ChatGPT OAuth
- **Estado:** `src/services/api/codexOAuth.ts:183` funciona em WSL2 (localhost hairpin) e SSH com port-forward manual.
- **Falta:** device-code flow ou OOB — callback hoje exige `localhost:1455` no mesmo host do browser.
- **Workaround atual:** copiar `~/.codex/auth.json` de outra máquina.
- **Esforço:** médio (implementar device-code, depende de suporte do provider).

### 12. Tolerant tool-call parser (Ollama / modelos locais fracos)
- **Estado:** `src/services/api/openaiShim.ts:1097-1179` só parseia `delta.tool_calls` estruturado.
- **Falta:** sniffer no `content` para extrair JSON / XML-tag-style tool calls quando o modelo não emite o formato estruturado.
- **Esforço:** fácil-médio (~100 linhas), bem isolado.

---

## 🔴 FALTA (difícil — exige trabalho substancial)

### 13. Multi-account profile switching
- **Issue:** usuários querem N "perfis de usuário" (cada um com histórico, MCP, credenciais separados), não só N providers.
- **Estado:** `src/platform/config/config.ts:624-627` e `providerProfiles.ts` só fazem multi-provider; histórico/MCP/credenciais são globais.
- **Falta:** namespacing de `~/.claudin/projects/`, `.credentials.json`, MCP config por profile.
- **Esforço:** alto — refactor de paths em ~15-20 arquivos.
- **Workaround:** `CLAUDIN_CONFIG_DIR` env var por shell (já funciona).

### 14. Cursor CLI provider
- **Estado:** ausente. `src/services/api/providerConfig.ts:569` não tem.
- **Falta:** Cursor CLI **não é OpenAI-compat** — exige shim novo (tipo `codexShim.ts`).
- **Esforço:** alto, ROI questionável (demanda real?).

### 15. VS 2026 (full Visual Studio) extension
- **Estado:** `src/platform/ide/ide.ts` só suporta vscode + jetbrains.
- **Falta:** VSIX novo com modelo de extensão diferente de VS Code; `ideKind: 'visualstudio'` em toda a stack.
- **Esforço:** alto, nicho (.NET / game dev).

### 16. Claude.ai Projects integration
- **Estado:** ausente. Conflita com postura anti-telemetry do Claudin.
- **Aproximação possível:** MCP servers Drive/Notion/Gmail já existem via `claudeai-proxy`.
- **Decisão estratégica:** provavelmente **não fazer** (filosofia do projeto).

### 17. Copilot "One Premium Request per turn" (bundling)
- **Issue:** usuários Copilot batem na quota porque cada tool call = 1 request.
- **Estado:** `src/QueryEngine.ts` e `src/services/api/openaiShim.ts:1616` não fazem batching/coalescing.
- **Falta:** inlinar Haiku-summaries, cachear cadeias triviais, diferir sub-agent reports.
- **Esforço:** alto, refactor profundo do agent loop. ROI questionável fora de Copilot.

---

## Priorização sugerida

**Fazer já (sprint de quick wins — ~200 linhas total):**
1. `/cd` (#1)
2. XDG fallback (#2)
3. Copy/paste fix (#3)
4. CGNAT detection (#5/#10)

**Próximo (mid-effort, alto valor):**
5. Per-model context window (#4)
6. `/agents` switch ativo (#6)
7. AUTO_THEME (#8)
8. Tolerant tool-call parser (#12)

**Decisão estratégica antes de gastar esforço:**
9. Codex OAuth headless (#11) — quantos usuários SSH-only?
10. Voice backend troca (#9) — Whisper local vale o esforço?
11. Multi-account (#13) — `CLAUDIN_CONFIG_DIR` workaround é suficiente?

**Provavelmente não vale a pena:**
- Cursor CLI (#14) — esperar demanda
- VS 2026 (#15) — nicho
- Claude.ai Projects (#16) — conflito filosófico
- Copilot bundling (#17) — refactor enorme para um provider
