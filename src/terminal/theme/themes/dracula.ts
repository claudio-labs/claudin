import { DEFAULT_STALL_RED, type Theme } from 'src/terminal/theme/themes/types.js'

/**
 * Dracula theme — the classic purple/pink dark palette
 * (https://draculatheme.com). Explicit RGB values for true-color terminals.
 */
export const draculaTheme: Theme = {
  autoAccept: 'rgb(189,147,249)', // Purple
  bashBorder: 'rgb(255,121,198)', // Pink
  claude: 'rgb(255,184,108)', // Orange
  claudeShimmer: 'rgb(255,204,148)', // Lighter orange for shimmer effect
  claudeBlue_FOR_SYSTEM_SPINNER: 'rgb(139,233,253)', // Cyan
  claudeBlueShimmer_FOR_SYSTEM_SPINNER: 'rgb(179,243,255)', // Lighter cyan for shimmer
  permission: 'rgb(189,147,249)', // Purple
  permissionShimmer: 'rgb(209,177,255)', // Lighter purple for shimmer
  planMode: 'rgb(80,250,123)', // Green
  ide: 'rgb(98,114,164)', // Comment blue
  promptBorder: 'rgb(98,114,164)', // Comment blue
  promptBorderShimmer: 'rgb(128,144,194)', // Lighter comment for shimmer
  text: 'rgb(248,248,242)', // Foreground
  inverseText: 'rgb(40,42,54)', // Background
  inactive: 'rgb(98,114,164)', // Comment
  inactiveShimmer: 'rgb(138,154,204)', // Lighter comment for shimmer effect
  subtle: 'rgb(68,71,90)', // Current line
  suggestion: 'rgb(189,147,249)', // Purple
  remember: 'rgb(189,147,249)', // Purple
  background: 'rgb(139,233,253)', // Cyan accent
  sidePanelBackground: 'rgb(48,50,64)', // One step off Dracula's base
  success: 'rgb(80,250,123)', // Green
  error: 'rgb(255,85,85)', // Red
  spinnerStalled: DEFAULT_STALL_RED, // Stalled-spinner red
  warning: 'rgb(241,250,140)', // Yellow
  merged: 'rgb(189,147,249)', // Purple (matches autoAccept)
  warningShimmer: 'rgb(255,255,180)', // Lighter yellow for shimmer
  diffAdded: 'rgb(40,80,55)', // Dark green
  diffRemoved: 'rgb(90,45,55)', // Dark red
  diffAddedDimmed: 'rgb(48,62,53)', // Very dark green
  diffRemovedDimmed: 'rgb(72,52,57)', // Very dark red
  diffAddedWord: 'rgb(80,200,110)', // Medium green
  diffRemovedWord: 'rgb(255,121,140)', // Softer red
  // Agent colors
  red_FOR_SUBAGENTS_ONLY: 'rgb(255,85,85)', // Red
  blue_FOR_SUBAGENTS_ONLY: 'rgb(139,180,250)', // Blue
  green_FOR_SUBAGENTS_ONLY: 'rgb(80,250,123)', // Green
  yellow_FOR_SUBAGENTS_ONLY: 'rgb(241,250,140)', // Yellow
  purple_FOR_SUBAGENTS_ONLY: 'rgb(189,147,249)', // Purple
  orange_FOR_SUBAGENTS_ONLY: 'rgb(255,184,108)', // Orange
  pink_FOR_SUBAGENTS_ONLY: 'rgb(255,121,198)', // Pink
  cyan_FOR_SUBAGENTS_ONLY: 'rgb(139,233,253)', // Cyan
  // Accent colors
  professionalBlue: 'rgb(106,130,180)',
  // Chrome colors
  chromeYellow: 'rgb(241,250,140)',
  // TUI V2 colors
  clawd_body: 'rgb(255,184,108)',
  clawd_background: 'rgb(40,42,54)',
  userMessageBackground: 'rgb(55, 57, 72)',
  userMessageBackgroundHover: 'rgb(68, 71, 90)',
  messageActionsBackground: 'rgb(52, 52, 75)', // cool, slight purple
  selectionBg: 'rgb(61, 64, 110)', // bluish selection over Dracula bg
  bashMessageBackgroundColor: 'rgb(60, 52, 68)',

  memoryBackgroundColor: 'rgb(52, 58, 75)',
  rate_limit_fill: 'rgb(189,147,249)', // Purple
  rate_limit_empty: 'rgb(80,70,112)', // Dark purple
  fastMode: 'rgb(255,160,80)', // Electric orange for dark bg
  fastModeShimmer: 'rgb(255,190,130)', // Lighter orange for shimmer
  briefLabelYou: 'rgb(139,233,253)', // Cyan
  briefLabelClaude: 'rgb(255,184,108)', // Orange
  rainbow_red: 'rgb(255,85,85)',
  rainbow_orange: 'rgb(255,184,108)',
  rainbow_yellow: 'rgb(241,250,140)',
  rainbow_green: 'rgb(80,250,123)',
  rainbow_blue: 'rgb(139,233,253)',
  rainbow_indigo: 'rgb(189,147,249)',
  rainbow_violet: 'rgb(255,121,198)',
  rainbow_red_shimmer: 'rgb(255,135,135)',
  rainbow_orange_shimmer: 'rgb(255,204,148)',
  rainbow_yellow_shimmer: 'rgb(255,255,180)',
  rainbow_green_shimmer: 'rgb(130,255,163)',
  rainbow_blue_shimmer: 'rgb(179,243,255)',
  rainbow_indigo_shimmer: 'rgb(209,177,255)',
  rainbow_violet_shimmer: 'rgb(255,161,218)',
}
