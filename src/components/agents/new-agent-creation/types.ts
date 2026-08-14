// Reconstructed from its use sites — the original module was not carried into
// this fork. Shapes come from the `updateWizardData({...})` payloads in
// `wizard-steps/*.tsx` and the reads in ConfirmStep/ConfirmStepWrapper.
import type { SettingSource } from 'src/utils/settings/constants.js'
import type { AgentColorName } from 'src/tools/AgentTool/agentColorManager.js'
import type { AgentMemoryScope } from 'src/tools/AgentTool/agentMemory.js'
import type { CustomAgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'
import type { generateAgent } from 'src/components/agents/generateAgent.js'

/** The agent object `generateAgent()` resolves to, without re-declaring it. */
export type GeneratedAgentDraft = Awaited<ReturnType<typeof generateAgent>>

/**
 * Data accumulated across the create-agent wizard steps.
 *
 * Every field is optional: `CreateAgentWizard` seeds `WizardProvider` with `{}`
 * and each step fills in its own slice via `updateWizardData`.
 */
export type AgentWizardData = {
  /** Where the agent file will be written — chosen in LocationStep. */
  location?: SettingSource
  /** 'generate' drives the LLM flow, anything else goes straight to PromptStep. */
  method?: 'generate' | 'manual'
  /** Free-text description fed to `generateAgent` in GenerateStep. */
  generationPrompt?: string
  /** True once GenerateStep has produced an agent. */
  wasGenerated?: boolean
  /** Set while GenerateStep awaits the model. */
  isGenerating?: boolean
  generatedAgent?: GeneratedAgentDraft
  /** The agent's identifier — TypeStep, or `generated.identifier`. */
  agentType?: string
  /** Description of when to use the agent — DescriptionStep. */
  whenToUse?: string
  /** System prompt body — PromptStep, or `generated.systemPrompt`. */
  systemPrompt?: string
  selectedTools?: string[]
  selectedModel?: string
  selectedColor?: AgentColorName
  selectedMemory?: AgentMemoryScope
  /**
   * Assembled in ColorStep and saved by ConfirmStepWrapper, which appends it to
   * `state.agentDefinitions.allAgents` — so it has to be a real agent definition.
   */
  finalAgent?: CustomAgentDefinition
}
