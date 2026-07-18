
# <img src="site/img/icon.png" alt="" width="38" valign="middle" /> Claudin

![Node.js](https://img.shields.io/badge/Node.js-20+-339933?style=flat-square&logo=node.js&logoColor=white)
![npm](https://img.shields.io/npm/v/@claudiolabs/claudin?style=flat-square&label=npm&color=CB3837)
[![License](https://img.shields.io/badge/license-MIT-2563eb)](LICENSE)

**One coding agent CLI. Any LLM.**

Claudin brings a terminal-first agentic workflow — bash, file tools, grep, glob, agents, MCP, slash commands, streaming — to any model provider. Switch between OpenAI, Gemini, DeepSeek, Ollama, Mistral, GitHub Copilot, Bedrock, Vertex, and 200+ OpenAI-compatible endpoints without changing your workflow.

---

## Install

```bash
npm install -g @claudiolabs/claudin@latest
```

Runs on Linux, macOS, and Windows (x64 + arm64). Claudin installs a native
executable for your platform — `npm` downloads only the one matching package
(~68 MB), and `claudin` launches directly with no Node process in front of it
(~2× faster startup than the previous bundled build). On a platform without a
prebuilt binary, it transparently falls back to the bundled Node build (Node
22.12+ required for that path only).

**First run on macOS / Windows (unsigned binary).** The binaries are not yet
code-signed, so the OS may block the first launch:

- **macOS** (Gatekeeper "cannot be opened"): run
  `xattr -d com.apple.quarantine "$(which claudin)"` once, or approve it under
  System Settings → Privacy & Security → "Open Anyway".
- **Windows** (SmartScreen "unrecognized app"): click "More info" → "Run anyway"
  on the first launch.

## Quick Start

```bash
claudin
```

On first run, Claudin opens the `/provider` wizard — pick a preset, sign in or paste a key, and start working. No environment variables required. Credentials are saved as profiles under `~/.claudin/`, so you can keep several providers configured and switch between them anytime.

## Providers

Configure everything from inside the app with `/provider`. Claudin fills in the base URL, default model, and the right transport automatically.

- **Sign in with your account (OAuth):** Anthropic, ChatGPT (Codex), GitHub Copilot, xAI Grok, Kimi Code (Moonshot subscription)
- **Direct API key:** OpenAI, Gemini, Mistral, DeepSeek, Moonshot AI, Z.AI, MiniMax, Qwen / DashScope, NVIDIA NIM, Cloudflare
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
- **Self-hosted background agent** — `claudin workflow watch` polls GitHub for labeled issues and turns each into an isolated workflow run + PR, all on your own machine ([docs](docs/tech/background-agent/README.md)).

Run `/help` inside the app for the full command list.

## Build from Source

```bash
bun install && bun run build && node dist/cli.mjs
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the build system, feature flags, and pre-PR checks.

## License

Released under the [MIT License](LICENSE). Claudin is an independent project and is not affiliated with or endorsed by any model provider.
