# Claudio

Claudio is a coding-agent CLI that works across multiple model providers — Anthropic, OpenAI-compatible APIs, Gemini, GitHub Copilot, Ollama, Bedrock, Vertex, and more — with one consistent terminal workflow: prompts, tools, agents, MCP, and slash commands.

[![License](https://img.shields.io/badge/license-source--available-2563eb)](LICENSE)
[![Security Policy](https://img.shields.io/badge/security-policy-0f766e)](SECURITY.md)

---

## Install

```bash
npm install -g @claudiolabs/claudio@latest
```

Requires Node 20+. Works on Linux, macOS, and Windows.

## Start

```bash
claudio
```

On first run, Claudio opens the `/provider` wizard automatically. Pick a preset, enter credentials, and start working — no environment variables required.

## Providers

Configure providers from inside the REPL with `/provider`:

| Type | Presets |
|---|---|
| Anthropic | `anthropic` (API key or OAuth) |
| OpenAI-compatible | `openai`, `deepseek`, `groq`, `openrouter`, `lmstudio`, `together`, `nvidia-nim`, `atomic-chat`, and more |
| Google | `gemini` |
| Mistral | `mistral` |
| Local | `ollama` |
| ChatGPT | `codex` (OAuth) |
| GitHub | `github-copilot` (device flow) |
| Cloud | `bedrock`, `vertex`, `foundry` |
| Custom | any OpenAI-compatible base URL |

Run `/provider doctor` to check your active profile, or `/provider migrate` to import a legacy `~/.claude/` config.

## Slash Commands

| Command | Description |
|---|---|
| `/provider` | Manage provider profiles |
| `/plan` | Enter plan mode |
| `/review` | Code review |
| `/mcp` | Manage MCP servers |
| `/hooks` | Configure event hooks |
| `/usage` | Token and cost summary |
| `/config` | Settings |

## Source Build

```bash
bun install
bun run build
node dist/cli.mjs
```

Other useful commands:

```bash
bun run dev          # build + run
bun run smoke        # build + version check
bun test             # full test suite
bun run typecheck    # tsc --noEmit
bun run verify:privacy  # check for phone-home patterns
```

## VS Code Extension

The repo includes a VS Code extension at [`vscode-extension/claudio-vscode`](vscode-extension/claudio-vscode) for Claudio launch integration and theme support.

## Contributing

For larger changes, open an issue first. Run `bun run build`, `bun run smoke`, and `bun test` before opening a PR.

## Disclaimer

Claudio is an independent project and is not affiliated with, endorsed by, or sponsored by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic PBC.

## License

See [LICENSE](LICENSE). Free for personal and internal development use — redistribution and sale are not permitted.
