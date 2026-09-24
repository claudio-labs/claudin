// CLAUDIN_READ_MULTI is read once, at module load, by every module whose
// surface it changes (schemas.ts, prompt.ts, FileReadTool.ts) — the same
// shape as the Bash pass-through flag. Setting it inside a test would reach
// nothing already loaded, so each arm loads its own instance of the module
// under test with the variable set the way that arm needs it. That also keeps
// each arm honest when the developer's shell exports the variable.
//
// The batch Read is on by default, and `=0` is its killswitch: the off arm
// sets `0` rather than deleting the variable, which would now mean "on". The
// default arm (importWithReadMultiUnset) is the one that deletes it.
//
// This is NOT a `*.test.ts` file: it declares no tests and bun does not
// collect it.

export const READ_MULTI_ENV = 'CLAUDIN_READ_MULTI'

let loadSeq = 0

/**
 * A fresh instance of `specifier` (a `src/…` module path ending in `.js`),
 * evaluated with CLAUDIN_READ_MULTI=1 (on) or =0 (the killswitch). Only that
 * module is re-evaluated; everything it imports is the process-wide instance.
 */
export async function importWithReadMulti<T>(
  specifier: string,
  on: boolean,
): Promise<T> {
  return importWith<T>(specifier, on ? '1' : '0', on ? 'on' : 'off')
}

/** The same, with the variable unset: the default a user gets. */
export async function importWithReadMultiUnset<T>(specifier: string): Promise<T> {
  return importWith<T>(specifier, undefined, 'unset')
}

async function importWith<T>(
  specifier: string,
  value: string | undefined,
  tag: string,
): Promise<T> {
  const prior = process.env[READ_MULTI_ENV]
  if (value === undefined) delete process.env[READ_MULTI_ENV]
  else process.env[READ_MULTI_ENV] = value
  try {
    return (await import(`${specifier}?readmulti=${tag}-${++loadSeq}`)) as T
  } finally {
    if (prior === undefined) delete process.env[READ_MULTI_ENV]
    else process.env[READ_MULTI_ENV] = prior
  }
}
