import { getSettingsForSource, updateSettingsForSource } from 'src/platform/settings/settings.js'

/** What the user said about the project servers a dialog listed. */
export type ApprovalAnswer = {
  approve: readonly string[]
  reject: readonly string[]
  enableAll: boolean
}

/** The local settings layer's own lists, never the merged view of every layer. */
export type LocalLists = {
  enabled: readonly string[]
  disabled: readonly string[]
}

export type LocalListsUpdate = {
  enabledMcpjsonServers?: string[]
  disabledMcpjsonServers?: string[]
  enableAllProjectMcpServers?: true
}

export type LocalListsPort = {
  readLocalLists(): LocalLists
  writeLocalLists(update: LocalListsUpdate): void
}

/** `undefined` when nothing in `added` is new to `list`. */
function appendNew(list: readonly string[], added: readonly string[]): string[] | undefined {
  const next = [...list]
  for (const name of added) {
    if (!next.includes(name)) next.push(name)
  }
  return next.length === list.length ? undefined : next
}

/** The keys to merge into the local file, or null when the answer changes nothing there. */
export function localListsUpdate(answer: ApprovalAnswer, current: LocalLists): LocalListsUpdate | null {
  const update: LocalListsUpdate = {}
  const enabled = appendNew(current.enabled, answer.approve)
  const disabled = appendNew(current.disabled, answer.reject)
  if (enabled) update.enabledMcpjsonServers = enabled
  if (disabled) update.disabledMcpjsonServers = disabled
  if (answer.enableAll) update.enableAllProjectMcpServers = true
  return Object.keys(update).length === 0 ? null : update
}

const localSettingsPort: LocalListsPort = {
  readLocalLists() {
    const local = getSettingsForSource('localSettings')
    return { enabled: local?.enabledMcpjsonServers ?? [], disabled: local?.disabledMcpjsonServers ?? [] }
  },
  writeLocalLists(update) {
    // A failed write (a local file that is not JSON) is logged by the writer and
    // leaves the file as it was; the server simply stays pending.
    updateSettingsForSource('localSettings', update)
  },
}

export function applyApprovalAnswer(answer: ApprovalAnswer, port: LocalListsPort = localSettingsPort): void {
  const update = localListsUpdate(answer, port.readLocalLists())
  if (update) port.writeLocalLists(update)
}
