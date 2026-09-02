# Claudin Quick Start for Windows

This guide uses Windows PowerShell.

## 1. Install Node.js

Install Node.js 20 or newer from:

- `https://nodejs.org/`

Then open PowerShell and check it:

```powershell
node --version
npm --version
```

## 2. Install Claudin

```powershell
npm install -g @claudiolabs/claudin
```

## 3. Run Claudin

```powershell
claudin
```

On first run with no saved profile, the `/provider` wizard opens automatically. Pick a preset (Anthropic, OpenAI, DeepSeek, Gemini, Mistral, Ollama, Codex, GitHub Copilot, Bedrock, Vertex, Foundry, or Custom), supply credentials when prompted, and Claudin saves it as the active profile.

If you previously used Claude Code (or an older Claudin that lived under `~/.claude/`), the wizard offers to copy your sign-in — API tokens and provider profiles — into `%USERPROFILE%\.claudin\`. Accept or skip; your choice is remembered. Run `/import` afterwards for skills, MCP servers, agents and commands.

## 4. Reconfigure Later

Inside the REPL:

- `/provider` — list, edit, switch, or add profiles
- `/provider doctor` — health check the active profile
- `/provider migrate` — rerun the legacy `~/.claude/` sign-in migration (tokens and provider profiles only)
- `/import` — copy MCP servers, skills, subagents and commands in from another agent (Claude Code, Codex, Gemini, Qwen, opencode, Kimi, Cursor). Never copies credentials — sign in with `/provider`.

## 5. Common Recipes

### Anthropic API

`/provider` -> preset `anthropic` -> choose `API key` -> paste key.

### Anthropic OAuth (web sign-in)

`/provider` -> preset `anthropic` -> choose `Sign in with web`. The flow opens in your browser and stores tokens under `%USERPROFILE%\.claudin\.credentials.json`.

### OpenAI / DeepSeek / Groq / OpenRouter

`/provider` -> matching preset (or `custom` for any OpenAI-compatible `/v1` server) -> paste API key and model.

### Local Ollama

Install Ollama from `https://ollama.com/download/windows`, pull a model (e.g. `ollama pull llama3.1:8b`), then inside Claudin run `/provider` -> preset `ollama`. No API key required.

### LM Studio

Start the LM Studio server with a model loaded, then `/provider` -> preset `custom` (or `lmstudio` if listed) -> set `baseUrl` to `http://localhost:1234/v1` and the model name shown in LM Studio.

## 6. If `claudin` Is Not Found

Close PowerShell, open a new one, and try again:

```powershell
claudin
```

## 7. If a Provider Fails

Run `/provider doctor` from inside the REPL. It reports reachability, auth, and model availability for the active profile.

## 8. Updating Claudin

```powershell
npm install -g @claudiolabs/claudin@latest
```

## 9. Uninstalling Claudin

```powershell
npm uninstall -g @claudiolabs/claudin
```

Claudin config lives in `%USERPROFILE%\.claudin\`. Remove that directory to wipe all saved profiles, tokens, and settings.

## Need Advanced Setup?

Use:

- [Advanced Setup](advanced-setup.md)
