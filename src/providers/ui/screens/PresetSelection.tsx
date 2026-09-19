import * as React from 'react'
import { SearchableSelect } from 'src/terminal/custom-select/index.js'
import { Box, Text } from 'src/terminal/ink.js'
import { isBareMode } from 'src/shared/envUtils.js'
import {
  getActiveProviderProfile,
  type ProviderPreset,
} from 'src/providers/presets/providerProfiles.js'
import {
  formatMigrationReport,
  legacyClaudeDirExists,
  migrateLegacyClaudeDir,
} from 'src/platform/config/claudinMigration.js'
import type {
  ProviderManagerResult,
  Screen,
} from 'src/providers/ui/ProviderManager.types.js'

// The provider-preset list: the first screen of the first-run wizard and the
// "Add provider" entry of the manage menu. It owns no state — the preset rows
// are a literal table, and every selection hands off to a ProviderManager
// callback.
//
// The body below carries the indentation it had as a nested `render*` function
// inside ProviderManager: the move is checked mechanically by
// scripts/migrations/verify-relocation.ts, which compares line multisets, and
// re-indenting would turn a provable relocation into an unreviewable rewrite.

export type PresetSelectionScreenProps = {
  mode: 'first-run' | 'manage'
  onDone: (result?: ProviderManagerResult) => void
  canImportLegacyClaude: boolean
  setScreen: (screen: Screen) => void
  setCanImportLegacyClaude: (value: boolean) => void
  setErrorMessage: (message: string | undefined) => void
  setStatusMessage: (message: string | undefined) => void
  closeWithCancelled: (message: string) => void
  refreshProfiles: () => void
  returnToMenu: () => void
  startCreateFromPreset: (preset: ProviderPreset) => void
}

export function PresetSelectionScreen({
  mode,
  onDone,
  canImportLegacyClaude,
  setScreen,
  setCanImportLegacyClaude,
  setErrorMessage,
  setStatusMessage,
  closeWithCancelled,
  refreshProfiles,
  returnToMenu,
  startCreateFromPreset,
}: PresetSelectionScreenProps): React.ReactNode {
    const canUseCodexOAuth = !isBareMode()
    // Providers sorted alphabetically by label. `Custom` is pinned to the end
    // because it's the catch-all / escape hatch — users scanning the list
    // should always find known providers first. `Skip for now` (first-run
    // only) comes last, after Custom.
    const options = [
      ...(canImportLegacyClaude
        ? [
            {
              value: 'import-legacy',
              label: 'Reuse Claude Code sign-in',
              description:
                'Copy ~/.claude/ API tokens and provider profiles. /import brings the rest.',
            },
          ]
        : []),
      {
        value: 'dashscope-intl',
        label: 'Alibaba Coding Plan',
        description: 'Alibaba DashScope International endpoint',
      },
      {
        value: 'dashscope-cn',
        label: 'Alibaba Coding Plan (China)',
        description: 'Alibaba DashScope China endpoint',
      },
      {
        value: 'anthropic',
        label: 'Anthropic',
        description: 'Native Claude API (x-api-key auth)',
      },
      {
        value: 'atomic-chat',
        label: 'Atomic Chat',
        description: 'Local Model Provider',
      },
      {
        value: 'azure-openai',
        label: 'Azure OpenAI',
        description: 'Azure OpenAI endpoint (model=deployment name)',
      },
      {
        value: 'foundry',
        label: 'Azure AI Foundry',
        description: 'Anthropic models hosted on Azure AI Foundry (resource-scoped)',
      },
      {
        value: 'bedrock',
        label: 'AWS Bedrock',
        description: 'Anthropic models on AWS Bedrock (region-scoped, AWS creds)',
      },
      {
        value: 'bankr',
        label: 'Bankr',
        description: 'Bankr LLM Gateway (OpenAI-compatible)',
      },
      {
        value: 'cloudflare-workers-ai',
        label: 'Cloudflare Workers AI',
        description:
          'Cloudflare Workers AI (OpenAI-compatible); set your account ID in the base URL',
      },
      {
        value: 'cloudflare-ai-gateway',
        label: 'Cloudflare AI Gateway',
        description:
          'Cloudflare AI Gateway unified endpoint; set your account ID in the base URL',
      },
      ...(canUseCodexOAuth
        ? [
            {
              value: 'codex-oauth',
              label: 'Codex OAuth',
              description:
                'Sign in with ChatGPT in your browser and store Codex credentials securely',
            },
            {
              value: 'xai-oauth',
              label: 'xAI / Grok (OAuth)',
              description:
                'Sign in with xAI in your browser and store Grok credentials securely',
            },
          ]
        : []),
      {
        value: 'github-onboard',
        label: 'GitHub Copilot',
        description: 'Sign in with GitHub in your browser to use Copilot models',
      },
      {
        value: 'deepseek',
        label: 'DeepSeek',
        description: 'DeepSeek OpenAI-compatible endpoint',
      },
      {
        value: 'gemini',
        label: 'Google Gemini',
        description: 'Gemini OpenAI-compatible endpoint',
      },
      {
        value: 'vertex',
        label: 'Google Vertex AI',
        description: 'Anthropic models on Vertex AI (project + region, ADC)',
      },
      {
        value: 'groq',
        label: 'Groq',
        description: 'Groq OpenAI-compatible endpoint',
      },
      {
        value: 'lmstudio',
        label: 'LM Studio',
        description: 'Local LM Studio endpoint',
      },
      {
        value: 'minimax',
        label: 'MiniMax',
        description: 'MiniMax API endpoint',
      },
      {
        value: 'mistral',
        label: 'Mistral',
        description: 'Mistral OpenAI-compatible endpoint',
      },
      {
        value: 'moonshotai',
        label: 'Moonshot AI',
        description: 'API key or Kimi Code OAuth sign-in',
      },
      {
        value: 'nvidia-nim',
        label: 'NVIDIA NIM',
        description: 'NVIDIA NIM endpoint',
      },
      {
        value: 'opencode-go',
        label: 'OpenCode GO',
        description: 'OpenCode GO OpenAI-compatible endpoint',
      },
      {
        value: 'opencode-zen',
        label: 'OpenCode Zen',
        description: 'OpenCode Zen OpenAI-compatible endpoint',
      },
      {
        value: 'ollama',
        label: 'Ollama',
        description: 'Local or remote Ollama endpoint',
      },
      {
        value: 'openai',
        label: 'OpenAI',
        description: 'OpenAI API with API key',
      },
      {
        value: 'openrouter',
        label: 'OpenRouter',
        description: 'OpenRouter OpenAI-compatible endpoint',
      },
      {
        value: 'together',
        label: 'Together AI',
        description: 'Together chat/completions endpoint',
      },
      {
        value: 'zai',
        label: 'Z.AI (GLM Coding Plan)',
        description: 'Z.AI GLM Coding Plan (OpenAI-compatible)',
      },
      {
        value: 'custom',
        label: 'Custom',
        description: 'Any OpenAI-compatible provider',
      },
      ...(mode === 'first-run'
        ? [
            {
              value: 'skip',
              label: 'Skip for now',
              description: 'Continue with current defaults',
            },
          ]
        : []),
    ]

    return (
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>
          {mode === 'first-run' ? 'Set up provider' : 'Choose provider preset'}
        </Text>
        <Text dimColor>
          Pick a preset, then confirm base URL, model, and API key.
        </Text>
        <SearchableSelect
          options={options}
          searchPlaceholder="Search presets…"
          onChange={(value: string) => {
            if (value === 'skip') {
              closeWithCancelled('Provider setup skipped')
              return
            }
            if (value === 'codex-oauth') {
              setScreen('codex-oauth')
              return
            }
            if (value === 'xai-oauth') {
              setScreen('xai-oauth')
              return
            }
            if (value === 'moonshotai') {
              setScreen('kimi-auth-choice')
              return
            }
            if (value === 'github-onboard') {
              setScreen('github-onboard')
              return
            }
            if (value === 'import-legacy') {
              void (async () => {
                const report = await migrateLegacyClaudeDir({ force: true })
                setCanImportLegacyClaude(legacyClaudeDirExists())
                refreshProfiles()
                const summary = formatMigrationReport(report)
                if (report.errors.length > 0) {
                  setErrorMessage(summary)
                  return
                }
                const active = getActiveProviderProfile()
                if (mode === 'first-run' && active) {
                  onDone({
                    action: 'saved',
                    activeProfileId: active.id,
                    activeProviderName: active.name,
                    activeProviderModel: active.model,
                    message: summary,
                  })
                  return
                }
                setStatusMessage(summary)
                setErrorMessage(undefined)
                if (mode === 'manage') returnToMenu()
              })()
              return
            }
            startCreateFromPreset(value as ProviderPreset)
          }}
          onCancel={() => {
            if (mode === 'first-run') {
              closeWithCancelled('Provider setup skipped')
              return
            }
            returnToMenu()
          }}
          visibleOptionCount={Math.min(13, options.length)}
        />
      </Box>
    )
}
