import * as React from 'react'
import type { LocalJSXCommandCall } from 'src/types/command.js'

export const call: LocalJSXCommandCall = async (onDone, context) => {
  const { ExplorerDialog } = await import(
    'src/terminal/explorer/ExplorerDialog.js'
  )
  return <ExplorerDialog onDone={onDone} context={context} />
}
