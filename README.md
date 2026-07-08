# Claudin

A coding-agent CLI that works across many model providers — Anthropic, OpenAI, Gemini, Mistral, DeepSeek, xAI Grok, GitHub Copilot, ChatGPT, Z.AI, Moonshot/Kimi, Qwen, Cloudflare, Ollama, LM Studio, Bedrock, Vertex, Azure, and 20+ OpenAI-compatible endpoints — with one consistent terminal workflow.

Claudin is an open fork of the Claude Code agent loop (tools, MCP, sub-agents, slash commands, streaming), retargeted so the model and credentials are chosen entirely from inside the REPL with `/provider`. Telemetry and phone-home paths from upstream are stubbed out at build time and enforced by `bun run verify:privacy`.

[![License](https://img.shields.io/badge/license-MIT-2563eb)](LICENSE)

---

## Install

```bash
npm install -g @claudiolabs/claudin@latest
```

Requires Node 22.12+. Works on Linux, macOS, and Windows.

## Quick Start

```bash
claudin
```

On first run, Claudin opens the `/provider` wizard. Pick a preset, sign in or paste a key, and start working — no environment variables required. Credentials are saved as profiles under `~/.claudin/`, so you can keep several providers configured and switch between them at any time.

## Providers

Everything is configured from inside the REPL with `/provider` — pick a preset, and Claudin fills in the base URL, default model, and the right transport (Anthropic, OpenAI-compatible, Gemini, Bedrock, Vertex, Foundry, or Codex).

**Sign in with your account (OAuth):**

- **Anthropic** — API key or Claude web sign-in
- **ChatGPT** — Codex OAuth (use your ChatGPT plan)
- **GitHub Copilot** — device-flow OAuth
- **xAI Grok** — OAuth (loopback PKCE)

**Direct API key:**

- **OpenAI**
- **Google Gemini**
- **Mistral**
- **DeepSeek**
- **Moonshot AI** — Kimi Code + general API
- **Z.AI** — GLM Coding Plan
- **MiniMax**
- **Alibaba DashScope / Qwen** — China + International coding plans
- **NVIDIA NIM**
- **Cloudflare** — Workers AI + AI Gateway
- **Bankr**

**OpenAI-compatible aggregators:**

- OpenRouter, Together AI, Groq, OpenCode Zen, OpenCode GO, Atomic Chat

**Local:**

- Ollama, LM Studio, and any other OpenAI-compatible endpoint (**Custom**)

**Enterprise / cloud:**

- AWS Bedrock, Google Vertex AI, Azure OpenAI, Azure AI Foundry

Run `/provider doctor` to check your active profile, or `/provider migrate` to import a legacy `~/.claude/` config.

## Slash Commands

| Command | Description |
|---|---|
| `/provider` | Manage provider profiles and credentials |
| `/model` | Change the active model |
| `/explorer` | Browse the project tree and edit files (nvim-lite, split-pane) — `ctrl+e` |
| `/diff` | Review local changes, stashes, and git log in a tabbed viewer — `ctrl+g` |
| `/plan` | Enter plan mode (explore before coding) |
| `/review` | Code review |
| `/commit` | Commit changes |
| `/mcp` | Manage MCP servers |
| `/skills` | List and run user-invocable skills |
| `/create` | Create or refine skills, rules, and custom agents |
| `/memory` | View and manage project memory |
| `/hooks` | Configure event hooks |
| `/usage` / `/cost` | Token and cost tracking |
| `/config` | Settings |
| `/resume` | Resume a previous session |
| `/fast` | Toggle fast mode |
| `/help` | List all commands |

## Features

- **Bring your own provider** — one CLI for every major model provider; switch profiles mid-session with `/provider`.
- **Privacy-first** — analytics, auto-updater, and transcript-sharing paths are replaced with no-op stubs at build time; `bun run verify:privacy` scans the bundle to keep it that way.
- **Lower token & cost usage** — a command-aware Bash output filter strips noise before it reaches the model, and an Anthropic-aware prompt-cache policy keeps the cache prefix stable across turns. Both are on by default.
- **In-terminal explorer & diff** — `/explorer` is a split-pane file tree with a lightweight nvim-style editor; `/diff` is a tabbed reviewer for local changes, stashes, and git log.
- **Sub-agents & coordinator** — spawn specialized agents (Explore, Plan, and custom) in parallel, optionally in the background or in isolated git worktrees.
- **MCP** — connect external tool servers (filesystem, databases, APIs) with a trust dialog and OAuth support.
- **Skills, hooks & plan mode** — user-invocable `/skill` workflows, lifecycle hooks, and a plan-then-execute mode.
- **Auto-memory** — persistent per-project notes under `~/.claudin/projects/`, with private and shared-team scopes.
- **Headless / scriptable** — `claudin -p "prompt"` for pipes and CI, with `--output-format text|json|stream-json`.
- **Fast cold start** — a V8 bytecode cache trims warm-launch time; first run after a build repopulates it.
- **VS Code** — [extension](vscode-extension/claudin-vscode) for launch integration and themes.

## Source Build

```bash
bun install && bun run build && node dist/cli.mjs
```

Other commands:

```bash
bun run dev              # build + run
bun run smoke            # build + version check
bun test                 # full test suite
bun run typecheck        # tsc --noEmit
bun run verify:privacy   # scan for phone-home patterns
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the build system, feature flags, and pre-PR checks.

## Disclaimer

Claudin is an independent project and is not affiliated with, endorsed by, or sponsored by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic PBC.

## License

Released under the [MIT License](LICENSE).
