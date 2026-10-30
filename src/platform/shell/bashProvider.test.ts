import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { rmSync } from 'fs'

import { createBashShellProvider } from 'src/platform/shell/bashProvider.js'

const cwdFiles: string[] = []
afterEach(() => {
  for (const file of cwdFiles.splice(0)) rmSync(file, { force: true })
})

describe('bash provider — job control', () => {
  // A snapshot taken from an interactive shell replays `set -o monitor`
  // (ShellSnapshot.ts copies every option that is on). With job control on,
  // every `&` gets a process group of its own, so the shell's group no longer
  // holds what the command started and a group signal misses it.
  test('a command runs without job control, so what it backgrounds stays in the shell group', async () => {
    const provider = await createBashShellProvider('/bin/bash', { skipSnapshot: true })
    const { commandString, cwdFilePath } = await provider.buildExecCommand(
      'sleep 30 & echo "$(ps -o pgid= -p $!) $(ps -o pgid= -p $$)"; kill $!',
      { id: `jobctl-${process.pid}`, useSandbox: false },
    )
    cwdFiles.push(cwdFilePath)
    const run = spawnSync('bash', ['-c', `set -o monitor; ${commandString}`], { encoding: 'utf8' })
    const [job, shell] = run.stdout.trim().split(/\s+/)
    expect(shell).toBeDefined()
    expect(job).toBe(shell)
  })
})
