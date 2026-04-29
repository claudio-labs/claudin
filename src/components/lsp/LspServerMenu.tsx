import type React from 'react'
import { useState } from 'react'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Box, Text } from '../../ink.js'
import { installServer, type InstallProgress, type LspServerRow } from '../../services/lsp/builtinServers.js'
import { reinitializeLspServerManager } from '../../services/lsp/manager.js'
import { isLspGloballyEnabled } from '../../services/lsp/userSettings.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'
import { Select } from '../CustomSelect/index.js'
import { Byline } from '../design-system/Byline.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { getClaudioConfigHomeDir } from '../../utils/envUtils.js'

type Props = {
  server: LspServerRow
  onCancel: () => void
  onComplete: (result?: string) => void
}

function buildProgressBar(pct: number): string {
  const filled = Math.floor(pct / 5)
  const empty = 20 - filled
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${pct}%`
}

export function LspServerMenu({ server, onCancel, onComplete }: Props): React.ReactNode {
  const [progress, setProgress] = useState<InstallProgress | null>(null)

  const hasInstaller = server.installer !== 'manual (SDK)' && server.installer !== '—'
  const lspEnabled = isLspGloballyEnabled()

  type Option = { label: string; value: string }
  const menuOptions: Option[] = []

  if (hasInstaller && !server.found && lspEnabled) {
    menuOptions.push({ label: 'Install', value: 'install' })
  }
  if (hasInstaller && server.managed) {
    menuOptions.push({ label: 'Uninstall', value: 'uninstall' })
  }
  if (!server.disabled) {
    menuOptions.push({ label: 'Disable', value: 'disable' })
  } else {
    menuOptions.push({ label: 'Enable', value: 'enable' })
  }
  menuOptions.push({ label: 'Back', value: 'back' })

  const handleChange = async (value: string) => {
    if (value === 'back') {
      onCancel()
      return
    }

    if (value === 'install') {
      setProgress({ phase: 'download', pct: 0 })
      const ok = await installServer(server.name, (p) => setProgress(p))
      if (ok) {
        onComplete(`✓ ${server.name} installed`)
      } else {
        onComplete(`✗ failed to install ${server.name}`)
      }
      return
    }

    if (value === 'uninstall') {
      const dir = join(getClaudioConfigHomeDir(), 'lsp', server.name)
      await rm(dir, { recursive: true, force: true })
      reinitializeLspServerManager()
      onCancel()
      return
    }

    if (value === 'disable') {
      updateSettingsForSource('userSettings', {
        lsp: { [server.name]: { disabled: true } },
      })
      onCancel()
      return
    }

    if (value === 'enable') {
      updateSettingsForSource('userSettings', {
        lsp: { [server.name]: { disabled: undefined } },
      })
      onCancel()
      return
    }
  }

  if (progress !== null) {
    const pct = progress.phase === 'download' ? progress.pct : progress.phase === 'extract' ? 99 : progress.phase === 'done' ? 100 : 0
    const label =
      progress.phase === 'download'
        ? `Downloading ${server.name}...`
        : progress.phase === 'extract'
          ? `Extracting ${server.name}...`
          : progress.phase === 'done'
            ? `Installed ${server.name}`
            : `Failed to install ${server.name}`

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>
          {progress.phase === 'failed' ? 'Failed to install ' : 'Installing '}
          <Text bold>{server.name}</Text>
          {progress.phase === 'failed' ? '' : '...'}
        </Text>
        {progress.phase !== 'failed' && (
          <Text color="yellow">{buildProgressBar(pct)}</Text>
        )}
        <Text dimColor>{label}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" paddingX={1} borderStyle="round">
        <Box marginBottom={1}>
          <Text bold>{server.name}</Text>
          <Text dimColor>  {server.status}  {server.installer !== '—' ? `installer: ${server.installer}` : ''}</Text>
        </Box>
        {!lspEnabled && (
          <Box marginBottom={1}>
            <Text color="yellow">LSP is globally disabled. Enable LSP from the dashboard to install servers.</Text>
          </Box>
        )}
        <Select options={menuOptions} onChange={handleChange} onCancel={onCancel} />
      </Box>
      <Box marginTop={1}>
        <Text dimColor italic>
          <Byline>
            <KeyboardShortcutHint shortcut="↑↓" action="navigate" />
            <KeyboardShortcutHint shortcut="Enter" action="select" />
            <KeyboardShortcutHint shortcut="Esc" action="back" />
          </Byline>
        </Text>
      </Box>
    </Box>
  )
}
