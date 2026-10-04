/**
 * A one-line prompt on the terminal with nothing echoed, for secrets.
 *
 * Raw mode hands over whatever the terminal sends as one chunk: a single key
 * when typed, a whole run of characters when pasted. Each chunk is therefore
 * read one character at a time, so Enter, Backspace and Ctrl+C mean the same
 * thing inside a paste as when typed.
 */

const CTRL_C = '\u0003'
const BACKSPACE_KEYS: ReadonlySet<string> = new Set(['\u007F', '\b'])
const ENTER_KEYS: ReadonlySet<string> = new Set(['\r', '\n'])

export type LineEditState =
  | { status: 'typing'; text: string }
  | { status: 'entered'; text: string }
  | { status: 'cancelled' }

/** Applies one chunk of terminal input to the line typed so far. */
export function applyTerminalInput(text: string, chunk: string): LineEditState {
  let line = text
  for (const char of chunk) {
    if (char === CTRL_C) return { status: 'cancelled' }
    if (ENTER_KEYS.has(char)) return { status: 'entered', text: line }
    if (BACKSPACE_KEYS.has(char)) {
      line = Array.from(line).slice(0, -1).join('')
      continue
    }
    line += char
  }
  return { status: 'typing', text: line }
}

function setRawMode(enabled: boolean): void {
  const { stdin } = process
  if (typeof stdin.setRawMode === 'function') stdin.setRawMode(enabled)
}

export function promptHiddenLine(prompt: string): Promise<string> {
  const { stdin, stderr } = process
  stderr.write(prompt)

  return new Promise<string>((resolve, reject) => {
    let typed = ''

    const finish = () => {
      stdin.removeListener('data', onData)
      setRawMode(false)
      stdin.pause()
    }

    const onData = (chunk: Buffer | string) => {
      const state = applyTerminalInput(typed, chunk.toString())
      if (state.status === 'typing') {
        typed = state.text
        return
      }
      finish()
      if (state.status === 'cancelled') {
        reject(new Error('Cancelled'))
        return
      }
      stderr.write('\n')
      resolve(state.text)
    }

    setRawMode(true)
    stdin.on('data', onData)
    stdin.resume()
  })
}
