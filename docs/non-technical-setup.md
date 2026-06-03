# Claudin for Non-Technical Users

This guide is for people who want the easiest setup path.

You do not need to build from source. You do not need Bun. You do not need to understand the full codebase.

If you can copy and paste commands into a terminal, you can set this up.

## What Claudin Does

Claudin lets you use an AI coding assistant with different model providers, including:

- Anthropic (Claude)
- OpenAI
- DeepSeek
- Gemini
- Mistral
- Ollama (local)
- Codex (ChatGPT)
- GitHub Copilot

Pick whichever you have access to. For most first-time users, Anthropic or OpenAI is the easiest cloud option, and Ollama is the easiest local option.

## Before You Start

You need:

1. Node.js 20 or newer installed
2. A terminal window
3. An API key or login from your provider, unless you are using a local model like Ollama

## Fastest Path

1. Install Claudin with npm
2. Run `claudin`
3. Follow the `/provider` wizard that opens on first run

There are no environment variables to set.

## Choose Your Operating System

- Windows: [Windows Quick Start](quick-start-windows.md)
- macOS / Linux: [macOS / Linux Quick Start](quick-start-mac-linux.md)

## Which Provider Should You Choose?

### Anthropic

Choose this if:

- you want the official Claude experience
- you have a Claude account or an Anthropic API key

The wizard supports both API key and a web sign-in flow.

### OpenAI

Choose this if:

- you already have an OpenAI API key

### Ollama

Choose this if:

- you want to run models locally
- you do not want to depend on a cloud API for testing

### Codex

Choose this if:

- you have a ChatGPT or Codex account
- you want to log in via the browser

### GitHub Copilot

Choose this if:

- you have a Copilot subscription tied to your GitHub account

## What Success Looks Like

After you run `claudin`, the `/provider` wizard opens. Once you save a profile, the CLI starts and waits for your prompt.

At that point, you can ask it to:

- explain code
- edit files
- run commands
- review changes

## Common Problems

### `claudin` command not found

Cause:

- npm installed the package, but your terminal has not refreshed yet

Fix:

1. Close the terminal
2. Open a new terminal
3. Run `claudin` again

### Invalid API key

Cause:

- the key is wrong, expired, or copied incorrectly

Fix:

1. Run `/provider` inside Claudin
2. Edit the active profile and paste a fresh key

### A provider stops working

Run `/provider doctor` inside Claudin. It checks reachability, auth, and model availability for the active profile.

### Ollama not working

Cause:

- Ollama is not installed or not running

Fix:

1. Install Ollama from `https://ollama.com/download`
2. Start Ollama
3. Run `/provider doctor` inside Claudin

## Want More Control?

If you want source builds, multi-profile workflows, custom headers, OAuth flows, or migration from a legacy `~/.claude/`, use:

- [Advanced /provider Usage](advanced-setup.md)
