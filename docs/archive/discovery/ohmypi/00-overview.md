# Visão geral — omp vs Claudin

Snapshot: 2026-05-25. Repo omp em `/home/dev/projects/oh-my-pi`.

## 1. Tools

| | oh-my-pi | Claudin |
|---|---|---|
| Total | 32 built-in | ~25 built-in |
| Interface | `Tool` em `packages/agent/src/types.ts:390-433` | `buildTool` em `src/tools/Tool.ts` |
| Schemas | Zod | Zod v4 |
| Tool discovery | **BM25 dinâmico** (`tool-discovery/tool-index.ts`) | Tudo carregado sempre |
| Self-feedback | `report_tool_issue` com enum dinâmico | — |
| Shell | brush (Rust) vendored, PTY próprio | Bash externo + filtro |

## 2. Cache

| Camada | omp | Claudin |
|---|---|---|
| Bytecode | Bun compile cache + binários `--compile` | `~/.claudin/v8cache/` |
| Model metadata | SQLite (`packages/ai/src/model-cache.ts`) | runtime |
| HTTP externo | Two-tier soft/hard TTL (`tools/github-cache.ts`) | — |
| MCP tools | `mcp/tool-cache.ts` | reconecta por sessão |
| FS scan | Rust native (`crates/pi-natives/src/fs_cache.rs`) | Glob via Bun |
| Blob store | CAS (`session/blob-store.ts`) | — |

## 3. UI

| | omp | Claudin |
|---|---|---|
| Framework | Custom TUI TS puro (`packages/tui/`), diff writes, SGR/OSC8, Sixel/Kitty/iTerm2 images, FFI Windows console | Ink + React + yoga port |
| Streaming highlight | — | deferral on by default (vantagem Claudin) |

## 4. Agents

| | omp | Claudin |
|---|---|---|
| Loop | `agent-loop.ts` 1279 LOC + `agent.ts` 1192 | `QueryEngine.ts` |
| Sub-agent defs | `.md` bundled via text-import (`task/agents.ts:9-19`) | hard-coded (Explore/Code/Plan/WebResearcher) |
| Coordenação | `swarm-extension` extensível | `coordinator/` (flag on) |
| Worker isolation | APFS clone / btrfs/zfs reflink / overlayfs / projfs / rcopy | `EnterWorktreeTool` (git worktree) |

## 5. Provider

| | omp | Claudin |
|---|---|---|
| Providers | 40+ | ~comparável |
| Shim | `openai-anthropic-shim.ts` | `openaiShim.ts` ~2.2k linhas |
| HTTP/2 | `packages/ai/src/utils/h2-fetch.ts` (custom) | undici padrão |
| Auth | `auth-broker/` unificado | `providerConfig.ts` + `.credentials.json` |
| Modo proxy | `omp --mode rpc` / `acp` — serve Anthropic Messages + OpenAI Chat simultâneo | gRPC server (mais limitado) |

## 6. Runtime / outros

- 27k linhas de Rust (PTY, grep, glob, AST com 50+ tree-sitter grammars, tokens, html→md, SIXEL, iso). Claudin é 100% TS.
- Loopback Python↔Bun: kernel persistente Python pode chamar `read`/`search`/`task` do agente (REPL stateful).
- AGENTS.md deles é spec real (regras concretas tipo "use `Promise.withResolvers()`").
- Telemetry ON com OpenTelemetry — oposto da postura Claudin (`verify:privacy`).

## Ranking de retorno por esforço (subjetivo)

1. Two-tier TTL cache (WebFetch/WebSearch + provider metadata)
2. Prompts em `.md` via text-import
3. BM25 tool gating (opt-in)
4. `report_tool_issue` tool
5. Modo proxy multi-formato (expansão do gRPC)
6. CAS blob store (substitui `toolResultStorage`)
7. AST nativo via tree-sitter WASM (FileEditTool)
8. COW filesystem isolation (worktree)
9. h2-fetch (medir antes)
10. Inline terminal images
