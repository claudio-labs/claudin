import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

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

// A piped command used to be re-parsed and rebuilt word by word with
// shell-quote's quote(), which escapes `~`, `{`, `,` and `}` (1.12): bash then
// saw a literal `~/x` and a literal `{a,b}`. The cases are the commands that
// failed in the 2026-11-04..09 census (and before it, back to 07-14), with the
// paths moved under a throwaway HOME.
describe('bash provider — a piped command keeps what bash expands', () => {
  let home: string
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'pipe-home-'))
    mkdirSync(join(home, '.cache', 'unit'), { recursive: true })
    writeFileSync(join(home, '.cache', 'unit', 'run.sh'), 'echo cap-add-SETUID\n')
    mkdirSync(join(home, 'reg', 'src'), { recursive: true })
    writeFileSync(join(home, 'reg', 'src', 'lib.rs'), 'struct CredentialRef;\n')
    mkdirSync(join(home, 'other'), { recursive: true })
    writeFileSync(join(home, 'other', 'mod.rs'), 'use CredentialRef;\n')
    mkdirSync(join(home, '.claudin'), { recursive: true })
    writeFileSync(join(home, '.claudin', 'config.json'), '{"ollama":true}\n')
    mkdirSync(join(home, 'wt'), { recursive: true })
    writeFileSync(join(home, 'wt', 'notes.txt'), 'one\ntwo\nthree\nfour\n')
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  async function run(command: string): Promise<{ stdout: string; stderr: string; status: number | null }> {
    const provider = await createBashShellProvider('/bin/bash', { skipSnapshot: true })
    const { commandString, cwdFilePath } = await provider.buildExecCommand(command, {
      id: `pipe-${process.pid}-${cwdFiles.length}`,
      useSandbox: false,
    })
    cwdFiles.push(cwdFilePath)
    const result = spawnSync('bash', ['-c', commandString], {
      encoding: 'utf8',
      cwd: home,
      env: { ...process.env, HOME: home },
      timeout: 10_000,
    })
    return { stdout: result.stdout, stderr: result.stderr, status: result.status }
  }

  test('32d3ba9c 11-04: sed -i on ~/ paths, then the script, piped to tail', async () => {
    const out = await run(
      "sed -i 's/SETUID/SETUID-SETPCAP/' ~/.cache/unit/run.sh && sed -i \"s/cap-add/cap+add/\" ~/.cache/unit/run.sh && bash ~/.cache/unit/run.sh | tail -1",
    )
    expect(out.stderr).toBe('')
    expect(out.stdout.trim()).toBe('cap+add-SETUID-SETPCAP')
  })

  test('11-09: grep -rn over two ~/ trees, piped to head', async () => {
    const out = await run('grep -rn "CredentialRef" ~/reg/src ~/other | head -5')
    expect(out.stderr).toBe('')
    expect(out.stdout.trim().split('\n').sort()).toEqual([
      `${home}/other/mod.rs:1:use CredentialRef;`,
      `${home}/reg/src/lib.rs:1:struct CredentialRef;`,
    ])
  })

  test('11-03: a bare ~ beside another path, and a ; chain of pipes', async () => {
    const out = await run('ls -d ~ /tmp | tail -2; ls ~/.cache | grep -i unit')
    expect(out.stderr).toBe('')
    expect(out.stdout.trim().split('\n')).toEqual(['/tmp', home, 'unit'])
  })

  test('10-31: ~/ with and without a glob in the same command', async () => {
    const out = await run("ls ~/.claudin/ | head -50; grep -l -i 'ollama' ~/.claudin/*.json 2>/dev/null")
    expect(out.stdout.trim().split('\n')).toEqual(['config.json', `${home}/.claudin/config.json`])
  })

  test('10-27: cd ~/… in front of a pipe', async () => {
    const out = await run('cd ~/wt && cat notes.txt | head -2')
    expect(out.stderr).toBe('')
    expect(out.stdout).toBe('one\ntwo\n')
  })

  test('brace expansion survives a pipe', async () => {
    const out = await run('echo {a,b} x{1..3} | cat')
    expect(out.stdout).toBe('a b x1 x2 x3\n')
  })

  test('a command reading stdin before a pipe gets /dev/null, not the open spawn stdin', async () => {
    // `a && b | c` rebuilt as `a && b < /dev/null | c` left `a` on the spawn's
    // stdin, which the Bash tool keeps open: `read` waited for ever.
    const provider = await createBashShellProvider('/bin/bash', { skipSnapshot: true })
    const { commandString, cwdFilePath } = await provider.buildExecCommand(
      'read -r line && echo got | cat; echo done',
      { id: `pipe-stdin-${process.pid}`, useSandbox: false },
    )
    cwdFiles.push(cwdFilePath)
    const child = spawn('bash', ['-c', commandString], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.on('data', chunk => (stdout += chunk))
    const exited = await Promise.race([
      new Promise<boolean>(resolve => child.on('close', () => resolve(true))),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2_000)),
    ])
    child.kill('SIGKILL')
    expect(exited).toBe(true)
    expect(stdout).toBe('done\n')
  }, 10_000)

  describe('what must not change', () => {
    test('a quoted ~ stays literal', async () => {
      const out = await run("echo '~/x' \"~/y\" | cat")
      expect(out.stdout).toBe('~/x ~/y\n')
    })

    test('a jq-style != inside single quotes reaches the program intact', async () => {
      const out = await run("echo 'select(.a != .b)' | cat")
      expect(out.stdout).toBe('select(.a != .b)\n')
    })

    test('2>&1 into a pipe, a $VAR and a glob', async () => {
      const out = await run('ls ~/.cache/nothing 2>&1 | grep -c "No such"; V=hi; echo $V | cat; ls ~/wt/*.txt | wc -l')
      expect(out.stdout).toBe('1\nhi\n1\n')
    })

    test('the first command of a pipe reads /dev/null even with stdin open', async () => {
      const provider = await createBashShellProvider('/bin/bash', { skipSnapshot: true })
      const { commandString, cwdFilePath } = await provider.buildExecCommand('cat | wc -l', {
        id: `pipe-cat-${process.pid}`,
        useSandbox: false,
      })
      cwdFiles.push(cwdFilePath)
      const child = spawn('bash', ['-c', commandString], { stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      child.stdout.on('data', chunk => (stdout += chunk))
      const exited = await Promise.race([
        new Promise<boolean>(resolve => child.on('close', () => resolve(true))),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2_000)),
      ])
      child.kill('SIGKILL')
      expect(exited).toBe(true)
      expect(stdout.trim()).toBe('0')
    }, 10_000)
  })
})
