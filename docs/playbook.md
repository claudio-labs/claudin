# Claudin Local Agent Playbook

This playbook is a practical guide to running Claudin with a local model (Ollama) and getting strong day-to-day results. All provider configuration goes through the `/provider` slash command inside the REPL.

## 1. What You Have

- A CLI agent loop that can read/write files, run terminal commands, and help with coding workflows.
- A multi-profile provider system managed entirely from `/provider`.
- Built-in health checks via `/provider doctor`.
- Profiles persisted under `~/.claudin/settings.json`.

## 2. Daily Start (Fast Path)

```bash
claudin
```

Claudin boots straight into the REPL with the active profile. Switch profiles, edit credentials, or add new ones with:

```
/provider
```

## 3. One-Time Setup

### 3.1 Pick a local model preset

Inside Claudin:

1. Run `/provider`
2. Pick `Add profile` -> preset `ollama`
3. Set the model (e.g. `llama3.1:8b` or `qwen2.5-coder:7b`)
4. Save and activate

No API key is required for Ollama. The base URL defaults to `http://localhost:11434/v1`.

### 3.2 Confirm Ollama is running

```bash
ollama --version
ollama serve
ollama pull llama3.1:8b
```

### 3.3 Validate the profile

Inside Claudin:

```
/provider doctor
```

The doctor reports reachability, auth, and model availability for the active profile.

## 4. Health and Diagnostics

`/provider doctor` is the single entry point for active-profile health checks. It probes the configured base URL, validates auth where applicable, and checks that the chosen model is reachable.

For project-wide validation:

```bash
bun run smoke
bun run typecheck
bun test
```

## 5. Provider Modes

### 5.1 Local mode (Ollama)

`/provider` -> preset `ollama` -> model `llama3.1:8b` (or any model you pulled).

Expected behavior:

- No API key required
- Base URL defaults to `http://localhost:11434/v1`

### 5.2 OpenAI mode

`/provider` -> preset `openai` -> paste API key -> set model (e.g. `gpt-4o`).

Expected behavior:

- API key required
- Empty or placeholder values are rejected

### 5.3 Anthropic (web sign-in)

`/provider` -> preset `anthropic` -> choose `Sign in with web`. Tokens are stored under `~/.claudin/.credentials.json`.

### 5.4 Codex (ChatGPT OAuth)

`/provider` -> preset `codex` -> follow the browser sign-in. Use models `codexplan` or `codexspark`.

### 5.5 GitHub Copilot

`/provider` -> preset `github-copilot` -> follow the GitHub device flow.

## 6. Troubleshooting Matrix

### 6.1 `claudin` command not found

Cause:

- npm global bin is not on `PATH`, or the terminal has not refreshed since install

Fix:

- Open a new terminal and run `claudin` again

### 6.2 Ollama not reachable

Cause:

- Ollama service is not running

Fix:

```bash
ollama serve
```

Then in Claudin, run `/provider doctor`.

### 6.3 Provider stops working mid-session

Run `/provider doctor`. The output points at the failing layer (network, auth, model).

### 6.4 Profile points at remote endpoint without a key

Open `/provider`, edit the profile, paste the missing API key, save.

### 6.5 Wrong model selected

Open `/provider`, edit the profile's `Model` field, save. The change applies to the next request.

## 7. Recommended Local Models

- Fast/general: `llama3.1:8b`
- Better coding quality (if hardware supports): `qwen2.5-coder:14b`
- Low-resource fallback: smaller instruct model

Switch model:

`/provider` -> edit Ollama profile -> change `Model` -> save.

## 8. Practical Prompt Playbook (Copy/Paste)

### 8.1 Code understanding

- "Map this repository architecture and explain the execution flow from entrypoint to tool invocation."
- "Find the top 5 risky modules and explain why."

### 8.2 Refactoring

- "Refactor this module for clarity without behavior change, then run checks and summarize diff impact."
- "Extract shared logic from duplicated functions and add minimal tests."

### 8.3 Debugging

- "Reproduce the failure, identify root cause, implement fix, and validate with commands."
- "Trace this error path and list likely failure points with confidence levels."

### 8.4 Reliability

- "Add runtime guardrails and fail-fast messages for invalid inputs."
- "Create a diagnostic command that outputs JSON report for CI artifacts."

### 8.5 Review mode

- "Do a code review of unstaged changes, prioritize bugs/regressions, and suggest concrete patches."

## 9. Safe Working Rules

- Run `/provider doctor` before debugging provider issues.
- Switch profiles via `/provider` rather than editing `~/.claudin/settings.json` by hand.
- Treat `~/.claudin/settings.json` as private — it stores plaintext API keys.

## 10. Quick Recovery Checklist

When something breaks, in order:

1. `/provider doctor`
2. `bun run smoke`
3. Check `ollama ps` (local Ollama only) — if `PROCESSOR` shows `CPU`, latency will be higher for large models
4. Restart Ollama if needed: `ollama serve`

## 11. Command Reference

```bash
# inside the REPL
/provider             # list, edit, switch, add profiles
/provider doctor      # health check active profile
/provider migrate     # rerun legacy ~/.claude/ sign-in migration (tokens only)
/import               # copy config in from another agent (never credentials)

# from the shell
claudin            # launch
bun run smoke         # build + version check
bun run typecheck     # tsc --noEmit
bun test              # full unit suite
bun run test:provider # provider integration tests
```

## 12. Success Criteria

Your setup is healthy when:

- `/provider doctor` passes reachability, auth, and model checks for the active profile
- `claudin` launches into the REPL with the expected model in the status line
- The model shown in the UI matches the active profile's `Model` field
