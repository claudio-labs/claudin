#!/usr/bin/env bun
/**
 * git/gh baseline — what the agent currently spends on version-control commands.
 *
 * Aggregates recorded session transcripts (`~/.claudin/projects/<slug>/*.jsonl`)
 * and reports the Bash tool_result cost of every `git`/`gh` invocation, grouped
 * by `<binary> <subcommand>`. This is the before-number for the Git tool (D2 in
 * the dev-tooling token roadmap) and the corpus the replay harness reads.
 *
 * Deliberately reads the transcripts as data, never as context: the per-line
 * JSON is parsed and thrown away, and only aggregates are printed.
 *
 *   bun scripts/profile/git-tool-baseline.ts [--project <slug>] [--json <out>]
 *
 * `--json` writes the matched calls (command + result text) to a file so
 * `git-summarizer-replay.ts` can replay them without re-walking the transcripts.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

const VCS_BINARIES = new Set(['git', 'gh', 'tea', 'glab', 'jj'])

/** Second token of these families is a flag, not a subcommand. */
const WS_RE = /\s+/

/**
 * Mutating first-two-token pairs. Anything not listed counts as a read for the
 * purposes of this report — it is a description of the recorded corpus, not the
 * tool's fail-closed classifier.
 */
const MUTATING = new Set([
  'git add',
  'git am',
  'git apply',
  'git branch',
  'git checkout',
  'git cherry-pick',
  'git clean',
  'git clone',
  'git commit',
  'git fetch',
  'git gc',
  'git init',
  'git merge',
  'git mv',
  'git pull',
  'git push',
  'git rebase',
  'git reset',
  'git restore',
  'git revert',
  'git rm',
  'git stash',
  'git switch',
  'git tag',
  'git worktree',
  'gh pr create',
  'gh pr merge',
  'gh pr close',
  'gh pr comment',
  'gh pr edit',
  'gh pr checkout',
  'gh issue create',
  'gh issue close',
  'gh issue comment',
  'gh repo create',
  'gh repo fork',
  'gh run rerun',
  'gh run cancel',
  'gh workflow run',
  'gh release create',
])

type Block = Record<string, unknown>

type Row = {
  calls: number
  chars: number
  sizes: number[]
  piped: number
}

type MatchedCall = {
  command: string
  binary: string
  key: string
  chars: number
  text: string
}

function contentChars(content: unknown): { chars: number; text: string } {
  if (typeof content === 'string') return { chars: content.length, text: content }
  if (Array.isArray(content)) {
    const text = content
      .map(part =>
        part && typeof part === 'object' && typeof (part as Block).text === 'string'
          ? ((part as Block).text as string)
          : '',
      )
      .join('')
    return { chars: text.length, text }
  }
  return { chars: 0, text: '' }
}

function projectDirs(explicit: string | null): string[] {
  const root = join(homedir(), '.claudin', 'projects')
  if (explicit) return [join(root, explicit)]
  return readdirSync(root)
    .map(name => join(root, name))
    .filter(p => {
      try {
        return statSync(p).isDirectory()
      } catch {
        return false
      }
    })
}

function transcriptFiles(dirs: string[]): string[] {
  const out: string[] = []
  for (const dir of dirs) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (name.endsWith('.jsonl')) out.push(join(dir, name))
    }
  }
  return out
}

function pct(part: number, whole: number): string {
  if (whole === 0) return '0.0%'
  return `${((part / whole) * 100).toFixed(1)}%`
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q))
  return sorted[idx] ?? 0
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

function padLeft(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s
}

function main(): void {
  const argv = process.argv.slice(2)
  const projectArg = argv.indexOf('--project')
  const jsonArg = argv.indexOf('--json')
  const project = projectArg >= 0 ? (argv[projectArg + 1] ?? null) : null
  const jsonOut = jsonArg >= 0 ? (argv[jsonArg + 1] ?? null) : null

  const files = transcriptFiles(projectDirs(project))

  let totalResultChars = 0
  let totalResultCalls = 0
  let bashChars = 0
  let bashCalls = 0
  const byTool = new Map<string, number>()
  const rows = new Map<string, Row>()
  const matched: MatchedCall[] = []
  /** sessions that spent at least one char on git/gh, vs sessions overall */
  const sessionsSeen = new Set<string>()
  const sessionsWithVcs = new Set<string>()
  let readCalls = 0
  let readChars = 0
  let writeCalls = 0
  let writeChars = 0

  for (const file of files) {
    sessionsSeen.add(file)
    // tool_use blocks come before their results, but not necessarily in the
    // same file position order after a resume, so index the whole file first.
    const uses = new Map<string, { name: string; input: Block }>()
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of raw.split('\n')) {
      if (!line) continue
      let parsed: Block
      try {
        parsed = JSON.parse(line) as Block
      } catch {
        continue
      }
      const message = parsed.message as Block | undefined
      const content = message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        const b = block as Block
        if (b.type === 'tool_use' && typeof b.id === 'string') {
          uses.set(b.id, {
            name: typeof b.name === 'string' ? b.name : '',
            input: (b.input as Block) ?? {},
          })
        } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          const use = uses.get(b.tool_use_id)
          if (!use) continue
          const { chars, text } = contentChars(b.content)
          totalResultChars += chars
          totalResultCalls += 1
          byTool.set(use.name, (byTool.get(use.name) ?? 0) + chars)
          if (use.name !== 'Bash') continue
          bashChars += chars
          bashCalls += 1
          const command = typeof use.input.command === 'string' ? use.input.command.trim() : ''
          if (!command) continue
          const parts = command.split(WS_RE)
          const binary = parts[0] ?? ''
          if (!VCS_BINARIES.has(binary)) continue
          const key = `${binary} ${parts[1] ?? ''}`.trim()
          const row = rows.get(key) ?? { calls: 0, chars: 0, sizes: [], piped: 0 }
          row.calls += 1
          row.chars += chars
          row.sizes.push(chars)
          if (command.includes('|')) row.piped += 1
          rows.set(key, row)
          sessionsWithVcs.add(file)
          if (MUTATING.has(key)) {
            writeCalls += 1
            writeChars += chars
          } else {
            readCalls += 1
            readChars += chars
          }
          matched.push({ command, binary, key, chars, text })
        }
      }
    }
  }

  const vcsChars = readChars + writeChars
  const vcsCalls = readCalls + writeCalls

  console.log(`transcripts:      ${files.length} files, ${sessionsSeen.size} sessions`)
  console.log(
    `tool_result:      ${totalResultCalls} calls, ${totalResultChars} chars (~${Math.round(totalResultChars / 4)} tok)`,
  )
  console.log(
    `  Bash:           ${bashCalls} calls, ${bashChars} chars (${pct(bashChars, totalResultChars)} of all)`,
  )
  console.log(
    `  git/gh/…:       ${vcsCalls} calls, ${vcsChars} chars (${pct(vcsChars, bashChars)} of Bash, ${pct(vcsChars, totalResultChars)} of all)`,
  )
  console.log(
    `  read vs write:  ${readCalls} reads / ${readChars} chars · ${writeCalls} writes / ${writeChars} chars`,
  )
  console.log(
    `  sessions:       ${sessionsWithVcs.size} touched git (${pct(sessionsWithVcs.size, sessionsSeen.size)}), ` +
      `${sessionsSeen.size - sessionsWithVcs.size} git-free`,
  )

  console.log('\ntop tools by tool_result chars')
  const tools = [...byTool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  for (const [name, chars] of tools) {
    console.log(`  ${pad(name || '(unnamed)', 16)} ${padLeft(String(chars), 9)}  ${pct(chars, totalResultChars)}`)
  }

  console.log('\nper command shape')
  console.log(
    `  ${pad('command', 22)} ${padLeft('calls', 6)} ${padLeft('chars', 9)} ${padLeft('mean', 7)} ${padLeft('p90', 7)} ${padLeft('max', 7)} ${padLeft('piped', 6)}`,
  )
  const ordered = [...rows.entries()].sort((a, b) => b[1].chars - a[1].chars).slice(0, 25)
  for (const [key, row] of ordered) {
    const sorted = [...row.sizes].sort((a, b) => a - b)
    console.log(
      `  ${pad(key, 22)} ${padLeft(String(row.calls), 6)} ${padLeft(String(row.chars), 9)} ` +
        `${padLeft(String(Math.round(row.chars / row.calls)), 7)} ${padLeft(String(quantile(sorted, 0.9)), 7)} ` +
        `${padLeft(String(sorted[sorted.length - 1] ?? 0), 7)} ${padLeft(String(row.piped), 6)}`,
    )
  }

  if (jsonOut) {
    mkdirSync(dirname(jsonOut), { recursive: true })
    writeFileSync(jsonOut, JSON.stringify(matched, null, 0))
    console.log(`\ncorpus: ${matched.length} calls → ${jsonOut}`)
  }
}

main()
