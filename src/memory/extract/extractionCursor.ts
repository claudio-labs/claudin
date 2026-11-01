/**
 * Where a session's memory extraction stopped: the uuid of the last message
 * it considered. The cursor used to live in the extraction's closure only, so
 * a restart, a `--resume` or an in-process `/resume` started it over and the
 * fork re-read the session from its first message (and, counting turns since
 * the restart, rarely fired at all: 0 extraction requests in nine days of
 * October 2026, a median session being ~6 prompts).
 *
 * One small file per session beside its transcript,
 * `<projectDir>/<sessionId>.memory-cursor` — two sessions never write the
 * same one, and the session listings read `*.jsonl` only. Best-effort: a
 * cursor that cannot be read or written makes the next extraction read more,
 * never less.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { isENOENT } from 'src/shared/errors.js'
import { logError } from 'src/shared/log.js'

export type ExtractionCursorStore = {
  read(sessionId: string): string | undefined
  write(sessionId: string, uuid: string): void
}

/** A cursor file's suffix: platform/cleanup.ts sweeps them with the transcripts. */
export const CURSOR_SUFFIX = '.memory-cursor'

/** A store over `dir()`, the session's project dir (sessionStorage.ts getProjectDir). */
export function fileCursorStore(dir: () => string): ExtractionCursorStore {
  const pathOf = (sessionId: string) => join(dir(), `${sessionId}${CURSOR_SUFFIX}`)
  return {
    read(sessionId) {
      try {
        const uuid = readFileSync(pathOf(sessionId), 'utf8').trim()
        return uuid === '' ? undefined : uuid
      } catch (e) {
        if (!isENOENT(e)) logError(e)
        return undefined
      }
    },
    write(sessionId, uuid) {
      try {
        mkdirSync(dir(), { recursive: true })
        writeFileSync(pathOf(sessionId), `${uuid}\n`)
      } catch (e) {
        logError(e)
      }
    },
  }
}
