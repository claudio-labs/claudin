// CLAUDIN_READ_MULTI is read once, at module load, by every module whose
// surface it changes (schemas.ts, prompt.ts, FileReadTool.ts) — the same
// shape as the Bash pass-through flag. Setting it inside a test would reach
// nothing already loaded, so each arm loads its own instance of the module
// under test with the variable set the way that arm needs it. That also keeps
// the flag-off arm honest when the developer's shell exports the variable.
//
// This is NOT a `*.test.ts` file: it declares no tests and bun does not
// collect it.

export const READ_MULTI_ENV = 'CLAUDIN_READ_MULTI'

let loadSeq = 0

/**
 * A fresh instance of `specifier` (a `src/…` module path ending in `.js`),
 * evaluated with CLAUDIN_READ_MULTI on or off. Only that module is
 * re-evaluated; everything it imports is the process-wide instance.
 */
export async function importWithReadMulti<T>(
  specifier: string,
  on: boolean,
): Promise<T> {
  const prior = process.env[READ_MULTI_ENV]
  if (on) process.env[READ_MULTI_ENV] = '1'
  else delete process.env[READ_MULTI_ENV]
  try {
    return (await import(
      `${specifier}?readmulti=${on ? 'on' : 'off'}-${++loadSeq}`
    )) as T
  } finally {
    if (prior === undefined) delete process.env[READ_MULTI_ENV]
    else process.env[READ_MULTI_ENV] = prior
  }
}
