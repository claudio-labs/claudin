/**
 * Whether auto memory is on. Read on every call, never cached.
 *
 *   CLAUDIN_DISABLE_AUTO_MEMORY  truthy turns memory off; an off value (0,
 *                                false, no, off) forces it on over every
 *                                other rule; anything else decides nothing.
 *   CLAUDIN_SIMPLE               bare mode, which turns memory off.
 *   CLAUDE_CODE_REMOTE           a remote session, off unless
 *   CLAUDE_CODE_REMOTE_MEMORY_DIR  mounts a memory directory.
 */
import { getInitialSettings } from 'src/platform/settings/settings.js'
import {
  isBareMode,
  isEnvDefinedFalsy,
  isEnvTruthy,
} from 'src/shared/envUtils.js'

type AutoMemoryInputs = {
  readonly disableSwitch: string | undefined
  readonly bareMode: boolean
  readonly remoteSession: boolean
  readonly remoteMemoryDir: string | undefined
  /** `autoMemoryEnabled` from the merged settings; read only when reached. */
  readonly readSetting: () => boolean | undefined
}

function decideAutoMemory(inputs: AutoMemoryInputs): boolean {
  if (isEnvTruthy(inputs.disableSwitch)) return false
  if (isEnvDefinedFalsy(inputs.disableSwitch)) return true
  if (inputs.bareMode) return false
  if (inputs.remoteSession && !inputs.remoteMemoryDir) return false
  return inputs.readSetting() ?? true
}

export function isAutoMemoryEnabled(): boolean {
  return decideAutoMemory({
    disableSwitch: process.env.CLAUDIN_DISABLE_AUTO_MEMORY,
    bareMode: isBareMode(),
    remoteSession: isEnvTruthy(process.env.CLAUDE_CODE_REMOTE),
    remoteMemoryDir: process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR,
    // Every layer counts here, the project's checked-in file included, so a
    // repository can opt itself out of memory.
    readSetting: () => getInitialSettings().autoMemoryEnabled,
  })
}
