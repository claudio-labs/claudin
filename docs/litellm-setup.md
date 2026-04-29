# LiteLLM Setup

Claudio can connect to LiteLLM through LiteLLM's OpenAI-compatible proxy.

## Overview

LiteLLM is an open-source LLM gateway that provides a unified API to 100+ model providers. By running the LiteLLM Proxy, you can route Claudio requests through LiteLLM to access any of its supported providers — all while using Claudio's existing OpenAI-compatible provider path.

## Prerequisites

- LiteLLM installed (`pip install litellm[proxy]`)
- A `litellm_config.yaml` or equivalent LiteLLM configuration
- LiteLLM Proxy running on a local or remote port

## 1. Start the LiteLLM Proxy

### Basic installation

```bash
pip install litellm[proxy]
```

### Configure LiteLLM

Create a `litellm_config.yaml` with your desired model aliases:

```yaml
model_list:
  - model_name: gpt-4o
    litellm_params:
      model: openai/gpt-4o
      api_key: os.environ/OPENAI_API_KEY

  - model_name: claude-sonnet-4
    litellm_params:
      model: anthropic/claude-sonnet-4-5-20250929
      api_key: os.environ/ANTHROPIC_API_KEY

  - model_name: gemini-2.5-flash
    litellm_params:
      model: gemini/gemini-2.5-flash
      api_key: os.environ/GEMINI_API_KEY

  - model_name: llama-3.3-70b
    litellm_params:
      model: together_ai/meta-llama/Llama-3.3-70B-Instruct-Turbo
      api_key: os.environ/TOGETHER_API_KEY
```

### Run the proxy

```bash
litellm --config litellm_config.yaml --port 4000
```

The proxy will start at `http://localhost:4000` by default.

## 2. Point Claudio to LiteLLM

LiteLLM is wired into Claudio through the `custom` preset (or any OpenAI-compatible preset) in `/provider`. There are no environment variables to set.

1. Run `claudio`
2. Type `/provider`
3. Pick `Add profile` -> preset `custom` (or `openai` and override the base URL)
4. Set the **Base URL** to `http://localhost:4000` (or wherever your proxy is running)
5. Set the **API key** to your LiteLLM master key, or any placeholder if your local proxy does not enforce auth
6. Set the **Model** to the alias you defined in `litellm_config.yaml` (for example, `gpt-4o`, `claude-sonnet-4`, or `gemini-2.5-flash`)
7. Save and activate the profile

To switch upstream providers, edit the profile and change the **Model** to a different LiteLLM alias. No restart needed beyond the next request.

## 3. Example LiteLLM Configs

### Multi-provider routing with spend tracking

```yaml
model_list:
  - model_name: gpt-4o
    litellm_params:
      model: openai/gpt-4o
      api_key: os.environ/OPENAI_API_KEY

  - model_name: claude-sonnet-4
    litellm_params:
      model: anthropic/claude-sonnet-4-5-20250929
      api_key: os.environ/ANTHROPIC_API_KEY

  - model_name: deepseek-chat
    litellm_params:
      model: deepseek/deepseek-chat
      api_key: os.environ/DEEPSEEK_API_KEY

litellm_settings:
  set_verbose: false
  num_retries: 3
```

### With a master key for auth

Start the proxy with a master key:

```bash
litellm --config litellm_config.yaml --port 4000 --master_key sk-my-master-key
```

Then in `/provider`, set the LiteLLM profile's **API key** to `sk-my-master-key` and **Base URL** to `http://localhost:4000`.

## 4. Notes

- The Claudio profile **Model** must match a `model_name` from your LiteLLM config, not the upstream raw provider model name.
- If your proxy requires authentication, use the proxy key (or `master_key`) as the profile's API key.
- LiteLLM's OpenAI-compatible endpoint accepts the same request format as OpenAI, so Claudio works without any code changes.
- Switch upstream providers by editing the profile's `Model` field — no need to reconfigure anything else.

## 5. Troubleshooting

| Issue | Likely Cause | Fix |
|-------|--------------|-----|
| 404 or Model Not Found | Model alias does not exist in LiteLLM config | Verify the `model_name` in `litellm_config.yaml` matches the profile's Model |
| Connection Refused | LiteLLM proxy is not running | Start the proxy with `litellm --config litellm_config.yaml --port 4000` |
| Auth Failed | Wrong or missing master key on the profile | Run `/provider`, edit the profile, paste the correct key |
| Upstream provider error | The backend provider key is missing or invalid | Ensure the upstream API key (e.g., `OPENAI_API_KEY`) is set in your LiteLLM proxy process environment |
| Tools fail but chat works | The selected model has weak function/tool calling support | Switch to a model with strong tool support (e.g., GPT-4o, Claude Sonnet) |

You can also run `/provider doctor` inside Claudio to check the active profile.

## 6. Resources

- [LiteLLM Proxy Docs](https://docs.litellm.ai/docs/proxy/quick_start)
- [LiteLLM Provider List](https://docs.litellm.ai/docs/providers)
- [LiteLLM OpenAI-Compatible Endpoints](https://docs.litellm.ai/docs/proxy/openai_compatible_proxy)
