import { useRef, useState } from 'react'
import {
  AUTO_COMPACT_WINDOW_ENV,
  configuredAutoCompactWindow,
} from 'src/agent/compact/autoCompactWindow.js'
import {
  type AutoCompactChoice,
  autoCompactNotes,
  describeConfiguredWindow,
  initialDialogValue,
  saveAutoCompactWindow,
  stepAutoCompactWindow,
} from 'src/commands/autocompact/setting.js'
import { renderModelName } from 'src/providers/model/model.js'
import { formatTokens } from 'src/shared/text/format.js'
import { Byline } from 'src/terminal/design-system/Byline.js'
import { KeyboardShortcutHint } from 'src/terminal/design-system/KeyboardShortcutHint.js'
import { Box, Text, useInput } from 'src/terminal/ink.js'

type Props = {
  model: string
  onDone: (result: string) => void
  save?: (choice: AutoCompactChoice, model: string) => string
}

const label = (choice: AutoCompactChoice): string =>
  choice === 'auto' ? 'auto' : `${formatTokens(choice)} tokens`

export function AutoCompactDialog({ model, onDone, save = saveAutoCompactWindow }: Props) {
  const configured = configuredAutoCompactWindow(model)
  const locked = configured.source === 'env'
  const current = describeConfiguredWindow(model)
  const name = renderModelName(model)
  const [value, setValue] = useState(() => initialDialogValue(configured))
  // The start is snapped to the 100k grid, so compare with what is configured:
  // Enter on a snapped 250k → 300k applies the 300k on screen.
  const configuredChoice = configured.source === 'auto' ? 'auto' : configured.window
  const finished = useRef(false)
  const unchanged = `Auto-compact window for ${name} unchanged: ${current}`

  function finish(result: () => string): void {
    if (finished.current) return
    finished.current = true
    onDone(result())
  }

  useInput((_input, key) => {
    if (key.leftArrow && !locked) {
      setValue(v => stepAutoCompactWindow(v, -1))
    } else if (key.rightArrow && !locked) {
      setValue(v => stepAutoCompactWindow(v, 1))
    } else if (key.return) {
      finish(() => (locked || value === configuredChoice ? unchanged : save(value, model)))
    } else if (key.escape) {
      finish(() => unchanged)
    }
  })

  return (
    <Box flexDirection="column">
      <Box marginBottom={1} flexDirection="column">
        <Text color="remember" bold={true}>Auto-compact window</Text>
        <Text dimColor={true}>Current setting for {name}: {current}</Text>
      </Box>

      <Box marginBottom={1}>
        {locked ? (
          <Text color="warning">
            {AUTO_COMPACT_WINDOW_ENV} is set and takes precedence. Unset it to change this setting here.
          </Text>
        ) : (
          <Text>
            Select auto-compact window: <Text bold={true}>{label(value)}</Text>
          </Text>
        )}
      </Box>

      <Box marginBottom={1} flexDirection="column">
        {autoCompactNotes().map(note => (
          <Text key={note} dimColor={true}>{note}</Text>
        ))}
      </Box>

      <Box>
        <Text dimColor={true} italic={true}>
          <Byline>
            {!locked && <KeyboardShortcutHint shortcut="←/→" action="adjust" />}
            <KeyboardShortcutHint shortcut="Enter" action={locked ? 'close' : 'apply'} />
            <KeyboardShortcutHint shortcut="Esc" action="cancel" />
          </Byline>
        </Text>
      </Box>
    </Box>
  )
}
