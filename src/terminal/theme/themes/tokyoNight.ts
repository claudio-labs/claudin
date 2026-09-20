import type { Theme } from 'src/terminal/theme/themes/types.js'

/**
 * Tokyo Night theme — deep navy with violet/blue accents
 * (https://github.com/folke/tokyonight.nvim). Explicit RGB for true-color terminals.
 */
export const tokyoNightTheme: Theme = {
  autoAccept: 'rgb(187,154,247)', // Magenta
  bashBorder: 'rgb(187,154,247)', // Magenta (mode accent — must not read as `error`)
  claude: 'ansi:redBright', // Claude orange — the dark-ansi one (follows the terminal palette)
  claudeShimmer: 'ansi:yellowBright', // Lighter claude orange for shimmer (dark-ansi)
  claudeBlue_FOR_SYSTEM_SPINNER: 'rgb(122,162,247)', // Blue
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'rgb(152,192,255)', // Lighter blue for shimmer
  permission: 'rgb(122,162,247)', // Blue (links/inline code, matches dark-ansi)
  permissionShimmer: 'rgb(152,192,255)', // Lighter blue for shimmer
  planMode: 'rgb(158,206,106)', // Green
  ide: 'rgb(86,110,160)', // Muted blue
  promptBorder: 'rgb(86,95,137)', // Comment
  promptBorderShimmer: 'rgb(116,125,167)', // Lighter comment for shimmer
  text: 'rgb(192,202,245)', // Foreground
  inverseText: 'rgb(26,27,38)', // Background
  inactive: 'rgb(115,120,132)', // Neutral gray (secondary/dim text — darker, matches dark-ansi feel)
  inactiveShimmer: 'rgb(150,156,170)', // Lighter for shimmer effect
  subtle: 'rgb(65,72,104)', // Terminal black
  suggestion: 'rgb(122,162,247)', // Blue
  remember: 'rgb(187,154,247)', // Magenta
  background: 'rgb(125,207,255)', // Cyan accent
  sidePanelBackground: 'rgb(33,34,48)', // One step off Tokyo Night's base
  success: 'rgb(158,206,106)', // Green
  error: 'rgb(247,118,142)', // Red
  spinnerStalled: 'ansi:redBright', // Stalled-spinner (mirrors error for ANSI, like dark-ansi)
  warning: 'rgb(224,175,104)', // Yellow
  merged: 'rgb(187,154,247)', // Magenta (matches autoAccept)
  warningShimmer: 'rgb(255,205,134)', // Lighter yellow for shimmer
  diffAdded: 'rgb(40,65,45)', // Dark green
  diffRemoved: 'rgb(75,42,52)', // Dark red
  diffAddedDimmed: 'rgb(45,55,50)', // Very dark green
  diffRemovedDimmed: 'rgb(62,48,55)', // Very dark red
  diffAddedWord: 'rgb(120,180,95)', // Medium green
  diffRemovedWord: 'rgb(230,110,135)', // Softer red
  // Agent colors
  red_FOR_SUBAGENTS_ONLY: 'rgb(247,118,142)', // Red
  blue_FOR_SUBAGENTS_ONLY: 'rgb(122,162,247)', // Blue
  green_FOR_SUBAGENTS_ONLY: 'rgb(158,206,106)', // Green
  yellow_FOR_SUBAGENTS_ONLY: 'rgb(224,175,104)', // Yellow
  purple_FOR_SUBAGENTS_ONLY: 'rgb(187,154,247)', // Magenta
  orange_FOR_SUBAGENTS_ONLY: 'rgb(255,158,100)', // Orange
  pink_FOR_SUBAGENTS_ONLY: 'rgb(255,117,160)', // Pink
  cyan_FOR_SUBAGENTS_ONLY: 'rgb(125,207,255)', // Cyan
  // Accent colors
  professionalBlue: 'rgb(94,129,172)',
  // Chrome colors
  chromeYellow: 'rgb(224,175,104)',
  // TUI V2 colors
  clawd_body: 'ansi:redBright',
  clawd_background: 'rgb(26,27,38)',
  userMessageBackground: 'rgb(40, 44, 62)',
  userMessageBackgroundHover: 'rgb(52, 57, 80)',
  messageActionsBackground: 'rgb(40, 52, 87)', // cool, slight blue
  selectionBg: 'rgb(40, 52, 87)', // Tokyo Night selection
  bashMessageBackgroundColor: 'rgb(52, 46, 66)',

  memoryBackgroundColor: 'rgb(40, 50, 66)',
  rate_limit_fill: 'rgb(122,162,247)', // Blue
  rate_limit_empty: 'rgb(60, 72, 112)', // Dark blue
  fastMode: 'rgb(255,140,70)', // Electric orange for dark bg
  fastModeShimmer: 'rgb(255,175,120)', // Lighter orange for shimmer
  briefLabelYou: 'rgb(125,207,255)', // Cyan
  briefLabelClaude: 'ansi:redBright', // Brand orange (dark-ansi)
  rainbow_red: 'rgb(247,118,142)',
  rainbow_orange: 'rgb(255,158,100)',
  rainbow_yellow: 'rgb(224,175,104)',
  rainbow_green: 'rgb(158,206,106)',
  rainbow_blue: 'rgb(125,207,255)',
  rainbow_indigo: 'rgb(122,162,247)',
  rainbow_violet: 'rgb(187,154,247)',
  rainbow_red_shimmer: 'rgb(255,158,182)',
  rainbow_orange_shimmer: 'rgb(255,178,130)',
  rainbow_yellow_shimmer: 'rgb(255,205,134)',
  rainbow_green_shimmer: 'rgb(188,236,146)',
  rainbow_blue_shimmer: 'rgb(165,227,255)',
  rainbow_indigo_shimmer: 'rgb(152,192,255)',
  rainbow_violet_shimmer: 'rgb(207,184,255)',
}
