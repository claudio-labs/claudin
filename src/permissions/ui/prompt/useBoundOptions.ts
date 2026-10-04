import { boundOptionFor, isListKey } from 'src/permissions/ui/prompt/answerModel.js'
import type { PermissionPromptOption } from 'src/permissions/ui/PermissionPrompt.js'
import { useInput } from 'src/terminal/ink.js'
import { useOptionalKeybindingContext } from 'src/terminal/keybindings/KeybindingContext.js'
import type { KeybindingContextName } from 'src/terminal/keybindings/types.js'

/**
 * Answers with an option whenever the action it is bound to fires in the
 * `Confirmation` context, wherever the pointer is. A key the option list
 * itself uses never counts, whatever it is bound to: Enter is `confirm:yes`,
 * Tab `confirm:nextField` and space `confirm:toggle` by default, so a bound
 * option would otherwise answer for a key meant for the list.
 *
 * `isActive` is false while a note is being typed, so its letters stay text.
 */
export function useBoundOptions<T extends string>(
  options: readonly PermissionPromptOption<T>[],
  choose: (value: T) => void,
  isActive: boolean,
): void {
  const keybindings = useOptionalKeybindingContext()
  const hasBound = options.some(option => option.keybinding !== undefined)

  useInput(
    (input, key, event) => {
      if (!keybindings || isListKey(input, key)) return
      const contexts = new Set<KeybindingContextName>([...keybindings.activeContexts, 'Confirmation', 'Global'])
      const result = keybindings.resolve(input, key, [...contexts])
      if (result.type !== 'match') return
      const option = boundOptionFor(options, result.action)
      if (!option) return
      choose(option.value)
      event.stopImmediatePropagation()
    },
    { isActive: isActive && hasBound },
  )
}
