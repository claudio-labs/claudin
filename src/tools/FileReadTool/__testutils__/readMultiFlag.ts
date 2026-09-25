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
// CLAUDIN_READ_GLOBS (readGlobs.ts) changes the same three modules, so every
// arm pins it too: unset — off, the default — unless the arm is the globs one
// (importWithReadGlobs).
//
// This is NOT a `*.test.ts` file: it declares no tests and bun does not
// collect it.

export const READ_MULTI_ENV = 'CLAUDIN_READ_MULTI'
const READ_GLOBS_ENV = 'CLAUDIN_READ_GLOBS'

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
  return importWith<T>(specifier, { [READ_MULTI_ENV]: on ? '1' : '0' }, on ? 'on' : 'off')
}

/** The same, with the variable unset: the default a user gets. */
export async function importWithReadMultiUnset<T>(specifier: string): Promise<T> {
  return importWith<T>(specifier, {}, 'unset')
}

/**
 * A fresh instance with the batch Read at its default and CLAUDIN_READ_GLOBS
 * set to 1 (on) or unset (off, the default).
 */
export async function importWithReadGlobs<T>(specifier: string, on: boolean): Promise<T> {
  return importWith<T>(
    specifier,
    { [READ_GLOBS_ENV]: on ? '1' : undefined },
    on ? 'globs-on' : 'globs-off',
  )
}

async function importWith<T>(
  specifier: string,
  values: Record<string, string | undefined>,
  tag: string,
): Promise<T> {
  const env: Record<string, string | undefined> = {
    [READ_MULTI_ENV]: undefined,
    [READ_GLOBS_ENV]: undefined,
    ...values,
  }
  const prior = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]))
  for (const [name, value] of Object.entries(env)) setEnv(name, value)
  try {
    return (await import(`${specifier}?readmulti=${tag}-${++loadSeq}`)) as T
  } finally {
    for (const [name, value] of Object.entries(prior)) setEnv(name, value)
  }
}

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
