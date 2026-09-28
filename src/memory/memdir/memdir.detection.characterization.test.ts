/**
 * Characterization of `memoryFileDetection.ts`: which paths, directories,
 * shell commands and glob patterns count as the agent's own memory. The
 * transcript's read/search collapsing and the Read tool's staleness note
 * decide on these answers.
 *
 * Paths are built from the world's real config dir, project and memory
 * directory. Windows spellings (drive letters, MinGW `/c/…`, case folding) are
 * not reachable on this platform and are not pinned.
 */
import { describe, expect, test } from 'bun:test'
import { join, sep } from 'node:path'
import {
  isAutoManagedMemoryFile,
  isAutoManagedMemoryPattern,
  isAutoMemFile,
  isMemoryDirectory,
  isShellCommandTargetingMemory,
} from 'src/memory/memdir/memoryFileDetection.js'
import { getAutoMemPath } from 'src/memory/memdir/paths.js'
import { useMemdirWorld } from 'src/memory/memdir/__testutils__/memdirWorld.js'

const world = useMemdirWorld()

/**
 * Every input in `memory` must be judged memory and every one in `other` not;
 * a failure lists the misjudged inputs.
 */
function judge(
  predicate: (input: string) => boolean,
  verdicts: { memory?: string[]; other?: string[] },
): void {
  const misjudged = {
    missed: (verdicts.memory ?? []).filter(input => !predicate(input)),
    wronglyClaimed: (verdicts.other ?? []).filter(input => predicate(input)),
  }
  expect(misjudged).toEqual({ missed: [], wronglyClaimed: [] })
}

/** Enters a repository, so the memory directory is <repo>/.claudin/memory/. */
function enterRepo(): { repo: string; memDir: string } {
  const w = world()
  const repo = w.repo(join(w.root, 'repo'))
  w.enter(repo)
  const memDir = getAutoMemPath()
  expect(memDir).toBe(join(repo, '.claudin', 'memory') + sep)
  return { repo, memDir }
}

/** The session files under the config home: a transcript and a session summary. */
function sessionFiles(): { transcript: string; summary: string; projectsDir: string } {
  const projectsDir = join(world().configDir, 'projects', 'slug-of-some-project')
  return {
    projectsDir,
    transcript: join(projectsDir, '5f0c2a51-session.jsonl'),
    summary: join(projectsDir, '5f0c2a51-session', 'session-memory', 'summary.md'),
  }
}

function disableAutoMemory(): void {
  process.env.CLAUDIN_DISABLE_AUTO_MEMORY = '1'
}

describe('isAutoMemFile', () => {
  test('below the memory directory, and only while auto memory is on', () => {
    const { repo, memDir } = enterRepo()
    const topic = join(memDir, 'prefers-tabs.md')
    judge(isAutoMemFile, {
      memory: [topic, join(memDir, 'team', 'bugs', 'flaky-lock.md')],
      other: [join(repo, 'src', 'index.ts')],
    })
    disableAutoMemory()
    judge(isAutoMemFile, { other: [topic] })
  })
})

describe('isAutoManagedMemoryFile', () => {
  test('memory-directory files, transcripts and session summaries', () => {
    const { memDir } = enterRepo()
    const { transcript, summary } = sessionFiles()
    judge(isAutoManagedMemoryFile, {
      memory: [join(memDir, 'MEMORY.md'), join(memDir, 'team', 'MEMORY.md'), transcript, summary],
    })
  })

  test('agent memory in its user, project and local scopes', () => {
    const { repo } = enterRepo()
    judge(isAutoManagedMemoryFile, {
      memory: [
        join(world().configDir, 'agent-memory', 'reviewer', 'notes.md'),
        join(repo, '.claudin', 'agent-memory', 'reviewer', 'notes.md'),
        join(repo, '.claudin', 'agent-memory-local', 'reviewer', 'notes.md'),
      ],
    })
  })

  test('user-managed instruction files are not memory', () => {
    const { repo } = enterRepo()
    const config = world().configDir
    judge(isAutoManagedMemoryFile, {
      other: [
        join(repo, 'CLAUDE.md'),
        join(repo, 'AGENTS.md'),
        join(repo, 'CLAUDE.local.md'),
        join(repo, '.claudin', 'rules', 'testing.md'),
        join(config, 'CLAUDE.md'),
        join(config, 'rules', 'style.md'),
        join(config, 'settings.json'),
      ],
    })
  })

  test('a session file needs the config home and the right extension', () => {
    enterRepo()
    const { projectsDir } = sessionFiles()
    const elsewhere = join(world().root, 'elsewhere')
    judge(isAutoManagedMemoryFile, {
      other: [
        join(projectsDir, 's', 'session-memory', 'summary.txt'),
        join(projectsDir, 'transcript.json'),
        join(elsewhere, 'projects', 'p', 's.jsonl'),
        join(elsewhere, 'session-memory', 'summary.md'),
      ],
    })
  })

  test('with auto memory off, memory and agent files stop counting; session files still count', () => {
    const { repo, memDir } = enterRepo()
    const { transcript, summary } = sessionFiles()
    disableAutoMemory()
    judge(isAutoManagedMemoryFile, {
      memory: [transcript, summary],
      other: [join(memDir, 'prefers-tabs.md'), join(repo, '.claudin', 'agent-memory', 'a', 'n.md')],
    })
  })
})

describe('isMemoryDirectory', () => {
  test('the memory directory with or without its separator, and what is below it', () => {
    const { repo, memDir } = enterRepo()
    judge(isMemoryDirectory, {
      memory: [memDir, join(repo, '.claudin', 'memory'), join(memDir, 'team'), join(memDir, 'team', 'bugs')],
    })
  })

  test('agent memory directories, wherever they are', () => {
    const { repo } = enterRepo()
    judge(isMemoryDirectory, {
      memory: [
        join(repo, '.claudin', 'agent-memory', 'reviewer') + sep,
        join(repo, '.claudin', 'agent-memory-local', 'reviewer') + sep,
        join(world().root, 'anywhere', 'agent-memory', 'x') + sep,
      ],
    })
  })

  test('under the config home: transcripts, session memory and memory directories', () => {
    enterRepo()
    const { projectsDir } = sessionFiles()
    judge(isMemoryDirectory, {
      memory: [
        projectsDir + sep,
        join(projectsDir, 's', 'session-memory') + sep,
        join(world().configDir, 'projects', 'p', 'memory') + sep,
      ],
    })
  })

  test('other directories are not memory, the config home itself included', () => {
    const { repo, memDir } = enterRepo()
    const config = world().configDir
    judge(isMemoryDirectory, {
      other: [
        join(repo, 'src'),
        join(repo, '.claudin', 'rules'),
        config,
        join(config, 'plugins') + sep,
        join(repo, '.claudin', 'memory-old'),
        `${memDir}..${sep}..${sep}src`,
      ],
    })
  })

  test('with auto memory off, only session memory and transcripts under the config home remain', () => {
    const { memDir } = enterRepo()
    const w = world()
    const { projectsDir } = sessionFiles()
    disableAutoMemory()
    judge(isMemoryDirectory, {
      memory: [projectsDir + sep, join(w.configDir, 'x', 'session-memory') + sep],
      other: [
        memDir,
        join(w.root, 'anywhere', 'agent-memory', 'x') + sep,
        join(w.configDir, 'x', 'memory') + sep,
      ],
    })
  })

  test('a remote memory mount: its memory and session directories count, its projects/ alone does not', () => {
    enterRepo()
    const mount = world().mkdir('mount')
    process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR = mount
    judge(isMemoryDirectory, {
      memory: [join(mount, 'projects', 'p', 'memory') + sep, join(mount, 'x', 'session-memory') + sep],
      other: [join(mount, 'projects', 'p') + sep],
    })
  })
})

describe('isShellCommandTargetingMemory', () => {
  test('a command with a path in the memory directory, quoted or not', () => {
    const { memDir } = enterRepo()
    judge(isShellCommandTargetingMemory, {
      memory: [
        `grep -rn "flaky" ${memDir}`,
        `cat ${memDir}team/bugs/flaky-lock.md`,
        `rg lock "${memDir}team"`,
        `head -5 '${memDir}MEMORY.md'`,
      ],
    })
  })

  test('shell punctuation that ends a path token is not part of it', () => {
    const { repo } = enterRepo()
    const bare = join(repo, '.claudin', 'memory')
    judge(isShellCommandTargetingMemory, {
      memory: ['; echo done', '| wc -l', '&& echo ok', '> listing.txt', `, ${bare}`].map(
        tail => `ls ${bare}${tail}`,
      ),
    })
  })

  test('transcripts and session summaries under the config home', () => {
    enterRepo()
    const { transcript, summary } = sessionFiles()
    judge(isShellCommandTargetingMemory, {
      memory: [`grep -c error ${transcript}`, `cat ${summary} && echo`],
    })
  })

  test('a command naming no memory path is not memory', () => {
    const { repo } = enterRepo()
    const config = world().configDir
    judge(isShellCommandTargetingMemory, {
      other: [
        'grep -rn memory src/',
        'cat /etc/hosts',
        `cat ${join(repo, 'README.md')}`,
        `cat ${join(config, 'settings.json')}`,
        `echo ${config}`,
      ],
    })
  })

  test('with auto memory off, the project memory directory is not memory', () => {
    const { memDir } = enterRepo()
    disableAutoMemory()
    judge(isShellCommandTargetingMemory, { other: [`cat ${memDir}prefers-tabs.md`] })
  })
})

describe('isAutoManagedMemoryPattern', () => {
  test('session-memory and transcript patterns', () => {
    judge(isAutoManagedMemoryPattern, {
      memory: ['**/session-memory/*.md', 'session-memory/**', 'projects/**/*.jsonl', '**\\projects\\*.jsonl'],
      other: ['session-memory'],
    })
  })

  test('agent-memory patterns, only while auto memory is on', () => {
    const agentPatterns = [
      'agent-memory/reviewer/*.md',
      '.claudin/agent-memory-local/**',
      '.claudin\\agent-memory\\x\\*',
    ]
    judge(isAutoManagedMemoryPattern, { memory: agentPatterns })
    disableAutoMemory()
    judge(isAutoManagedMemoryPattern, { memory: ['**/session-memory/*.md'], other: agentPatterns })
  })

  test('ordinary patterns are not memory', () => {
    judge(isAutoManagedMemoryPattern, {
      other: ['**/*.ts', 'src/**/*.md', 'docs/*.md', 'agent-memory', '*.json'],
    })
  })
})
