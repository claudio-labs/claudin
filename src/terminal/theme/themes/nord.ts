import { DEFAULT_STALL_RED, type Theme } from 'src/terminal/theme/themes/types.js'

/**
 * Nord theme — low-saturation arctic blue-gray palette
 * (https://www.nordtheme.com). Explicit RGB for true-color terminals.
 */
export const nordTheme: Theme = {
  autoAccept: 'rgb(180,142,173)', // Aurora purple
  bashBorder: 'rgb(180,142,173)', // Aurora purple (mode accent — must not read as `error`)
  claude: 'rgb(208,135,112)', // Aurora orange
  claudeShimmer: 'rgb(228,165,142)', // Lighter orange for shimmer effect
  claudeBlue_FOR_SYSTEM_SPINNER: 'rgb(136,192,208)', // Frost cyan
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'rgb(166,212,228)', // Lighter cyan for shimmer
  permission: 'rgb(129,161,193)', // Frost blue
  permissionShimmer: 'rgb(159,191,223)', // Lighter blue for shimmer
  planMode: 'rgb(143,188,187)', // Frost teal
  ide: 'rgb(94,129,172)', // Frost dark blue
  promptBorder: 'rgb(76,86,106)', // nord3
  promptBorderShimmer: 'rgb(106,116,136)', // Lighter for shimmer
  text: 'rgb(236,239,244)', // nord6
  inverseText: 'rgb(46,52,64)', // nord0
  inactive: 'rgb(118,128,148)', // Muted gray-blue
  inactiveShimmer: 'rgb(148,158,178)', // Lighter for shimmer effect
  subtle: 'rgb(59,66,82)', // nord1
  suggestion: 'rgb(129,161,193)', // Frost blue
  remember: 'rgb(180,142,173)', // Aurora purple
  background: 'rgb(136,192,208)', // Frost cyan accent
  sidePanelBackground: 'rgb(54,60,74)', // Between nord0 and nord1
  success: 'rgb(163,190,140)', // Aurora green
  error: 'rgb(191,97,106)', // Aurora red
  spinnerStalled: DEFAULT_STALL_RED, // Stalled-spinner red
  warning: 'rgb(235,203,139)', // Aurora yellow
  merged: 'rgb(180,142,173)', // Aurora purple (matches autoAccept)
  warningShimmer: 'rgb(255,223,159)', // Lighter yellow for shimmer
  diffAdded: 'rgb(45,62,48)', // Dark green
  diffRemoved: 'rgb(72,48,52)', // Dark red
  diffAddedDimmed: 'rgb(50,58,52)', // Very dark green
  diffRemovedDimmed: 'rgb(62,52,55)', // Very dark red
  diffAddedWord: 'rgb(130,160,110)', // Medium green
  diffRemovedWord: 'rgb(200,120,130)', // Softer red
  // Agent colors
  red_FOR_SUBAGENTS_ONLY: 'rgb(191,97,106)', // Red
  blue_FOR_SUBAGENTS_ONLY: 'rgb(129,161,193)', // Blue
  green_FOR_SUBAGENTS_ONLY: 'rgb(163,190,140)', // Green
  yellow_FOR_SUBAGENTS_ONLY: 'rgb(235,203,139)', // Yellow
  purple_FOR_SUBAGENTS_ONLY: 'rgb(180,142,173)', // Purple
  orange_FOR_SUBAGENTS_ONLY: 'rgb(208,135,112)', // Orange
  pink_FOR_SUBAGENTS_ONLY: 'rgb(196,142,168)', // Pink
  cyan_FOR_SUBAGENTS_ONLY: 'rgb(136,192,208)', // Cyan
  // Accent colors
  professionalBlue: 'rgb(94,129,172)',
  // Chrome colors
  chromeYellow: 'rgb(235,203,139)',
  // TUI V2 colors
  clawd_body: 'rgb(208,135,112)',
  clawd_background: 'rgb(46,52,64)',
  userMessageBackground: 'rgb(59, 66, 82)', // nord1
  userMessageBackgroundHover: 'rgb(67, 76, 94)', // nord2
  messageActionsBackground: 'rgb(56, 66, 86)', // cool, slight blue
  selectionBg: 'rgb(60, 72, 100)', // bluish selection over nord0
  bashMessageBackgroundColor: 'rgb(62, 60, 72)',

  memoryBackgroundColor: 'rgb(52, 64, 72)',
  rate_limit_fill: 'rgb(129,161,193)', // Frost blue
  rate_limit_empty: 'rgb(64, 76, 100)', // Dark blue
  fastMode: 'rgb(224,150,110)', // Orange for dark bg
  fastModeShimmer: 'rgb(240,180,150)', // Lighter orange for shimmer
  briefLabelYou: 'rgb(136,192,208)', // Frost cyan
  briefLabelClaude: 'rgb(208,135,112)', // Orange
  rainbow_red: 'rgb(191,97,106)',
  rainbow_orange: 'rgb(208,135,112)',
  rainbow_yellow: 'rgb(235,203,139)',
  rainbow_green: 'rgb(163,190,140)',
  rainbow_blue: 'rgb(136,192,208)',
  rainbow_indigo: 'rgb(129,161,193)',
  rainbow_violet: 'rgb(180,142,173)',
  rainbow_red_shimmer: 'rgb(221,137,146)',
  rainbow_orange_shimmer: 'rgb(228,165,142)',
  rainbow_yellow_shimmer: 'rgb(255,223,159)',
  rainbow_green_shimmer: 'rgb(193,210,170)',
  rainbow_blue_shimmer: 'rgb(166,212,228)',
  rainbow_indigo_shimmer: 'rgb(159,191,223)',
  rainbow_violet_shimmer: 'rgb(210,172,203)',
}
