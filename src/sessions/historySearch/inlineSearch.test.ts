import { describe, expect, test } from 'bun:test'
import type { HistoryEntry } from 'src/platform/config/config.js'
import { createInlineSearch, IDLE_VIEW, type SearchView } from 'src/sessions/historySearch/inlineSearch.js'
import type { PromptSnapshot } from 'src/sessions/historySearch/promptSnapshot.js'
import { SEARCH_KEY_OPERATIONS } from 'src/sessions/historySearch/searchKeys.js'
import { getInMemoryErrors } from 'src/shared/log.js'
import { DEFAULT_BINDINGS } from 'src/terminal/keybindings/defaultBindings.js'

const prompt = (display: string, pastedContents: HistoryEntry['pastedContents'] = {}): HistoryEntry => ({
  display,
  pastedContents,
})

const MINE: HistoryEntry['pastedContents'] = { 3: { id: 3, type: 'text', content: 'my own paste' } }
const THEIRS: HistoryEntry['pastedContents'] = { 1: { id: 1, type: 'text', content: 'stored paste' } }

/** The prompt box before any search: typed text, the cursor inside it, a paste attached. */
const TYPED: PromptSnapshot = { input: 'draft', cursorOffset: 2, mode: 'prompt', pastedContents: MINE }

/** Newest first, as the history reader hands prompts out. */
async function* newestFirst(entries: readonly HistoryEntry[]): AsyncGenerator<HistoryEntry> {
  yield* entries
}

/** A history each read of which waits until its turn is released, so that reads overlap. */
function slowHistory(entries: readonly HistoryEntry[]) {
  const reads: Array<() => void> = []
  const readHistory = () =>
    (async function* () {
      await new Promise<void>(resolve => reads.push(resolve))
      yield* entries
    })()
  return { readHistory, reads }
}

/** The caller's side: its prompt, its searching flag, what it was asked to submit, and what the footer shows. */
function openSearch(readHistory: () => AsyncIterable<HistoryEntry>, start: PromptSnapshot = TYPED) {
  const caller = {
    prompt: start,
    searching: false,
    submitted: [] as HistoryEntry[],
    view: IDLE_VIEW,
    views: [] as SearchView[],
  }
  const search = createInlineSearch({
    readHistory,
    currentPrompt: () => caller.prompt,
    writePrompt: prompt => {
      caller.prompt = { ...caller.prompt, ...prompt }
    },
    setSearching: searching => {
      caller.searching = searching
    },
    submit: entry => {
      caller.submitted.push(entry)
    },
    onViewChange: view => {
      caller.view = view
      caller.views.push(view)
    },
  })
  return { caller, search }
}

/** Long enough for reads of an in-memory history to land. */
const settle = () => Bun.sleep(5)

/** What logError recorded while `run` ran. It records nothing at the default privacy level, so that is lifted meanwhile. */
async function errorsLoggedBy(run: () => Promise<void>): Promise<string[]> {
  const previous = process.env.CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC
  process.env.CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC = '0'
  const before = getInMemoryErrors().length
  try {
    await run()
    return getInMemoryErrors()
      .slice(before)
      .map(entry => entry.error)
  } finally {
    if (previous === undefined) delete process.env.CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC
    else process.env.CLAUDIN_DISABLE_NONESSENTIAL_TRAFFIC = previous
  }
}

const HISTORY = [prompt('npm run build -- --watch'), prompt('!git status', THEIRS), prompt('git log'), prompt('npm run build')]

describe('createInlineSearch: a query', () => {
  test('starting remembers the prompt and changes nothing', () => {
    const { caller, search } = openSearch(() => newestFirst(HISTORY))
    search.start()
    expect(caller).toMatchObject({ prompt: TYPED, searching: true, view: IDLE_VIEW })
  })

  test('the newest match fills the prompt: its stored text, mode and pastes, the cursor on the query', async () => {
    const { caller, search } = openSearch(() => newestFirst(HISTORY))
    search.start()
    search.setQuery('status')
    await settle()
    expect(caller.prompt).toEqual({ input: '!git status', cursorOffset: 4, mode: 'bash', pastedContents: THEIRS })
    expect(caller.view).toEqual({ query: 'status', match: HISTORY[1], failed: false })
  })

  test('a query reaching into the ! puts the cursor at its place in the stored text', async () => {
    const { caller, search } = openSearch(() => newestFirst(HISTORY))
    search.start()
    search.setQuery('!git')
    await settle()
    expect(caller.prompt).toMatchObject({ input: '!git status', cursorOffset: 0, mode: 'bash' })
  })

  test('a query nothing matches fails and leaves the prompt alone', async () => {
    const { caller, search } = openSearch(() => newestFirst(HISTORY))
    search.start()
    search.setQuery('kubectl')
    await settle()
    expect(caller.view).toEqual({ query: 'kubectl', match: undefined, failed: true })
    expect(caller.prompt).toEqual(TYPED)
  })

  test('emptying the query puts back the whole prompt from the start, and the search goes on', async () => {
    const { caller, search } = openSearch(() => newestFirst(HISTORY))
    search.start()
    search.setQuery('status')
    await settle()
    search.setQuery('')
    expect(caller.prompt).toEqual(TYPED)
    expect(caller.view).toEqual(IDLE_VIEW)
    expect(caller.searching).toBe(true)
  })

  test('a read that fails is logged and reported as no match', async () => {
    async function* broken(): AsyncGenerator<HistoryEntry> {
      yield* []
      throw new Error('history unreadable')
    }
    const { caller, search } = openSearch(broken)
    const errors = await errorsLoggedBy(async () => {
      search.start()
      search.setQuery('npm')
      await settle()
    })
    expect(caller.view).toEqual({ query: 'npm', match: undefined, failed: true })
    expect(errors).toEqual([expect.stringContaining('history unreadable')])
  })
})

describe('createInlineSearch: queries that overlap', () => {
  test('typed as separate keys faster than the history is read, the newest match of the whole query wins', async () => {
    // Oldest first: npm run build, other, npm run build -- --watch.
    const history = slowHistory([prompt('npm run build -- --watch'), prompt('other'), prompt('npm run build')])
    const { caller, search } = openSearch(history.readHistory)
    search.start()
    for (const query of ['b', 'bu', 'bui', 'buil', 'build']) {
      search.setQuery(query)
      await settle()
    }
    expect(history.reads).toHaveLength(5)
    for (const release of history.reads) {
      release()
      await settle()
    }
    expect(caller.view).toEqual({ query: 'build', match: prompt('npm run build -- --watch'), failed: false })
    expect(caller.prompt).toMatchObject({ input: 'npm run build -- --watch', cursorOffset: 8 })
    // No read of an earlier query ever reached the prompt or the footer.
    expect(caller.views.filter(view => view.match !== undefined || view.failed)).toEqual([caller.view])
  })

  test('a read still in flight when the hook goes away is dropped', async () => {
    const history = slowHistory(HISTORY)
    const { caller, search } = openSearch(history.readHistory)
    search.start()
    search.setQuery('npm')
    await settle()
    search.dispose()
    history.reads[0]?.()
    await settle()
    expect(caller.prompt).toEqual(TYPED)
    expect(caller.view).toEqual({ query: 'npm', match: undefined, failed: false })
  })
})

describe('createInlineSearch: stepping', () => {
  test('steps to older matches once per text, then fails and keeps the last one', async () => {
    const { caller, search } = openSearch(() => newestFirst(HISTORY))
    search.start()
    search.setQuery('npm')
    await settle()
    search.step()
    await settle()
    expect(caller.view).toEqual({ query: 'npm', match: HISTORY[3], failed: false })
    search.step()
    search.step()
    await settle()
    expect(caller.view).toEqual({ query: 'npm', match: HISTORY[3], failed: true })
    expect(caller.prompt.input).toBe('npm run build')
  })

  test('with an empty query it acts like emptying the query', async () => {
    const { caller, search } = openSearch(() => newestFirst(HISTORY))
    search.start()
    search.setQuery('status')
    await settle()
    search.setQuery('')
    caller.prompt = { ...caller.prompt, input: 'changed behind its back' }
    search.step()
    await settle()
    expect(caller.prompt).toEqual(TYPED)
    expect(caller.view).toEqual(IDLE_VIEW)
    expect(caller.searching).toBe(true)
  })
})

describe('createInlineSearch: ending', () => {
  test('cancel puts back the whole prompt from the start, the mode included', async () => {
    const { caller, search } = openSearch(() => newestFirst(HISTORY))
    search.start()
    search.setQuery('status')
    await settle()
    expect(caller.prompt.mode).toBe('bash')
    search.cancel()
    expect(caller.prompt).toEqual(TYPED)
    expect(caller).toMatchObject({ searching: false, view: IDLE_VIEW, submitted: [] })
  })

  test('accept keeps the match without its !, in its mode, with its pastes, and the cursor where it was', async () => {
    const { caller, search } = openSearch(() => newestFirst(HISTORY))
    search.start()
    search.setQuery('status')
    await settle()
    search.accept()
    expect(caller.prompt).toEqual({ input: 'git status', cursorOffset: 4, mode: 'bash', pastedContents: THEIRS })
    expect(caller).toMatchObject({ searching: false, view: IDLE_VIEW, submitted: [] })
  })

  test('accept with nothing matched keeps the prompt and gives back its pastes', async () => {
    const { caller, search } = openSearch(() => newestFirst(HISTORY))
    search.start()
    caller.prompt = { ...caller.prompt, pastedContents: {} }
    search.setQuery('kubectl')
    await settle()
    search.accept()
    expect(caller.prompt).toEqual({ ...TYPED, pastedContents: MINE })
    expect(caller.searching).toBe(false)
  })

  test('submit sends the match without its !, in its mode', async () => {
    const { caller, search } = openSearch(() => newestFirst(HISTORY))
    search.start()
    search.setQuery('status')
    await settle()
    search.submit()
    expect(caller.submitted).toEqual([{ display: 'git status', pastedContents: THEIRS }])
    expect(caller).toMatchObject({ searching: false, view: IDLE_VIEW })
    expect(caller.prompt.mode).toBe('bash')
  })

  test('submit with an empty query sends the prompt from the start and changes nothing', () => {
    const { caller, search } = openSearch(() => newestFirst(HISTORY), { ...TYPED, mode: 'bash' })
    search.start()
    search.submit()
    expect(caller.submitted).toEqual([{ display: 'draft', pastedContents: MINE }])
    expect(caller.prompt).toEqual({ ...TYPED, mode: 'bash' })
  })

  test('submit when the query matched nothing sends nothing and still ends the search', async () => {
    const { caller, search } = openSearch(() => newestFirst(HISTORY))
    search.start()
    search.setQuery('kubectl')
    await settle()
    search.submit()
    expect(caller).toMatchObject({ submitted: [], searching: false, prompt: TYPED })
  })

  test('a search already running when this instance came up remembers the prompt at its first query', async () => {
    const { caller, search } = openSearch(() => newestFirst(HISTORY))
    search.setQuery('status')
    await settle()
    expect(caller.prompt.input).toBe('!git status')
    search.cancel()
    expect(caller.prompt).toEqual(TYPED)
  })
})

describe('the key table', () => {
  test("covers exactly the HistorySearch context's bindings, each with an operation of the search", () => {
    const bound = DEFAULT_BINDINGS.filter(block => block.context === 'HistorySearch').flatMap(block =>
      Object.values(block.bindings).flatMap(action => (action === null ? [] : [action])),
    )
    expect(Object.keys(SEARCH_KEY_OPERATIONS).sort()).toEqual([...new Set(bound)].sort())
    const { search } = openSearch(() => newestFirst([]))
    for (const operation of Object.values(SEARCH_KEY_OPERATIONS)) expect(search[operation]).toBeFunction()
  })
})
