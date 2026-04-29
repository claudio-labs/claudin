import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { getLspServerRows, type LspServerRow } from '../../services/lsp/builtinServers.js'
import { LspListPanel } from './LspListPanel.js'
import { LspServerMenu } from './LspServerMenu.js'

type LspViewState = { type: 'list' } | { type: 'server-menu'; server: LspServerRow }

type Props = {
  onComplete: (result?: string) => void
}

export function LspSettings({ onComplete }: Props): React.ReactNode {
  const [viewState, setViewState] = useState<LspViewState>({ type: 'list' })
  const [rows, setRows] = useState<LspServerRow[]>([])

  const refresh = useCallback(() => {
    getLspServerRows().then(setRows).catch(() => setRows([]))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  if (viewState.type === 'server-menu') {
    return (
      <LspServerMenu
        server={viewState.server}
        onCancel={() => {
          refresh()
          setViewState({ type: 'list' })
        }}
        onComplete={(msg) => {
          refresh()
          onComplete(msg)
        }}
      />
    )
  }

  return (
    <LspListPanel
      rows={rows}
      onSelectServer={(server) => setViewState({ type: 'server-menu', server })}
      onComplete={onComplete}
    />
  )
}
