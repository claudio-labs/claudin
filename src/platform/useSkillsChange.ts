import { useCallback, useEffect } from 'react'
import type { Command } from 'src/commands/commands.js'
import { clearCommandsCache, getCommands } from 'src/commands/commands.js'
import { logError } from 'src/shared/log.js'
import { skillChangeDetector } from 'src/skills/skillChangeDetector.js'

/**
 * Keep the commands list fresh when skill files change on disk (watcher):
 * full cache clear + disk re-scan, since skill content changed.
 */
export function useSkillsChange(
  cwd: string | undefined,
  onCommandsChange: (commands: Command[]) => void,
): void {
  const handleChange = useCallback(async () => {
    if (!cwd) return
    try {
      // Clear all command caches to ensure fresh load
      clearCommandsCache()
      const commands = await getCommands(cwd)
      onCommandsChange(commands)
    } catch (error) {
      // Errors during reload are non-fatal - log and continue
      if (error instanceof Error) {
        logError(error)
      }
    }
  }, [cwd, onCommandsChange])

  useEffect(() => skillChangeDetector.subscribe(handleChange), [handleChange])
}
