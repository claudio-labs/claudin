
<h1 align="center"><img src="https://www.claudiolabs.ai/img/icon.png" alt="" width="38" align="middle" /> Claudin</h1>

<p align="center">
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-22.12+-339933?style=flat-square&logo=node.js&logoColor=white" />
  <a href="https://github.com/claudio-labs/claudin/actions/workflows/pr-checks.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/claudio-labs/claudin/pr-checks.yml?branch=main&style=flat-square&label=CI" /></a>
  <img alt="release" src="https://img.shields.io/npm/v/@claudiolabs/claudin?style=flat-square&label=release&color=CB3837" />
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-2563eb?style=flat-square" /></a>
  <a href="https://github.com/claudio-labs/claudin/issues"><img alt="Issues" src="https://img.shields.io/github/issues/claudio-labs/claudin?style=flat-square&color=f59e0b" /></a>
  <a href="https://github.com/claudio-labs/claudin/pulls"><img alt="Pull requests" src="https://img.shields.io/github/issues-pr/claudio-labs/claudin?style=flat-square&color=8b5cf6" /></a>
  <a href="SECURITY.md"><img alt="Security policy" src="https://img.shields.io/badge/security-policy-0ea5e9?style=flat-square" /></a>
</p>

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

## Documentation

Full documentation lives at **[claudiolabs.ai/docs](https://www.claudiolabs.ai/docs/)**.

- [Install](https://www.claudiolabs.ai/install) — platform binaries, the Node fallback, and first run.
- [Providers](https://www.claudiolabs.ai/providers) — every preset, OAuth vs. API key, local endpoints.
- [Migrating from Claude Code](https://www.claudiolabs.ai/migrate-from-claude-code) — what carries over and what changes.
- [Configuration](https://www.claudiolabs.ai/docs/configuration) — settings, permissions, and interface options.
- [Agents](https://www.claudiolabs.ai/docs/agents) and [workflows](https://www.claudiolabs.ai/docs/workflows) — sub-agents, isolated worktrees, and the self-hosted background agent.
- [Skills](https://www.claudiolabs.ai/docs/skills), [plugins](https://www.claudiolabs.ai/docs/plugins), [MCP](https://www.claudiolabs.ai/docs/mcp), and [hooks](https://www.claudiolabs.ai/docs/hooks) — extend the agent.
- [Automation](https://www.claudiolabs.ai/docs/automation) — headless `claudin -p` for pipes and CI.
- [Cache policy](https://www.claudiolabs.ai/docs/cache-policy) and the [bash output filter](https://www.claudiolabs.ai/docs/bash-output-filter) — the token and cost behavior that ships on by default.

Run `/help` inside the app for the full command list.

## Build from Source

```bash
bun install && bun run build && node dist/cli.mjs
```

### Dev binary (`claudindev`)

Local checkouts only produce a dev binary — the stable release is never
built locally, it comes from npm. To work with both:

```bash
npm install -g @claudiolabs/claudin@latest   # stable release → `claudin`
bun run link:dev                              # local build    → `claudindev`
```

`link:dev` symlinks `<repo>/bin/claudin` as `claudindev` in `~/.bun/bin` or
`~/.local/bin`, so `claudin` stays pinned to the published release while
`claudindev` picks up every `bun run build` from your checkout.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the build system, feature flags, and pre-PR checks.

## Screenshot

Launching Claudin shows the active provider, model, and effort in the banner and in
the footer, so you can tell at a glance which build and profile you are on:

![The Claudin welcome banner and footer, showing provider, model, effort, working directory, and git branch](docs/img/claudin-welcome.png)

## License

Released under the [MIT License](LICENSE). Claudin is an independent project and is not affiliated with or endorsed by any model provider.
