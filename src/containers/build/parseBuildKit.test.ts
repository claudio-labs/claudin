import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildProgressLabel,
  parseBuildKit,
  parseSize,
} from 'src/containers/build/parseBuildKit.js'

const FIXTURES = join(import.meta.dir, '__fixtures__')

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8')
}

describe('parseSize', () => {
  test('decimal units, which is what BuildKit prints by default', () => {
    expect(parseSize('842', 'B')).toBe(842)
    expect(parseSize('1.02', 'kB')).toBe(1_020)
    expect(parseSize('1.82', 'MB')).toBe(1_820_000)
    expect(parseSize('1.24', 'GB')).toBe(1_240_000_000)
  })

  test('binary units too, since some drivers spell it that way', () => {
    expect(parseSize('1', 'KiB')).toBe(1_024)
    expect(parseSize('1', 'MiB')).toBe(1_048_576)
    expect(parseSize('2', 'GiB')).toBe(2_147_483_648)
  })

  test('an unknown unit is null rather than a wrong number', () => {
    expect(parseSize('1.5', 'parsecs')).toBeNull()
    expect(parseSize('not-a-number', 'MB')).toBeNull()
  })
})

describe('parseBuildKit — clean build', () => {
  const summary = parseBuildKit(fixture('clean-build.txt'))

  test('splits cached stages from rebuilt ones', () => {
    // WORKDIR and COPY requirements.txt were cached; the two RUNs and the
    // second COPY actually ran. The FROM resolve counts as neither.
    expect(summary.cachedCount).toBe(2)
    expect(summary.rebuiltCount).toBe(3)
    expect(summary.allCached).toBe(false)
  })

  test('reports no failure', () => {
    expect(summary.failure).toBeNull()
  })

  test('names the image the export step wrote', () => {
    expect(summary.writtenImages).toContain(
      'docker.io/library/legendarr:latest',
    )
    expect(
      summary.writtenImages.some(i => i.startsWith('sha256:')),
    ).toBe(true)
  })

  test('records each step once, with its duration', () => {
    const run = summary.steps.find(s =>
      s.label.startsWith('[4/6] RUN pip install'),
    )
    expect(run).toBeDefined()
    expect(run?.durationMs).toBe(4_900)
    expect(run?.isStage).toBe(true)
    // The header is reprinted on every resume; it must not produce two steps.
    expect(summary.steps.filter(s => s.index === run?.index)).toHaveLength(1)
  })

  test('marks [internal] work as not a stage', () => {
    const internal = summary.steps.find(s =>
      s.label.startsWith('[internal] load build context'),
    )
    expect(internal?.isStage).toBe(false)
  })

  test('a small context is still reported', () => {
    expect(summary.contextBytes).toBe(1_820_000)
  })
})

describe('parseBuildKit — fully cached rebuild', () => {
  const summary = parseBuildKit(fixture('cached-noop.txt'))

  test('allCached is true so the caller reports a no-op, not a clean build', () => {
    expect(summary.allCached).toBe(true)
    expect(summary.rebuiltCount).toBe(0)
    expect(summary.cachedCount).toBe(5)
  })

  test('the FROM resolve is not counted as a rebuilt stage', () => {
    // `[1/6] FROM …` reports DONE rather than CACHED even on a warm rebuild.
    // Counting it as work would make a no-op look like a real build.
    const from = summary.steps.find(s => s.label.includes('FROM'))
    expect(from?.cached).toBe(false)
    expect(summary.rebuiltCount).toBe(0)
  })

  test('an empty log claims nothing', () => {
    const empty = parseBuildKit('')
    expect(empty.allCached).toBe(false)
    expect(empty.steps).toEqual([])
  })
})

describe('parseBuildKit — fat build context', () => {
  const summary = parseBuildKit(fixture('fat-context.txt'))

  test('takes the final total, not an intermediate reading', () => {
    expect(summary.contextBytes).toBe(1_240_000_000)
  })

  test('the tiny .dockerignore transfer does not win', () => {
    // `[internal] load .dockerignore` prints `transferring context: 2B` from a
    // different step number; the largest reading is the build context.
    expect(summary.contextBytes).toBeGreaterThan(1_000_000_000)
  })
})

describe('parseBuildKit — failed RUN', () => {
  const raw = fixture('failed-run.txt')
  const summary = parseBuildKit(raw)

  test('identifies the failing step, its command and its exit code', () => {
    expect(summary.failure).not.toBeNull()
    expect(summary.failure?.stepIndex).toBe(8)
    expect(summary.failure?.stepLabel).toBe(
      '[4/7] RUN pip install --no-cache-dir -r requirements.txt',
    )
    expect(summary.failure?.command).toBe(
      '/bin/sh -c pip install --no-cache-dir -r requirements.txt',
    )
    expect(summary.failure?.exitCode).toBe(1)
  })

  test('the failure block is the failing step OWN output', () => {
    const output = summary.failure?.output ?? []
    expect(output.join('\n')).toContain('Collecting fastapi==0.115.0')
    expect(output.join('\n')).toContain(
      'No matching distribution found for flask==99.99.99',
    )
  })

  test('a naive tail would return the wrong step — this one does not', () => {
    // The fixture has step #6 (apt-get) emitting 12 lines AFTER #8's ERROR.
    // Prove the trap is real first: the log's own tail IS the apt-get output.
    const tailOfWholeLog = raw.trimEnd().split('\n').slice(-20).join('\n')
    expect(tailOfWholeLog).toContain('Setting up libavcodec59')

    // And prove the parser does not fall into it.
    const output = (summary.failure?.output ?? []).join('\n')
    expect(output).not.toContain('Setting up libavcodec59')
    expect(output).not.toContain('apt')
    expect(output).not.toContain('ffmpeg')
    expect(output).not.toContain('Unpacking')
  })

  test('the reproduced ------ block is not counted twice', () => {
    // BuildKit reprints the failing step's lines under a `------` banner with
    // no `#N` prefix. Those must not land in the bucket a second time.
    const output = summary.failure?.output ?? []
    const downloads = output.filter(l => l.includes('Downloading fastapi'))
    expect(downloads).toHaveLength(1)
  })

  test('CANCELED sibling steps are neither cached nor rebuilt output', () => {
    const canceled = summary.steps.find(s => s.index === 6)
    expect(canceled?.cached).toBe(false)
    expect(canceled?.label).toBe(
      '[2/7] RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg',
    )
  })
})

describe('parseBuildKit — tolerance', () => {
  test('unrecognised lines are ignored, never thrown on', () => {
    const weird = [
      'some preamble with no step number',
      '#3 [1/1] RUN true',
      '#3 quantum flux capacitor engaged',
      '#3 DONE 0.1s',
      'trailing garbage',
    ].join('\n')
    expect(() => parseBuildKit(weird)).not.toThrow()
    const summary = parseBuildKit(weird)
    expect(summary.steps).toHaveLength(1)
    expect(summary.steps[0]?.label).toBe('[1/1] RUN true')
  })

  test('an error with no command or exit code still names the step', () => {
    const raw = [
      '#5 [2/3] COPY missing.txt .',
      '#5 ERROR: failed to compute cache key: "/missing.txt" not found',
    ].join('\n')
    const summary = parseBuildKit(raw)
    expect(summary.failure?.stepIndex).toBe(5)
    expect(summary.failure?.stepLabel).toBe('[2/3] COPY missing.txt .')
    expect(summary.failure?.command).toBeNull()
    expect(summary.failure?.exitCode).toBeNull()
    expect(summary.failure?.message).toContain('failed to compute cache key')
  })

  test('a step that only ever errored still reports a label', () => {
    const summary = parseBuildKit('#9 ERROR: something went wrong')
    expect(summary.failure?.stepLabel).toBe('#9')
  })
})

describe('buildProgressLabel', () => {
  test('returns the most recently started step', () => {
    expect(buildProgressLabel(fixture('failed-run.txt'))).toBe(
      '[4/7] RUN pip install --no-cache-dir -r requirements.txt',
    )
  })

  test('skips DONE, CACHED, ERROR and content lines', () => {
    const tail = [
      '#8 [4/7] RUN pip install -r requirements.txt',
      '#8 0.512 Collecting fastapi',
      '#8 DONE 4.9s',
    ].join('\n')
    expect(buildProgressLabel(tail)).toBe('[4/7] RUN pip install -r requirements.txt')
  })

  test('skips the export chatter so the label stays a step', () => {
    const tail = [
      '#11 exporting to image',
      '#11 writing image sha256:abc done',
      '#11 naming to docker.io/library/app:latest done',
    ].join('\n')
    expect(buildProgressLabel(tail)).toBe('exporting to image')
  })

  test('null before anything has been printed', () => {
    expect(buildProgressLabel('')).toBeNull()
    expect(buildProgressLabel('   \n  \n')).toBeNull()
  })

  test('null when the tail holds only content lines', () => {
    expect(buildProgressLabel('#8 0.512 Collecting fastapi')).toBeNull()
  })

  test('truncates a very long step label', () => {
    const long = `#4 [1/2] RUN ${'echo hello && '.repeat(20)}true`
    const label = buildProgressLabel(long)
    expect(label).not.toBeNull()
    expect(label!.length).toBeLessThanOrEqual(90)
    expect(label!.endsWith('…')).toBe(true)
  })

  test('collapses the whitespace a step label may carry', () => {
    expect(buildProgressLabel('#4 [1/2]    RUN     true')).toBe('[1/2] RUN true')
  })
})
