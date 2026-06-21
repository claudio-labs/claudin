import * as React from 'react'
import type { LocalJSXCommandCall } from '../../types/command.js'

export const call: LocalJSXCommandCall = async (onDone, context) => {
  const { ExplorerDialog } = await import(
    '../../components/explorer/ExplorerDialog.js'
  )
  return <ExplorerDialog onDone={onDone} context={context} />
}
