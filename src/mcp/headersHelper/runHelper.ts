/**
 * Runs a headersHelper: one executable, no shell, no arguments, stdin closed
 * at once, under a hard deadline.
 *
 * The deadline is the answer's, not the process's: when it passes, the call
 * fails at once, whatever the helper does with SIGTERM and whichever of its
 * children still hold the output pipes. The helper runs in a process group of
 * its own so those children are signalled too.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { errorMessage } from 'src/shared/errors.js'

export type HelperRunOptions = {
  env: NodeJS.ProcessEnv
  timeoutMs: number
  /** stdout and stderr together. */
  maxOutputBytes: number
  /** Between SIGTERM and SIGKILL once the helper is given up on. */
  killGraceMs: number
}

export type HelperRunResult =
  | { ok: true; stdout: string }
  | { ok: false; failure: string }

const BARE_NAME = /^[A-Za-z0-9._-]+$/
const LINE_BREAK_OR_NUL = /[\0\r\n]/
const isWindows = process.platform === 'win32'
// Without a separator the OS searches PATH, so only those names are vetted.
const PATH_SEPARATOR = isWindows ? /[\\/]/ : /\//
const ownProcessGroup = !isWindows

/** Why a configured value cannot name a program, or undefined when it can. */
export function executableProblem(command: string): string | undefined {
  if (LINE_BREAK_OR_NUL.test(command)) return 'the command holds a line break'
  if (!PATH_SEPARATOR.test(command) && !BARE_NAME.test(command)) {
    return 'a bare command name may only hold letters, digits, ".", "_" and "-"'
  }
  return undefined
}

function signalHelper(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    if (ownProcessGroup) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    // Already gone.
  }
}

function abandon(child: ChildProcess, killGraceMs: number): void {
  child.stdout?.destroy()
  child.stderr?.destroy()
  child.unref()
  signalHelper(child, 'SIGTERM')
  setTimeout(() => signalHelper(child, 'SIGKILL'), killGraceMs).unref()
}

export function runHelper(
  command: string,
  options: HelperRunOptions,
): Promise<HelperRunResult> {
  const problem = executableProblem(command)
  if (problem) return Promise.resolve({ ok: false, failure: problem })

  return new Promise<HelperRunResult>(resolve => {
    let child: ChildProcess
    try {
      child = spawn(command, [], {
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: ownProcessGroup,
        windowsHide: true,
      })
    } catch (error) {
      resolve({ ok: false, failure: errorMessage(error) })
      return
    }

    let settled = false
    const settle = (result: HelperRunResult) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      resolve(result)
    }
    const giveUp = (failure: string) => {
      abandon(child, options.killGraceMs)
      settle({ ok: false, failure })
    }

    const deadline = setTimeout(
      () => giveUp(`no answer within ${options.timeoutMs} ms`),
      options.timeoutMs,
    )

    const stdout: Buffer[] = []
    let outputBytes = 0
    const collect = (keep: boolean) => (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > options.maxOutputBytes) {
        giveUp(`more than ${options.maxOutputBytes} bytes of output`)
        return
      }
      if (keep) stdout.push(chunk)
    }
    child.stdout?.on('data', collect(true))
    child.stderr?.on('data', collect(false))

    child.on('error', error => settle({ ok: false, failure: error.message }))
    child.on('close', (code, signal) => {
      if (code === 0) {
        settle({ ok: true, stdout: Buffer.concat(stdout).toString('utf8') })
      } else {
        settle({ ok: false, failure: `ended by ${signal ?? `exit code ${code}`}` })
      }
    })

    child.stdin?.on('error', () => {})
    child.stdin?.end()
  })
}
