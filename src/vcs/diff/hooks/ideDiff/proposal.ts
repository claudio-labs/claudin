import type { ConnectedMCPServer } from 'src/mcp/types.js'
import { WindowsToWSLConverter } from 'src/platform/ide/idePathConversion.js'
import { isENOENT } from 'src/shared/errors.js'
import { readFileSync } from 'src/shared/fs/fileRead.js'
import { expandPath } from 'src/shared/fs/path.js'
import { getPlatform } from 'src/shared/proc/platform.js'
import type { FileEdit } from 'src/tools/FileEditTool/types.js'
import { getPatchForEdits } from 'src/tools/FileEditTool/utils.js'

/** The file as it is, and as it would be with the edits applied. */
export type EditProposal = {
  absolutePath: string
  oldContent: string
  newContent: string
}

/**
 * Reads the file (CRLF read as LF, a missing file as empty) and applies the
 * edits by the edit tool's own rules. Throws when the file cannot be read or an
 * edit does not apply; nothing has been shown to the IDE at that point.
 */
export function proposeEdits(filePath: string, edits: FileEdit[]): EditProposal {
  const absolutePath = expandPath(filePath)
  const oldContent = readTextOrEmpty(absolutePath)
  const { updatedFile } = getPatchForEdits({ filePath: absolutePath, fileContents: oldContent, edits })
  return { absolutePath, oldContent, newContent: updatedFile }
}

function readTextOrEmpty(path: string): string {
  try {
    return readFileSync(path)
  } catch (error) {
    if (isENOENT(error)) return ''
    throw error
  }
}

/** The path as the IDE names it: a Windows IDE driving a WSL session needs its own form. */
export function pathForIde(localPath: string, ide: ConnectedMCPServer): string {
  const { config } = ide
  const ideOnWindows = (config.type === 'ws-ide' || config.type === 'sse-ide') && config.ideRunningInWindows === true
  const distro = process.env.WSL_DISTRO_NAME
  if (!ideOnWindows || !distro || getPlatform() !== 'wsl') return localPath
  return new WindowsToWSLConverter(distro).toIDEPath(localPath)
}
