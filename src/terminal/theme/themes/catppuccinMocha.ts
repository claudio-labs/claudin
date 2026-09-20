import { DEFAULT_STALL_RED, type Theme } from 'src/terminal/theme/themes/types.js'

/**
 * Catppuccin Mocha theme — soft pastels on a warm dark base
 * (https://catppuccin.com/palette). Explicit RGB values for true-color terminals.
 */
export const catppuccinMochaTheme: Theme = {
  autoAccept: 'rgb(203,166,247)', // Mauve
  bashBorder: 'rgb(245,194,231)', // Pink
  claude: 'rgb(250,179,135)', // Peach
  claudeShimmer: 'rgb(255,199,165)', // Lighter peach for shimmer effect
  claudeBlue_FOR_SYSTEM_SPINNER: 'rgb(137,180,250)', // Blue
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'rgb(167,200,255)', // Lighter blue for shimmer
  permission: 'rgb(180,190,254)', // Lavender
  permissionShimmer: 'rgb(200,210,255)', // Lighter lavender for shimmer
  planMode: 'rgb(148,226,213)', // Teal
  ide: 'rgb(116,199,236)', // Sapphire
  promptBorder: 'rgb(108,112,134)', // Overlay0
  promptBorderShimmer: 'rgb(138,142,164)', // Lighter overlay for shimmer
  text: 'rgb(205,214,244)', // Text
  inverseText: 'rgb(30,30,46)', // Base
  inactive: 'rgb(147,153,178)', // Overlay2
  inactiveShimmer: 'rgb(177,183,208)', // Lighter overlay for shimmer effect
  subtle: 'rgb(69,71,90)', // Surface1
  suggestion: 'rgb(180,190,254)', // Lavender
  remember: 'rgb(203,166,247)', // Mauve
  background: 'rgb(148,226,213)', // Teal accent
  sidePanelBackground: 'rgb(38,38,56)', // One step off Mocha's base
  success: 'rgb(166,227,161)', // Green
  error: 'rgb(243,139,168)', // Red
  spinnerStalled: DEFAULT_STALL_RED, // Stalled-spinner red
  warning: 'rgb(249,226,175)', // Yellow
  merged: 'rgb(203,166,247)', // Mauve (matches autoAccept)
  warningShimmer: 'rgb(255,240,195)', // Lighter yellow for shimmer
  diffAdded: 'rgb(48,70,55)', // Dark green
  diffRemoved: 'rgb(80,48,58)', // Dark red
  diffAddedDimmed: 'rgb(50,58,55)', // Very dark green
  diffRemovedDimmed: 'rgb(66,52,58)', // Very dark red
  diffAddedWord: 'rgb(120,190,115)', // Medium green
  diffRemovedWord: 'rgb(220,120,145)', // Softer red
  // Agent colors
  red_FOR_SUBAGENTS_ONLY: 'rgb(243,139,168)', // Red
  blue_FOR_SUBAGENTS_ONLY: 'rgb(137,180,250)', // Blue
  green_FOR_SUBAGENTS_ONLY: 'rgb(166,227,161)', // Green
  yellow_FOR_SUBAGENTS_ONLY: 'rgb(249,226,175)', // Yellow
  purple_FOR_SUBAGENTS_ONLY: 'rgb(203,166,247)', // Mauve
  orange_FOR_SUBAGENTS_ONLY: 'rgb(250,179,135)', // Peach
  pink_FOR_SUBAGENTS_ONLY: 'rgb(245,194,231)', // Pink
  cyan_FOR_SUBAGENTS_ONLY: 'rgb(148,226,213)', // Teal
  // Accent colors
  professionalBlue: 'rgb(116,199,236)',
  // Chrome colors
  chromeYellow: 'rgb(249,226,175)',
  // TUI V2 colors
  clawd_body: 'rgb(250,179,135)',
  clawd_background: 'rgb(30,30,46)',
  userMessageBackground: 'rgb(49, 50, 68)', // Surface0
  userMessageBackgroundHover: 'rgb(69, 71, 90)', // Surface1
  messageActionsBackground: 'rgb(54, 56, 78)', // cool, slight lavender
  selectionBg: 'rgb(69, 71, 110)', // bluish selection over Mocha base
  bashMessageBackgroundColor: 'rgb(60, 52, 72)',

  memoryBackgroundColor: 'rgb(49, 58, 70)',
  rate_limit_fill: 'rgb(180,190,254)', // Lavender
  rate_limit_empty: 'rgb(76, 80, 112)', // Dark lavender
  fastMode: 'rgb(250,179,135)', // Peach
  fastModeShimmer: 'rgb(255,199,165)', // Lighter peach for shimmer
  briefLabelYou: 'rgb(137,180,250)', // Blue
  briefLabelClaude: 'rgb(250,179,135)', // Peach
  rainbow_red: 'rgb(243,139,168)',
  rainbow_orange: 'rgb(250,179,135)',
  rainbow_yellow: 'rgb(249,226,175)',
  rainbow_green: 'rgb(166,227,161)',
  rainbow_blue: 'rgb(137,180,250)',
  rainbow_indigo: 'rgb(180,190,254)',
  rainbow_violet: 'rgb(203,166,247)',
  rainbow_red_shimmer: 'rgb(255,179,198)',
  rainbow_orange_shimmer: 'rgb(255,199,165)',
  rainbow_yellow_shimmer: 'rgb(255,240,195)',
  rainbow_green_shimmer: 'rgb(196,247,191)',
  rainbow_blue_shimmer: 'rgb(167,200,255)',
  rainbow_indigo_shimmer: 'rgb(200,210,255)',
  rainbow_violet_shimmer: 'rgb(223,196,255)',
}
