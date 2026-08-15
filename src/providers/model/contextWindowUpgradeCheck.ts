import { checkOpus1mAccess, checkSonnet1mAccess } from 'src/providers/model/check1mAccess.js'
import {
  getCanonicalName,
  getDefaultOpusModel,
  getDefaultSonnetModel,
  getUserSpecifiedModelSetting,
} from 'src/providers/model/model.js'

// @[MODEL LAUNCH]: Add a branch for the new model if it supports a 1M context upgrade path.
/**
 * Get available model upgrade for more context
 * Returns null if no upgrade available or user already has max context
 */
function getAvailableUpgrade(): {
  alias: string
  name: string
  multiplier: number
} | null {
  const currentModelSetting = getUserSpecifiedModelSetting()
  if (
    currentModelSetting === 'opus' &&
    checkOpus1mAccess() &&
    // Opus 5 (the 1P 'opus' default) is already 1M-native, so there is no 1M
    // upgrade to offer. Only 3P — where 'opus' resolves to Opus 4.6 (200k) —
    // has a real opus[1m] upgrade path.
    !getCanonicalName(getDefaultOpusModel()).includes('claude-opus-5')
  ) {
    return {
      alias: 'opus[1m]',
      name: 'Opus 1M',
      multiplier: 5,
    }
  } else if (
    currentModelSetting === 'sonnet' &&
    checkSonnet1mAccess() &&
    // Sonnet 5 (the 1P 'sonnet' default) is already 1M-native, so there is no
    // 1M upgrade to offer. Only 3P — where 'sonnet' resolves to Sonnet 4.5
    // (200k) — has a real sonnet[1m] upgrade path.
    !getCanonicalName(getDefaultSonnetModel()).includes('claude-sonnet-5')
  ) {
    return {
      alias: 'sonnet[1m]',
      name: 'Sonnet 1M',
      multiplier: 5,
    }
  }

  return null
}

/**
 * Get upgrade message for different contexts
 */
export function getUpgradeMessage(context: 'warning' | 'tip'): string | null {
  const upgrade = getAvailableUpgrade()
  if (!upgrade) return null

  switch (context) {
    case 'warning':
      return `/model ${upgrade.alias}`
    case 'tip':
      return `Tip: You have access to ${upgrade.name} with ${upgrade.multiplier}x more context`
    default:
      return null
  }
}
