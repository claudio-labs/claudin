---
name: LSPTool reintroduced 2026-06-17 (was empirically rejected) — cache-safe, plugin-only servers
description: LSPTool dropped 2026-05-28 (0 usage in 36 benches) then REINTRODUCED 2026-06-17 on feat/lsp-tool-reintroduce as a deliberate openclaude-shape match; read-only 9 ops, cache-stable, servers plugin-only
type: project
---

LSPTool (goToDefinition/references/hover/…) was removed in `ca54574f` after 0 usage, then **reintroduced 2026-06-17** on branch `feat/lsp-tool-reintroduce` at the user's explicit request to mirror the openclaude shape. The 0-usage finding still stands as the reason it stays `shouldDefer: true` (ToolSearch-surfaced, schema not in the main prompt).

**What shipped (current state):**
- `src/tools/LSPTool/` recovered from `ca54574f~1`, **stripped to the 9 read-only ops** (no write-ops: rename/applyCodeAction/renameFile/codeActions removed; writeOps.ts/writeOpPrep.ts/workspaceEdit.ts/codeActionCache.ts deleted). Registered via `getLSPTool()` in `src/tools.ts` getAllBaseTools.
- **Cache-safety (the hard requirement):** `isEnabled()` returns constant `true`; the tool is NOT flagged `isLsp` (so `shouldDeferLspTool` in streaming.ts never toggles its presence on LSP connect/disconnect → no prefix bust); all no-server/disabled/no-`getServerForFile` paths return a single module-level constant `LSP_UNAVAILABLE_MESSAGE` (no file/extension/timestamp interpolation) so repeated calls are byte-identical and keep cache warm.
- **Servers are plugin-only now (openclaude model):** deleted `src/services/lsp/builtinServers.ts` (the 12-server registry + auto-install) and the user-settings server path; `getAllLspServers` (config.ts) = `loadPluginLspServers()` only. `userSettings.ts` keeps only `isLspGloballyEnabled()` (`lsp.enabled`) + `lsp.diagnosticsTimeoutMs`.
- **Install/recommendation UI removed:** LspSettings/LspListPanel/LspServerMenu, LspRecommendationMenu + useLspPluginRecommendation hook, the `lsp-recommendation` focus dialog (getFocusedInputDialog.ts), and the dead `lspRecommendation.ts` util. Kept `useLspInitializationNotification` (status-only).
- Post-edit **diagnostics flow survives** (`diagnosticsForToolResult.ts`, fail-open) but now no-ops unless a plugin configures a server.

**Caveat preserved:** Tier 6 benches (`docs/archive/discovery/lsp-vs-grep-ground-truth/VERDICT.md`) showed LSP=0 calls vs Grep+Read, +57% cost. So the model likely still won't reach for it — that's intentional (it's deferred behind ToolSearch). Don't expect adoption; the value is parity + on-demand availability without cache cost.

**Validation:** build + smoke pass; focused LSP/config/userSettings/getFocusedInputDialog/lspDeferLatch tests pass; lazyToolModuleLoad baseline updated to include 'LSPTool'. Pre-existing unrelated failures in this env: REPL snapshot tests (committed snapshots hardcode old `projects/claudio` path) and `lazyToolImports.test.ts` cross-import audit (baseline drift from PermissionRuleInput.tsx etc.).
