import { getCurrentProjectConfig, saveCurrentProjectConfig } from 'src/platform/config/config.js'
import { isClaudeAIMcpServerName } from 'src/mcp/normalization.js'

type ToggleList = 'enabledMcpServers' | 'disabledMcpServers'

/**
 * The one list that governs a server. claude.ai connectors are opt-in, so
 * they are listed when switched on; every other server is listed when off.
 */
function governingList(name: string): { list: ToggleList; listedMeansEnabled: boolean } {
  return isClaudeAIMcpServerName(name)
    ? { list: 'enabledMcpServers', listedMeansEnabled: true }
    : { list: 'disabledMcpServers', listedMeansEnabled: false }
}

export function isMcpServerDisabled(name: string): boolean {
  const { list, listedMeansEnabled } = governingList(name)
  const listed = (getCurrentProjectConfig()[list] ?? []).includes(name)
  return listed !== listedMeansEnabled
}

export function setMcpServerEnabled(name: string, enabled: boolean): void {
  const { list, listedMeansEnabled } = governingList(name)
  const shouldBeListed = enabled === listedMeansEnabled
  // Returning the same object tells the config store there is nothing to write.
  saveCurrentProjectConfig(project => {
    const names = project[list] ?? []
    if (names.includes(name) === shouldBeListed) return project
    return { ...project, [list]: shouldBeListed ? [...names, name] : names.filter(listed => listed !== name) }
  })
}
