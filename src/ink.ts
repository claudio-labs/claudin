import { createElement, type ReactNode } from 'react'
import { ThemeProvider } from 'src/components/design-system/ThemeProvider.js'
import inkRender, {
  type Instance,
  createRoot as inkCreateRoot,
  type RenderOptions,
  type Root,
} from 'src/ink/root.js'

export type { RenderOptions, Instance, Root }

// Wrap all CC render calls with ThemeProvider so ThemedBox/ThemedText work
// without every call site having to mount it. Ink itself is theme-agnostic.
function withTheme(node: ReactNode): ReactNode {
  return createElement(ThemeProvider, null, node)
}

export async function render(
  node: ReactNode,
  options?: NodeJS.WriteStream | RenderOptions,
): Promise<Instance> {
  return inkRender(withTheme(node), options)
}

export async function createRoot(options?: RenderOptions): Promise<Root> {
  const root = await inkCreateRoot(options)
  return {
    ...root,
    render: node => root.render(withTheme(node)),
  }
}

export { color } from 'src/components/design-system/color.js'
export type { Props as BoxProps } from 'src/components/design-system/ThemedBox.js'
export { default as Box } from 'src/components/design-system/ThemedBox.js'
export type { Props as TextProps } from 'src/components/design-system/ThemedText.js'
export { default as Text } from 'src/components/design-system/ThemedText.js'
export {
  ThemeProvider,
  usePreviewTheme,
  useTheme,
  useThemeSetting,
} from 'src/components/design-system/ThemeProvider.js'
export { Ansi } from 'src/ink/Ansi.js'
export type { Props as AppProps } from 'src/ink/components/AppContext.js'
export type { Props as BaseBoxProps } from 'src/ink/components/Box.js'
export { default as BaseBox } from 'src/ink/components/Box.js'
export type {
  ButtonState,
  Props as ButtonProps,
} from 'src/ink/components/Button.js'
export { default as Button } from 'src/ink/components/Button.js'
export type { Props as LinkProps } from 'src/ink/components/Link.js'
export { default as Link } from 'src/ink/components/Link.js'
export type { Props as NewlineProps } from 'src/ink/components/Newline.js'
export { default as Newline } from 'src/ink/components/Newline.js'
export { NoSelect } from 'src/ink/components/NoSelect.js'
export { RawAnsi } from 'src/ink/components/RawAnsi.js'
export { default as Spacer } from 'src/ink/components/Spacer.js'
export type { Props as StdinProps } from 'src/ink/components/StdinContext.js'
export type { Props as BaseTextProps } from 'src/ink/components/Text.js'
export { default as BaseText } from 'src/ink/components/Text.js'
export type { DOMElement } from 'src/ink/dom.js'
export { ClickEvent } from 'src/ink/events/click-event.js'
export { EventEmitter } from 'src/ink/events/emitter.js'
export { Event } from 'src/ink/events/event.js'
export type { Key } from 'src/ink/events/input-event.js'
export { InputEvent } from 'src/ink/events/input-event.js'
export type { TerminalFocusEventType } from 'src/ink/events/terminal-focus-event.js'
export { TerminalFocusEvent } from 'src/ink/events/terminal-focus-event.js'
export { FocusManager } from 'src/ink/focus.js'
export type { FlickerReason } from 'src/ink/frame.js'
export { useAnimationFrame } from 'src/ink/hooks/use-animation-frame.js'
export { default as useApp } from 'src/ink/hooks/use-app.js'
export { default as useInput } from 'src/ink/hooks/use-input.js'
export { useAnimationTimer, useInterval } from 'src/ink/hooks/use-interval.js'
export { useSelection } from 'src/ink/hooks/use-selection.js'
export { default as useStdin } from 'src/ink/hooks/use-stdin.js'
export { useTabStatus } from 'src/ink/hooks/use-tab-status.js'
export { useTerminalFocus } from 'src/ink/hooks/use-terminal-focus.js'
export { useTerminalTitle } from 'src/ink/hooks/use-terminal-title.js'
export { useTerminalViewport } from 'src/ink/hooks/use-terminal-viewport.js'
export { default as measureElement } from 'src/ink/measure-element.js'
export { supportsTabStatus } from 'src/ink/termio/osc.js'
export { default as wrapText } from 'src/ink/wrap-text.js'
