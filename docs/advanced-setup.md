# Claudin Advanced /provider Usage

This guide covers source builds, multi-profile workflows, custom headers, OAuth flows, migration from legacy `~/.claude/`, and the fresh-install wizard. Day-to-day setup goes through `/provider` inside the REPL — no environment variables required.

## Install Options

### Option A: npm

```bash
npm install -g @claudiolabs/claudin
```

### Option B: From source with Bun

Use Bun `1.3.11` or newer for source builds on Windows. Older Bun versions can fail during `bun run build`.

```bash
git clone <claudin-repo-url>
cd claudin

bun install
bun run build
npm link
```

### Option C: Run directly with Bun

```bash
git clone <claudin-repo-url>
cd claudin

bun install
bun run dev
```

## Configuration Directory

Claudin stores all credentials, settings, OAuth tokens, plugins, and keybindings under `~/.claudin/`. The directory layout matches the upstream Claude Code layout but is fully isolated, so Claudin and Claude Code can coexist on the same machine without overwriting each other.

Override the location with:

```bash
export CLAUDIN_CONFIG_DIR=/path/to/dir
```

## Fresh Install Wizard

On first run with no saved profile, Claudin opens the `/provider` wizard automatically before the REPL. Pick a preset, paste credentials when prompted, and the chosen profile is saved as the active one.

After that, `claudin` boots straight into the REPL. To reconfigure later:

- `/provider` — list, edit, switch, and add provider profiles
- `/provider doctor` — health check the active profile (reachability, auth, model availability)
- `/provider migrate` — rerun the legacy `~/.claude/` sign-in migration
- `/import` — copy config in from another AI coding agent

## Migrating a Claude Code Sign-In

If `~/.claude/` exists and `~/.claudin/` does not, the first `/provider` invocation shows a yellow banner offering to copy your sign-in across. It carries **only** what is needed to be logged in:

- Anthropic OAuth tokens (`.credentials.json`, `chmod 0600` after copy)
- Three settings keys — `providerProfiles`, `activeProviderProfileId` and `customApiKeyResponses` (the record of which API keys you already approved)
- The legacy global `~/.claude.json`, which holds the OAuth account identity

Everything else — `CLAUDE.md`, skills, agents, slash commands, plugins, MCP servers, keybindings, theme and the rest of your settings — is left in `~/.claude/` for `/import` to pick up. See [Importing From Another Agent](#importing-from-another-agent) below; it reads Claude Code too, so a full move is this migration followed by one `/import`.

The migration **copies** rather than moves — `~/.claude/` is left untouched. It is idempotent: running it again does not duplicate anything.

To rerun manually at any time:

```
/provider migrate
```

If you skip the banner, the choice is remembered and the banner is not shown again.

## Importing From Another Agent

`/import` is the general form, and it reads eight agents rather than only Claude Code: Claude Code, openclaude, OpenAI Codex, Gemini CLI, Qwen Code, opencode, Kimi CLI and Cursor. It finds the ones you have installed, shows what each can contribute — MCP servers, skills, subagents, slash commands, rules and instructions, settings — and lets you deselect anything before it writes.

Two things it deliberately does **not** do, and this is the difference from the migration above:

- **Credentials are never copied.** No `.credentials.json`, no `auth.json`. It names the file it found and points you at `/provider` to sign in. `/provider migrate` is the one path that does copy Claude Code's tokens.
- **Nothing is overwritten by default.** Anything you already have is reported as a conflict and left alone; overwriting is a separate, explicit choice on the confirmation screen. Running `/import` twice is a no-op.

Permissions and approval policies are counted and reported rather than translated — rule syntax differs between agents, and a wrong guess in a `deny` list is a permission silently granted.

## Multi-Profile Workflows

`/provider` supports any number of profiles. Common patterns:

- **Cost split** — a strong cloud profile (Anthropic, OpenAI, Codex) for hard sessions and a fast/cheap profile (DeepSeek, Ollama, Groq) for routine tasks.
- **Provider redundancy** — primary cloud profile plus a fallback on a different provider for outage windows.
- **Local vs remote** — local Ollama profile for offline work, cloud profile for connectivity-dependent tasks.
- **Role split** — separate profiles for `dev` and `review`, switched manually between sessions.

Profiles live under `providerProfiles[]` in `~/.claudin/settings.json`. The active profile is referenced by `activeProviderProfileId`. All sessions and sub-agents share the same active profile — there is no per-agent routing.

Switch between profiles at any time inside the REPL with `/provider`. The change takes effect on the next request.

## Provider-Specific Notes

### Anthropic

The `anthropic` preset offers two paths:

1. **Sign in with web** — embeds the OAuth flow in `/provider`. Tokens are written to `~/.claudin/.credentials.json`.
2. **API key** — paste your API key directly; saved on the profile.

Both paths produce a profile that is interchangeable with the rest of the REPL.

### Codex (ChatGPT OAuth)

The `codex` preset opens ChatGPT sign-in in your browser and stores the resulting tokens on the profile. If you already use the Codex CLI, Claudin can read `~/.codex/auth.json` automatically — point it elsewhere with the `Codex auth path` field on the profile.

`codexplan` maps to the Codex backend with high reasoning. `codexspark` maps to the faster Spark variant.

### GitHub Copilot

The `github-copilot` preset runs the GitHub OAuth device flow inline and stores the resulting token on the profile.

### Bedrock / Vertex / Foundry

These presets only collect routing info on the profile (AWS region, GCP project + region, Azure resource). Authentication uses the SDK's native credential chain:

- Bedrock — AWS credential chain (`~/.aws/credentials`, `aws sso`, `IAM Role`, etc.)
- Vertex — Application Default Credentials (`gcloud auth application-default login`)
- Foundry — `DefaultAzureCredential` (Azure CLI, managed identity, environment, etc.)

There are no provider-specific environment variables managed by Claudin in this path. Configure cloud credentials with the official tools.

### Ollama and other local servers

Local providers (Ollama, LM Studio, Atomic Chat, llama.cpp server) work without API keys. Pick the matching preset, or use `custom` and point `baseUrl` at your server's `/v1` endpoint.

### Custom (LiteLLM, custom proxies, OpenAI-compatible servers)

Use the `custom` preset for any OpenAI-compatible base URL. Set `baseUrl`, optionally `apiKey`, and the model alias your gateway exposes.

See [LiteLLM Setup](litellm-setup.md) for an end-to-end LiteLLM example.

## Custom Headers

The Anthropic preset includes a `Custom headers` field on the profile (one `Header: Value` per line). The headers are sent on every request from that profile. Use this for routing through proxies that require extra headers, or for tagging requests at a corporate gateway.

## /provider doctor

`/provider doctor` runs reachability + auth + model availability checks against the active profile. Useful when:

- a fresh profile fails to send its first message
- a previously working profile starts erroring out
- you want a one-shot before/after comparison after editing a profile

The doctor never mutates state — it only reports.

## Runtime Validation

```bash
# quick startup sanity check
bun run smoke

# project-wide TypeScript check
bun run typecheck

# privacy invariant (no telemetry / phone-home)
bun run verify:privacy

# unit suite
bun test

# focused provider tests
bun run test:provider
```
