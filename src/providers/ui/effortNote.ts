import { ollamaThinkingIsToggleOnly } from 'src/providers/model/ollamaModelInfo.js'

/**
 * The line the pickers show when a model offers no effort level. An Ollama
 * model that thinks but only on or off is not "not supported": its control is
 * the Thinking toggle in /config, which reaches it as `reasoning_effort: none`.
 *
 * @param model the model id the info was read for
 * @param subject how the line names the model ("this model", a picker label);
 *   omitted, the line names nothing
 */
export function effortUnavailableNote(model: string | undefined, subject?: string): string {
  const named = subject ? ` for ${subject}` : ''
  if (model && ollamaThinkingIsToggleOnly(model)) {
    return `Thinking only turns on or off${named} · /config → Thinking`
  }
  return `Effort not supported${named}`
}
