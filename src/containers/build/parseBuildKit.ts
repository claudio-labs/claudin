// Pure parser for `docker build --progress=plain` / `docker compose build
// --progress=plain`.
//
// The reason this exists rather than a `| tail -N`: BuildKit runs steps in
// parallel and INTERLEAVES their output on one stream, every line prefixed with
// the `#N` of the step that produced it. When a step fails, the lines that
// follow the error usually belong to a *different* step that was still running.
// A tail therefore hands back the wrong text, confidently. Bucketing by `#N`
// and answering with the failing step's own bucket is the whole point.
//
// Nothing here does I/O. `parseBuildKit` runs once, on the whole log, at the
// end; `buildProgressLabel` runs every second on a growing tail and only ever
// scans backwards to the newest step header.

/** `#8 [4/6] RUN pip install`, `#1 [internal] load build definition`. */
const STEP_LINE_RE = /^#(\d+)\s+(.*)$/
/** `DONE 4.9s` — the trailing duration of a completed step. */
const DONE_RE = /^DONE\s+([\d.]+)s\s*$/
/** `ERROR: process "/bin/sh -c pip install" did not complete successfully: exit code 1` */
const ERROR_RE = /^ERROR:\s*(.*)$/
/** A content line is prefixed with its offset in seconds: `#8 1.402 Collecting`. */
const CONTENT_RE = /^(\d+(?:\.\d+)?)\s(.*)$/
/** `transferring context: 1.24GB 23.7s done` — the missing-.dockerignore signal. */
const TRANSFERRING_CONTEXT_RE = /^transferring context:\s+([\d.]+)\s*([a-zA-Z]+)/
/** `[4/7] RUN …` — a real Dockerfile stage, as opposed to `[internal] …`. */
const STAGE_LABEL_RE = /^\[(\d+)\/(\d+)\]\s*(.*)$/
/** The base-image resolve stage, which is never CACHED even on a warm rebuild. */
const FROM_STAGE_RE = /^FROM\b/
/** `process "/bin/sh -c pip install -r requirements.txt"` */
const FAILED_COMMAND_RE = /process\s+"([^"]*)"/
/** `did not complete successfully: exit code 1` */
const EXIT_CODE_RE = /exit code:?\s*(\d+)/
/** `writing image sha256:9f2c…  done` */
const WRITING_IMAGE_RE = /^writing image\s+(\S+)/
/** `naming to docker.io/library/legendarr:latest done` */
const NAMING_TO_RE = /^naming to\s+(\S+)/
/** BuildKit's "this step resumed" marker, which carries no information. */
const RESUME_MARKER = '...'

/** How much of a step label fits on one row beside the tool name and the clock. */
const MAX_LABEL_CHARS = 90

/**
 * Size suffixes BuildKit prints. It emits decimal units by default (kB/MB/GB)
 * but the binary spellings turn up in some drivers, so both are accepted.
 */
const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1_000,
  mb: 1_000_000,
  gb: 1_000_000_000,
  tb: 1_000_000_000_000,
  kib: 1_024,
  mib: 1_024 ** 2,
  gib: 1_024 ** 3,
  tib: 1_024 ** 4,
}

export type BuildStep = {
  /** The `#N` BuildKit assigned. */
  index: number
  /** `[4/7] RUN pip install -r requirements.txt`, `[internal] load build context`. */
  label: string
  cached: boolean
  durationMs: number | null
  /** True for a `[N/M]` Dockerfile stage; false for `[internal]` and export work. */
  isStage: boolean
}

export type BuildFailure = {
  /** The `#N` of the step that failed. */
  stepIndex: number
  /** That step's own label, e.g. `[4/7] RUN pip install -r requirements.txt`. */
  stepLabel: string
  /** The command from `process "…"`, when BuildKit named one. */
  command: string | null
  exitCode: number | null
  /** BuildKit's own error text, minus the `ERROR:` prefix. */
  message: string
  /** THAT step's output lines, in order. Never a tail of the whole log. */
  output: string[]
}

export type BuildKitSummary = {
  steps: BuildStep[]
  /** Stages BuildKit reported as CACHED. */
  cachedCount: number
  /** Stages that actually ran, excluding the `FROM` resolve. */
  rebuiltCount: number
  /** Bytes from the largest `transferring context:` reading, or null. */
  contextBytes: number | null
  /**
   * Nothing was rebuilt, so the caller reports "up to date" rather than a clean
   * build. Requires POSITIVE evidence — at least one cached stage — and no
   * stage that ran, mirroring `BuildTool/noOp.ts`'s rule that silence is not
   * proof.
   */
  allCached: boolean
  failure: BuildFailure | null
  /** Image digests and tags the export step named, when it named any. */
  writtenImages: string[]
}

/** `1.24` + `GB` → bytes. Unknown units yield null rather than a wrong number. */
export function parseSize(value: string, unit: string): number | null {
  const n = Number.parseFloat(value)
  if (!Number.isFinite(n)) return null
  const multiplier = SIZE_UNITS[unit.toLowerCase()]
  if (multiplier === undefined) return null
  return Math.round(n * multiplier)
}

type StepAccumulator = {
  index: number
  label: string | null
  cached: boolean
  durationMs: number | null
  output: string[]
}

function emptyStep(index: number): StepAccumulator {
  return { index, label: null, cached: false, durationMs: null, output: [] }
}

function isStageLabel(label: string): boolean {
  return STAGE_LABEL_RE.test(label)
}

/** The `RUN pip install …` part of `[4/7] RUN pip install …`. */
function stageCommand(label: string): string | null {
  const m = STAGE_LABEL_RE.exec(label)
  return m?.[3] ?? null
}

/**
 * Parse a whole build log.
 *
 * Tolerant by construction: a line that matches nothing is ignored, so a
 * BuildKit version that spells something differently degrades to fewer facts
 * rather than to an exception.
 */
export function parseBuildKit(raw: string): BuildKitSummary {
  const steps = new Map<number, StepAccumulator>()
  /** Insertion order, so the reported steps follow the build rather than `#N`. */
  const order: number[] = []
  let contextBytes: number | null = null
  const writtenImages: string[] = []
  let failure: {
    stepIndex: number
    message: string
    command: string | null
    exitCode: number | null
  } | null = null

  for (const line of raw.split('\n')) {
    const m = STEP_LINE_RE.exec(line.trimEnd())
    if (!m?.[1]) continue
    const index = Number.parseInt(m[1], 10)
    if (!Number.isFinite(index)) continue
    const rest = (m[2] ?? '').trim()
    if (rest === '' || rest === RESUME_MARKER) continue

    let step = steps.get(index)
    if (!step) {
      step = emptyStep(index)
      steps.set(index, step)
      order.push(index)
    }

    const done = DONE_RE.exec(rest)
    if (done?.[1]) {
      const seconds = Number.parseFloat(done[1])
      if (Number.isFinite(seconds)) step.durationMs = Math.round(seconds * 1000)
      continue
    }

    if (rest === 'CACHED') {
      step.cached = true
      continue
    }

    // CANCELED marks a step aborted because another one failed. It is neither
    // cached nor rebuilt and carries no diagnosis, so it is only consumed here
    // to keep it out of the content bucket.
    if (rest === 'CANCELED') continue

    const errored = ERROR_RE.exec(rest)
    if (errored) {
      const message = (errored[1] ?? '').trim()
      // The LAST error wins: BuildKit repeats the summary at the end, and a
      // build that failed after a retry prints more than one.
      failure = {
        stepIndex: index,
        message,
        command: FAILED_COMMAND_RE.exec(message)?.[1] ?? null,
        exitCode: (() => {
          const code = EXIT_CODE_RE.exec(message)?.[1]
          if (!code) return null
          const n = Number.parseInt(code, 10)
          return Number.isFinite(n) ? n : null
        })(),
      }
      continue
    }

    const transferring = TRANSFERRING_CONTEXT_RE.exec(rest)
    if (transferring?.[1] && transferring[2]) {
      const bytes = parseSize(transferring[1], transferring[2])
      // Two steps print this line — `load .dockerignore` and `load build
      // context` — and the second prints a running total. The largest reading
      // is therefore the build context's final size, which is the number that
      // answers "why is this build slow".
      if (bytes !== null && (contextBytes === null || bytes > contextBytes)) {
        contextBytes = bytes
      }
      continue
    }

    const written = WRITING_IMAGE_RE.exec(rest)
    if (written?.[1]) {
      if (!writtenImages.includes(written[1])) writtenImages.push(written[1])
      continue
    }

    const named = NAMING_TO_RE.exec(rest)
    if (named?.[1]) {
      if (!writtenImages.includes(named[1])) writtenImages.push(named[1])
      continue
    }

    const content = CONTENT_RE.exec(rest)
    if (content?.[2] !== undefined) {
      step.output.push(content[2])
      continue
    }

    // Anything left is a step header. BuildKit reprints it every time the step
    // resumes, so the FIRST one is kept — they are identical, and the first is
    // the one that names the stage.
    if (step.label === null) step.label = rest
  }

  const built: BuildStep[] = order.map(index => {
    const step = steps.get(index)!
    const label = step.label ?? `#${index}`
    return {
      index,
      label,
      cached: step.cached,
      durationMs: step.durationMs,
      isStage: isStageLabel(label),
    }
  })

  const stages = built.filter(s => s.isStage)
  const cachedCount = stages.filter(s => s.cached).length
  const rebuiltCount = stages.filter(
    s => !s.cached && !FROM_STAGE_RE.test(stageCommand(s.label) ?? ''),
  ).length

  return {
    steps: built,
    cachedCount,
    rebuiltCount,
    contextBytes,
    allCached: cachedCount > 0 && rebuiltCount === 0,
    failure: failure
      ? {
          stepIndex: failure.stepIndex,
          stepLabel: steps.get(failure.stepIndex)?.label ?? `#${failure.stepIndex}`,
          command: failure.command,
          exitCode: failure.exitCode,
          message: failure.message,
          // The failing step's OWN bucket. Lines emitted by other steps after
          // the error — which is what a tail would return — are not in it.
          output: steps.get(failure.stepIndex)?.output ?? [],
        }
      : null,
    writtenImages,
  }
}

/**
 * What the build is doing right now, in one line.
 *
 * Called every second against a tail of the output file, so it scans backwards
 * and stops at the first step header rather than parsing the log. A missed
 * match costs a slightly worse label for one second, never a wrong result —
 * same contract as `BuildTool/progressLine.ts`.
 */
export function buildProgressLabel(tail: string): string | null {
  if (!tail.trim()) return null
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = STEP_LINE_RE.exec(lines[i]!.trimEnd())
    if (!m?.[2]) continue
    const rest = m[2].trim()
    if (rest === '' || rest === RESUME_MARKER || rest === 'CACHED') continue
    if (rest === 'CANCELED' || DONE_RE.test(rest) || ERROR_RE.test(rest)) continue
    if (CONTENT_RE.test(rest)) continue
    if (TRANSFERRING_CONTEXT_RE.test(rest)) continue
    if (WRITING_IMAGE_RE.test(rest) || NAMING_TO_RE.test(rest)) continue
    const collapsed = rest.replace(/\s+/g, ' ').trim()
    if (!collapsed) continue
    return collapsed.length > MAX_LABEL_CHARS
      ? `${collapsed.slice(0, MAX_LABEL_CHARS - 1)}…`
      : collapsed
  }
  return null
}
