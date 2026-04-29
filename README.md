# Claudio

Claudio is an open-source coding-agent CLI for cloud and local model providers.

Use OpenAI-compatible APIs, Gemini, GitHub Models, Codex OAuth, Codex, Ollama, Atomic Chat, and other supported backends while keeping one terminal-first workflow: prompts, tools, agents, MCP, slash commands, and streaming output.

[![Security Policy](https://img.shields.io/badge/security-policy-0f766e)](SECURITY.md)
[![License](https://img.shields.io/badge/license-MIT-2563eb)](LICENSE)

[Quick Start](#quick-start) | [Setup Guides](#setup-guides) | [Providers](#supported-providers) | [Source Build](#source-build-and-local-development) | [VS Code Extension](#vs-code-extension) | [Sponsors](#sponsors) | [Community](#community)

## Sponsors

<p align="center">
  <a href="https://gitlawb.com">
    <img src="https://gitlawb.com/logo.png" alt="GitLawb logo" width="96">
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://bankr.bot">
    <img src="https://bankr.bot/favicon.svg" alt="Bankr.bot logo" width="96">
  </a>
</p>

<p align="center">
  <a href="https://gitlawb.com"><strong>GitLawb</strong></a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://bankr.bot"><strong>Bankr.bot</strong></a>
</p>

## Why Claudio

- Use one CLI across cloud APIs and local model backends
- Configure providers and models entirely from inside the app via `/provider`
- Run with OpenAI-compatible services, Anthropic, Gemini, Mistral, GitHub Copilot, Codex OAuth, Ollama, Bedrock, Vertex, Foundry, and other supported providers
- Keep coding-agent workflows in one place: bash, file tools, grep, glob, agents, tasks, MCP, and web tools
- Use the bundled VS Code extension for launch integration and theme support

## Quick Start

### Install

```bash
npm install -g @gitlawb/claudio
```

If the install later reports `ripgrep not found`, install ripgrep system-wide and confirm `rg --version` works in the same terminal before starting Claudio.

### Start

```bash
claudio
```

On first run with no saved profile, Claudio opens the `/provider` wizard automatically. Pick a preset, paste credentials when prompted, and start working — no environment variables required.

To reconfigure later from inside the REPL:

- `/provider` — list, edit, switch, and add provider profiles
- `/provider doctor` — health check the active profile (reachability, auth, model availability)
- `/provider migrate` — rerun the legacy `~/.claude/` migration (see below)

### Available presets

`/provider` ships with presets for common providers:

- `anthropic` (API key or OAuth web sign-in)
- `openai` and OpenAI-compatible: `deepseek`, `kimi-code`, `moonshotai`, `together`, `groq`, `openrouter`, `lmstudio`, `dashscope-cn`, `dashscope-intl`, `nvidia-nim`, `minimax`, `bankr`, `atomic-chat`
- `gemini`
- `mistral`
- `ollama` (local, no key required)
- `codex` (ChatGPT OAuth)
- `github-copilot` (GitHub OAuth device flow)
- `bedrock` (AWS region in profile, AWS credential chain)
- `vertex` (GCP project + region in profile, Application Default Credentials)
- `foundry` (Azure resource in profile, `DefaultAzureCredential`)
- `custom` (any OpenAI-compatible base URL, e.g. a LiteLLM proxy)

### Configuration directory

Claudio stores credentials, settings, and OAuth tokens under `~/.claudio/`. On first run, `/provider` detects a legacy `~/.claude/` from Claude Code (or `~/.openclaude/` from earlier builds) and offers to migrate tokens, settings, theme, plugins, and keybindings. You can also rerun the migration manually with `/provider migrate`.

Override the location with `CLAUDIO_CONFIG_DIR=/path/to/dir`.

### Using Ollama's launch command

If you have [Ollama](https://ollama.com) installed and prefer a one-shot command, the launch helper points Claudio at your local model and starts the REPL:

```bash
ollama launch claudio --model qwen2.5-coder:7b
```

It writes a temporary Ollama profile via `/provider` so the next manual `claudio` run keeps using the same setup.

## Setup Guides

Beginner-friendly guides:

- [Non-Technical Setup](docs/non-technical-setup.md)
- [Windows Quick Start](docs/quick-start-windows.md)
- [macOS / Linux Quick Start](docs/quick-start-mac-linux.md)

Advanced and source-build guides:

- [Advanced Setup](docs/advanced-setup.md)
- [Android Install](ANDROID_INSTALL.md)

## Supported Providers

All providers are configured through `/provider`. Pick a preset, supply credentials when prompted, and switch profiles at any time.

| Provider | Setup |
| --- | --- |
| Anthropic | `/provider` → preset `anthropic` (API key or OAuth web sign-in) |
| OpenAI-compatible | `/provider` → presets `openai`, `deepseek`, `kimi-code`, `together`, `groq`, `openrouter`, `lmstudio`, `dashscope-cn`, `dashscope-intl`, `nvidia-nim`, `minimax`, `bankr`, `atomic-chat`, or `custom` for any OpenAI-compatible `/v1` server |
| Gemini | `/provider` → preset `gemini` (API key or access token) |
| Mistral | `/provider` → preset `mistral` |
| GitHub Copilot | `/provider` → preset `github-copilot` (GitHub OAuth device flow) |
| Codex OAuth | `/provider` → preset `codex` (ChatGPT sign-in) |
| Ollama | `/provider` → preset `ollama` (local, no API key) |
| Bedrock | `/provider` → preset `bedrock` (AWS region in profile, native AWS credential chain) |
| Vertex | `/provider` → preset `vertex` (GCP project + region, Application Default Credentials) |
| Foundry | `/provider` → preset `foundry` (Azure resource, `DefaultAzureCredential`) |

## What Works

- **Tool-driven coding workflows**: Bash, file read/write/edit, grep, glob, agents, tasks, MCP, and slash commands
- **Streaming responses**: Real-time token output and tool progress
- **Tool calling**: Multi-step tool loops with model calls, tool execution, and follow-up responses
- **Images**: URL and base64 image inputs for providers that support vision
- **Provider profiles**: Multi-profile setup managed entirely from `/provider`, persisted under `~/.claudio/settings.json`
- **Local and remote model backends**: Cloud APIs, local servers, and Apple Silicon local inference

## Provider Notes

Claudio supports multiple providers, but behavior is not identical across all of them.

- Anthropic-specific features may not exist on other providers
- Tool quality depends heavily on the selected model
- Smaller local models can struggle with long multi-step tool flows
- Some providers impose lower output caps than the CLI defaults, and Claudio adapts where possible

For best results, use models with strong tool/function calling support.

## Provider Profiles and Switching

All sessions and sub-agents use the active provider profile. Switch profiles at any time inside the REPL with `/provider`. Profiles persist under `~/.claudio/settings.json`.

> **Note:** API keys saved in `~/.claudio/settings.json` are stored in plaintext. Keep this file private and do not commit it to version control.

## Web Search and Fetch

By default, `WebSearch` works on non-Anthropic models using DuckDuckGo. This gives GPT-4o, DeepSeek, Gemini, Ollama, and other OpenAI-compatible providers a free web search path out of the box.

> **Note:** DuckDuckGo fallback works by scraping search results and may be rate-limited, blocked, or subject to DuckDuckGo's Terms of Service. If you want a more reliable supported option, configure Firecrawl.

For Anthropic-native backends and Codex responses, Claudio keeps the native provider web search behavior.

`WebFetch` works, but its basic HTTP plus HTML-to-markdown path can still fail on JavaScript-rendered sites or sites that block plain HTTP requests.

Set a [Firecrawl](https://firecrawl.dev) API key if you want Firecrawl-powered search/fetch behavior:

```bash
export FIRECRAWL_API_KEY=your-key-here
```

With Firecrawl enabled:

- `WebSearch` can use Firecrawl's search API while DuckDuckGo remains the default free path for non-Claude models
- `WebFetch` uses Firecrawl's scrape endpoint instead of raw HTTP, handling JS-rendered pages correctly

Free tier at [firecrawl.dev](https://firecrawl.dev) includes 500 credits. The key is optional.

---

## Headless gRPC Server

Claudio can be run as a headless gRPC service, allowing you to integrate its agentic capabilities (tools, bash, file editing) into other applications, CI/CD pipelines, or custom user interfaces. The server uses bidirectional streaming to send real-time text chunks, tool calls, and request permissions for sensitive commands.

### 1. Start the gRPC Server

Start the core engine as a gRPC service on `localhost:50051`:

```bash
npm run dev:grpc
```

#### Configuration

| Variable | Default | Description |
|-----------|-------------|------------------------------------------------|
| `GRPC_PORT` | `50051` | Port the gRPC server listens on |
| `GRPC_HOST` | `localhost` | Bind address. Use `0.0.0.0` to expose on all interfaces (not recommended without authentication) |

### 2. Run the Test CLI Client

We provide a lightweight CLI client that communicates exclusively over gRPC. It acts just like the main interactive CLI, rendering colors, streaming tokens, and prompting you for tool permissions (y/n) via the gRPC `action_required` event.

In a separate terminal, run:

```bash
npm run dev:grpc:cli
```

*Note: The gRPC definitions are located in `src/proto/claudio.proto`. You can use this file to generate clients in Python, Go, Rust, or any other language.*

---

## Source Build And Local Development

```bash
bun install
bun run build
node dist/cli.mjs
```

Helpful commands:

- `bun run dev`
- `bun test`
- `bun run test:coverage`
- `bun run security:pr-scan -- --base origin/main`
- `bun run smoke`
- `bun run typecheck`
- `bun run verify:privacy`
- focused `bun test ...` runs for the areas you touch

## Testing And Coverage

Claudio uses Bun's built-in test runner for unit tests.

Run the full unit suite:

```bash
bun test
```

Generate unit test coverage:

```bash
bun run test:coverage
```

Open the visual coverage report:

```bash
open coverage/index.html
```

If you already have `coverage/lcov.info` and only want to rebuild the UI:

```bash
bun run test:coverage:ui
```

Use focused test runs when you only touch one area:

- `bun run test:provider`
- `bun test path/to/file.test.ts`

Recommended contributor validation before opening a PR:

- `bun run build`
- `bun run smoke`
- `bun run test:coverage` for broader unit coverage when your change affects shared runtime or provider logic
- focused `bun test ...` runs for the files and flows you changed

Coverage output is written to `coverage/lcov.info`, and Claudio also generates a git-activity-style heatmap at `coverage/index.html`.
## Repository Structure

- `src/` - core CLI/runtime
- `scripts/` - build, verification, and maintenance scripts
- `docs/` - setup, contributor, and project documentation
- `python/` - standalone Python helpers and their tests
- `vscode-extension/claudio-vscode/` - VS Code extension
- `.github/` - repo automation, templates, and CI configuration
- `bin/` - CLI launcher entrypoints

## VS Code Extension

The repo includes a VS Code extension in [`vscode-extension/claudio-vscode`](vscode-extension/claudio-vscode) for Claudio launch integration, provider-aware control-center UI, and theme support.

## Security

If you believe you found a security issue, see [SECURITY.md](SECURITY.md).

## Contributing

Contributions are welcome.

For larger changes, open an issue first so the scope is clear before implementation. Helpful validation commands include:

- `bun run build`
- `bun run test:coverage`
- `bun run smoke`
- focused `bun test ...` runs for files and flows you changed


## Disclaimer

Claudio is an independent community project and is not affiliated with, endorsed by, or sponsored by Anthropic.

Claudio originated from the Claude Code codebase and has since been substantially modified to support multiple providers and open use. "Claude" and "Claude Code" are trademarks of Anthropic PBC. See [LICENSE](LICENSE) for details.

## License

See [LICENSE](LICENSE).
