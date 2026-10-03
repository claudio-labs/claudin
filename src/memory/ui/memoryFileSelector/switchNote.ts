/**
 * A switch shows the value in effect, which is not always the one it wrote:
 * `CLAUDIN_DISABLE_AUTO_MEMORY`, bare mode or a project, local or managed
 * setting outranks the user settings the switch writes to. Said only after a
 * write that did not take, so an unflipped switch reads as plain `on`/`off`.
 */
export function overrideNote(requested: boolean | undefined, effective: boolean): string {
  if (requested === undefined || requested === effective) return ''
  return ` · overridden by the environment or a project, local or managed setting`
}
