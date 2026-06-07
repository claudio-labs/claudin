# Claudin

A coding-agent CLI that works across multiple model providers — Anthropic, OpenAI, Gemini, Mistral, xAI Grok, GitHub Copilot, ChatGPT, Ollama, LM Studio, Bedrock, Vertex, Foundry, Azure, and 15+ OpenAI-compatible aggregators — with one consistent terminal workflow.

[![License](https://img.shields.io/badge/license-source--available-2563eb)](LICENSE)

---

## Install

```bash
npm install -g @claudiolabs/claudin@latest
```

Requires Node 20+. Works on Linux, macOS, and Windows.

## Quick Start

```bash
claudin
```

On first run, Claudin opens the `/provider` wizard. Pick a preset, enter credentials, and start working — no environment variables required.

## Providers

Configure from inside the REPL with `/provider`:

- **Anthropic** — API key or OAuth
- **OpenAI** — API key or any OpenAI-compatible base URL
- **OpenAI-compatible aggregators** — OpenRouter, Together, Groq, DeepSeek, Moonshot / Kimi, Alibaba DashScope (CN + Intl / Qwen), MiniMax, NVIDIA NIM, Atomic Chat, Bankr, opencode Zen, opencode Go
- **Google** — Gemini (API key, ADC, or OAuth)
- **Mistral** — API key
- **ChatGPT** — Codex OAuth
- **xAI** — Grok (device-flow OAuth)
- **GitHub** — Copilot (device flow)
- **Microsoft** — Azure OpenAI
- **Local** — Ollama, LM Studio
- **Cloud** — AWS Bedrock, Google Vertex AI, Azure AI Foundry
- **Custom** — any OpenAI-compatible endpoint

Run `/provider doctor` to check your active profile, or `/provider migrate` to import a legacy `~/.claude/` config.

## Slash Commands

| Command | Description |
|---|---|
| `/provider` | Manage provider profiles and credentials |
| `/model` | Change the active model |
| `/plan` | Enter plan mode (explore before coding) |
| `/review` | Code review |
| `/commit` | Commit changes |
| `/mcp` | Manage MCP servers |
| `/memory` | View and manage project memory |
| `/hooks` | Configure event hooks |
| `/usage` / `/cost` | Token and cost tracking |
| `/config` | Settings |
| `/resume` | Resume a previous session |
| `/fast` | Toggle fast mode |
| `/help` | List all commands |

## Features

- **Multi-provider** — one CLI, every major model provider
- **Tools** — file I/O, grep, glob, bash, web search/fetch, notebook editing
- **Sub-agents** — spawn specialized agents in parallel
- **MCP** — connect external tool servers (filesystem, databases, APIs)
- **Auto-memory** — persistent per-project notes under `~/.claudin/projects/`
- **gRPC headless** — run `claudin --grpc` for programmatic access
- **VS Code** — [extension](vscode-extension/claudin-vscode) for launch integration and themes

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

## Disclaimer

Claudin is an independent project and is not affiliated with, endorsed by, or sponsored by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic PBC.

## License

See [LICENSE](LICENSE). Free for personal and internal development use — redistribution and sale are not permitted.