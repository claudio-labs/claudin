import memoize from 'lodash-es/memoize.js'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'
import { logError } from 'src/shared/log.js'

export type Platform = 'macos' | 'windows' | 'wsl' | 'linux' | 'unknown'

export const SUPPORTED_PLATFORMS: Platform[] = ['macos', 'wsl']

export const getPlatform = memoize((): Platform => {
  try {
    if (process.platform === 'darwin') {
      return 'macos'
    }

    if (process.platform === 'win32') {
      return 'windows'
    }

    if (process.platform === 'linux') {
      // Check if running in WSL (Windows Subsystem for Linux)
      try {
        const procVersion = getFsImplementation().readFileSync(
          '/proc/version',
          { encoding: 'utf8' },
        )
        if (
          procVersion.toLowerCase().includes('microsoft') ||
          procVersion.toLowerCase().includes('wsl')
        ) {
          return 'wsl'
        }
      } catch (error) {
        // Error reading /proc/version, assume regular Linux
        logError(error)
      }

      // Regular Linux
      return 'linux'
    }

    // Unknown platform
    return 'unknown'
  } catch (error) {
    logError(error)
    return 'unknown'
  }
})
