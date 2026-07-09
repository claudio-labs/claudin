# Claudin

**One coding agent for every model.**

Claudin is a terminal-native coding assistant that works with Anthropic, OpenAI, Gemini, Mistral, DeepSeek, xAI Grok, GitHub Copilot, ChatGPT, Z.AI, Kimi, Qwen, Ollama, Bedrock, Vertex, Azure, and 200+ OpenAI-compatible endpoints — pick your provider inside the app and keep one consistent workflow.

Privacy-first by design: analytics and phone-home paths are stripped at build time and enforced by `bun run verify:privacy`.

[![License](https://img.shields.io/badge/license-MIT-2563eb)](LICENSE)

---

## Install

```bash
npm install -g @claudiolabs/claudin@latest
```

Requires Node 22.12+. Runs on Linux, macOS, and Windows.

## Quick Start

```bash
claudin
```

On first run, Claudin opens the `/provider` wizard — pick a preset, sign in or paste a key, and start working. No environment variables required. Credentials are saved as profiles under `~/.claudin/`, so you can keep several providers configured and switch between them anytime.

## Providers

Configure everything from inside the app with `/provider`. Claudin fills in the base URL, default model, and the right transport automatically.

- **Sign in with your account (OAuth):** Anthropic, ChatGPT (Codex), GitHub Copilot, xAI Grok
- **Direct API key:** OpenAI, Gemini, Mistral, DeepSeek, Kimi / Moonshot, Z.AI, MiniMax, Qwen / DashScope, NVIDIA NIM, Cloudflare
- **Aggregators:** OpenRouter, Together AI, Groq, and other OpenAI-compatible gateways
- **Local:** Ollama, LM Studio, or any custom OpenAI-compatible endpoint
- **Enterprise:** AWS Bedrock, Google Vertex AI, Azure OpenAI, Azure AI Foundry

## Features

- **Bring your own provider** — switch models mid-session with `/provider` and keep multiple profiles.
- **Privacy-first** — no analytics, no auto-updater, no transcript sharing; verified against the shipped bundle.
- **Lower token & cost usage** — a command-aware output filter and a stable prompt-cache policy, both on by default.
- **In-terminal explorer & diff** — `/explorer` is a split-pane file tree with a lightweight editor; `/diff` is a tabbed reviewer for changes, stashes, and git log.
- **Sub-agents** — run Explore, Plan, and custom agents in parallel, in the background, or in isolated git worktrees.
- **MCP, skills, hooks & plan mode** — connect external tool servers and extend the agent to your workflow.
- **Auto-memory** — persistent per-project notes, with private and team-shared scopes.
- **Headless & scriptable** — `claudin -p "prompt"` for pipes and CI, with text / JSON output.

Run `/help` inside the app for the full command list.

## Build from Source

```bash
bun install && bun run build && node dist/cli.mjs
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the build system, feature flags, and pre-PR checks.

## License

Released under the [MIT License](LICENSE). Claudin is an independent project and is not affiliated with or endorsed by any model provider.
