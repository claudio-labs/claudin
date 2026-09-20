import chalk, { Chalk } from 'chalk'
import { env } from 'src/shared/env.js'
import { catppuccinLatteTheme } from 'src/terminal/theme/themes/catppuccinLatte.js'
import { catppuccinMochaTheme } from 'src/terminal/theme/themes/catppuccinMocha.js'
import { darkTheme } from 'src/terminal/theme/themes/dark.js'
import { darkAnsiTheme } from 'src/terminal/theme/themes/darkAnsi.js'
import { darkDaltonizedTheme } from 'src/terminal/theme/themes/darkDaltonized.js'
import { draculaTheme } from 'src/terminal/theme/themes/dracula.js'
import { gruvboxDarkTheme } from 'src/terminal/theme/themes/gruvboxDark.js'
import { lightTheme } from 'src/terminal/theme/themes/light.js'
import { lightAnsiTheme } from 'src/terminal/theme/themes/lightAnsi.js'
import { lightDaltonizedTheme } from 'src/terminal/theme/themes/lightDaltonized.js'
import { nordTheme } from 'src/terminal/theme/themes/nord.js'
import { terminalTheme } from 'src/terminal/theme/themes/terminal.js'
import { tokyoNightTheme } from 'src/terminal/theme/themes/tokyoNight.js'
import type { Theme, ThemeName } from 'src/terminal/theme/themes/types.js'

export type { Theme, ThemeName, ThemeSetting } from 'src/terminal/theme/themes/types.js'
export { THEME_NAMES, THEME_SETTINGS } from 'src/terminal/theme/themes/types.js'

export function getTheme(themeName: ThemeName): Theme {
  switch (themeName) {
    case 'light':
      return lightTheme
    case 'light-ansi':
      return lightAnsiTheme
    case 'dark-ansi':
      return darkAnsiTheme
    case 'terminal':
      return terminalTheme
    case 'light-daltonized':
      return lightDaltonizedTheme
    case 'dark-daltonized':
      return darkDaltonizedTheme
    case 'dracula':
      return draculaTheme
    case 'catppuccin-mocha':
      return catppuccinMochaTheme
    case 'catppuccin-latte':
      return catppuccinLatteTheme
    case 'tokyo-night':
      return tokyoNightTheme
    case 'nord':
      return nordTheme
    case 'gruvbox-dark':
      return gruvboxDarkTheme
    default:
      return darkTheme
  }
}

// Create a chalk instance with 256-color level for Apple Terminal
// Apple Terminal doesn't handle 24-bit color escape sequences well
const chalkForChart =
  env.terminal === 'Apple_Terminal'
    ? new Chalk({ level: 2 }) // 256 colors
    : chalk

/**
 * Converts a theme color to an ANSI escape sequence for use with renderLineChart.
 * Uses chalk to generate the escape codes, with 256-color mode for Apple Terminal.
 *
 * `background: true` emits the background form instead — needed where a colour
 * has to be baked into a pre-rendered ANSI string rather than set through a
 * `<Text>` prop (the diff rows in the `/diff` side panel).
 */
export function themeColorToAnsi(themeColor: string, background = false): string {
  const rgbMatch = themeColor.match(/rgb\(\s?(\d+),\s?(\d+),\s?(\d+)\s?\)/)
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1]!, 10)
    const g = parseInt(rgbMatch[2]!, 10)
    const b = parseInt(rgbMatch[3]!, 10)
    // Use chalk.rgb which auto-converts to 256 colors when level is 2
    // Extract just the opening escape sequence by using a marker
    const colored = background
      ? chalkForChart.bgRgb(r, g, b)('X')
      : chalkForChart.rgb(r, g, b)('X')
    return colored.slice(0, colored.indexOf('X'))
  }
  // Fallback: terminal default for a background, magenta for a foreground.
  return background ? '\x1b[49m' : '\x1b[35m'
}
