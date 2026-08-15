import * as React from 'react'
import type { LocalJSXCommandCall } from 'src/types/command.js'

export const call: LocalJSXCommandCall = async (onDone, context) => {
  const { DiffDialog } = await import('src/vcs/diff/ui/DiffDialog.js')
  return <DiffDialog messages={context.messages} onDone={onDone} />
}
