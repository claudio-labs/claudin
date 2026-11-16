import wrapAnsiNpm from 'wrap-ansi'

type WrapAnsiOptions = {
  hard?: boolean
  wordWrap?: boolean
  trim?: boolean
}

// wrap-ansi 10 expands a tab into 8-column stops and has no option to stop it,
// where Bun.wrapAnsi keeps the tab as one zero-width character. Cursor looks
// every wrapped line up in the original text, so an expanded tab throws on Tab.
// A tab is hidden behind a zero-width character for the call and put back after;
// each of these measures zero and wraps like Bun's tab (wrapAnsi.test.ts).
// The first one the input does not already contain is used.
const TAB_SENTINELS = ['\u2060', '\u0001', '\u200B']

function wrapAnsiNode(
  input: string,
  columns: number,
  options?: WrapAnsiOptions,
): string {
  if (!input.includes('\t')) return wrapAnsiNpm(input, columns, options)
  const sentinel = TAB_SENTINELS.find(s => !input.includes(s))
  if (sentinel === undefined) return wrapAnsiNpm(input, columns, options)
  return wrapAnsiNpm(input.replaceAll('\t', sentinel), columns, options)
    .replaceAll(sentinel, '\t')
}

const wrapAnsiBun =
  typeof Bun !== 'undefined' && typeof Bun.wrapAnsi === 'function'
    ? Bun.wrapAnsi
    : null

const wrapAnsi: (
  input: string,
  columns: number,
  options?: WrapAnsiOptions,
) => string = wrapAnsiBun ?? wrapAnsiNode

export { wrapAnsi, wrapAnsiNode }
