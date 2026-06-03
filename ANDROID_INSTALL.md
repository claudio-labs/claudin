# Claudin on Android (Termux)

A complete guide to running Claudin on Android using Termux + proot Ubuntu.

---

## Prerequisites

- Android phone with ~700MB free storage
- [Termux](https://f-droid.org/en/packages/com.termux/) installed from **F-Droid** (not Play Store)
- An [OpenRouter](https://openrouter.ai) API key (free, no credit card required)

---

## Why This Setup?

Claudin requires [Bun](https://bun.sh) to build, and Bun does not support Android natively. The workaround is running a real Ubuntu environment inside Termux via `proot-distro`, where Bun's Linux binary works correctly.

---

## Installation

### Step 1 — Update Termux

```bash
pkg update && pkg upgrade
```

Press `N` or Enter for any config file conflict prompts.

### Step 2 — Install dependencies

```bash
pkg install nodejs-lts git proot-distro
```

Verify Node.js:
```bash
node --version  # should be v20+
```

### Step 3 — Clone Claudin

```bash
git clone <claudin-repo-url>
cd claudin
npm install
npm link
```

### Step 4 — Install Ubuntu via proot

```bash
proot-distro install ubuntu
```

This downloads ~200–400MB. Wait for it to complete.

### Step 5 — Install Bun inside Ubuntu

```bash
proot-distro login ubuntu
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
bun --version  # should show 1.3.11+
```

### Step 6 — Build Claudin

```bash
cd /data/data/com.termux/files/home/claudin
bun run build
```

You should see:
```
✓ Built claudin v0.1.6 → dist/cli.mjs
```

### Step 7 — Run Claudin

```bash
node dist/cli.mjs
```

On first run with no saved profile, the `/provider` wizard opens automatically. Configure OpenRouter:

1. Pick `Add profile`
2. Choose preset `openrouter` (or `custom` if not listed)
3. Set **Base URL** to `https://openrouter.ai/api/v1`
4. Paste your OpenRouter API key from [openrouter.ai/keys](https://openrouter.ai/keys)
5. Set **Model** to a free OpenRouter alias such as `qwen/qwen3.6-plus-preview:free`
6. Save and activate

The profile persists under `~/.claudin/settings.json` inside the proot Ubuntu environment, so you only need to do this once.

---

## Restarting After Closing Termux

Every time you reopen Termux after killing it, run:

```bash
proot-distro login ubuntu
cd /data/data/com.termux/files/home/claudin
node dist/cli.mjs
```

---

## Recommended Free Model

**`qwen/qwen3.6-plus-preview:free`** — Best free model on OpenRouter as of April 2026.

- 1M token context window
- Beats Claude 4.5 Opus on Terminal-Bench 2.0 agentic coding (61.6 vs 59.3)
- Built-in chain-of-thought reasoning
- Native tool use and function calling
- $0/M tokens (preview period)

> ⚠️ Free status may change when the preview period ends. Check [openrouter.ai](https://openrouter.ai/qwen/qwen3.6-plus-preview:free) for current pricing.

---

## Alternative Free Models (OpenRouter)

| Model ID | Context | Notes |
|---|---|---|
| `qwen/qwen3-coder:free` | 262K | Best for pure coding tasks |
| `openai/gpt-oss-120b:free` | 131K | OpenAI open model, strong tool calling |
| `nvidia/nemotron-3-super-120b-a12b:free` | 262K | Hybrid MoE, good general use |
| `meta-llama/llama-3.3-70b-instruct:free` | 66K | Reliable, widely tested |

Switch models anytime by running `/provider` inside Claudin, editing the OpenRouter profile, and changing the **Model** field.

---

## Why Not Groq or Cerebras?

Both were tested and fail due to Claudin's large system prompt (~50K tokens):

- **Groq free tier**: TPM limits too low (6K–12K tokens/min)
- **Cerebras free tier**: TPM limits exceeded, even on `llama3.1-8b`

OpenRouter free models have no TPM restrictions — only 20 req/min and 200 req/day.

---

## Tips

- **Don't swipe Termux away** from recent apps mid-session — use the home button to minimize instead.
- The Ubuntu environment persists between Termux sessions; your build and config are saved.
- Run `bun run build` again only if you pull updates to the Claudin repo.
