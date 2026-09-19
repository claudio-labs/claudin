// The four command classifiers behind BashTool's UI and its backgrounding
// gates. None of them had a single test anywhere in the repo before this file,
// which is why it exists ahead of the split that moves them out.
//
// What each one decides:
//   isSearchOrReadBashCommand — whether the tool block collapses, and whether
//     the summary says "Searched", "Read" or "Listed"
//   isSilentBashCommand      — "Done" instead of "(No output)"
//   detectBlockedSleepPattern — whether a `sleep N` is refused in favour of Monitor
//   isAutobackgroundingAllowed — whether a long command may be auto-backgrounded
//
// The assertions lean on the negative cases on purpose. Every one of these is a
// set-membership test over a parsed segment, and the way that breaks is by
// getting WIDER — a prefix match instead of a whole word, one segment of a
// pipeline standing in for all of them — which no positive case can see.

import { describe, expect, test } from 'bun:test'

import {
  detectBlockedSleepPattern,
  isAutobackgroundingAllowed,
  isSearchOrReadBashCommand,
  isSilentBashCommand,
} from 'src/tools/BashTool/BashTool.js'

const NOT_COLLAPSIBLE = { isSearch: false, isRead: false, isList: false }

describe('isSearchOrReadBashCommand', () => {
  test('classifies a single command into exactly one of the three kinds', () => {
    expect(isSearchOrReadBashCommand('grep foo file')).toEqual({
      isSearch: true,
      isRead: false,
      isList: false,
    })
    expect(isSearchOrReadBashCommand('cat file')).toEqual({
      isSearch: false,
      isRead: true,
      isList: false,
    })
    // ls/tree/du are their own set so the summary can say "Listed N
    // directories" rather than the misleading "Read N files".
    expect(isSearchOrReadBashCommand('ls -la')).toEqual({
      isSearch: false,
      isRead: false,
      isList: true,
    })
  })

  test('a pipeline reports every kind it contains', () => {
    expect(isSearchOrReadBashCommand('cat f | grep x')).toEqual({
      isSearch: true,
      isRead: true,
      isList: false,
    })
  })

  test('one non-read segment disqualifies the whole command', () => {
    // The all-or-nothing rule, and the single most important property here:
    // collapsing `cat f | xargs rm` would hide a deletion behind a "Read"
    // summary. A classifier that ORed its segments instead of requiring all of
    // them would pass every other test in this file.
    expect(isSearchOrReadBashCommand('cat f | xargs rm')).toEqual(NOT_COLLAPSIBLE)
    expect(isSearchOrReadBashCommand('ls; rm -rf x')).toEqual(NOT_COLLAPSIBLE)
    expect(isSearchOrReadBashCommand('ls && rm x')).toEqual(NOT_COLLAPSIBLE)
  })

  test('semantic-neutral commands are skipped in any position', () => {
    // echo/printf/true/false/: are pure output, so they neither add a kind nor
    // disqualify the command around them.
    expect(isSearchOrReadBashCommand('ls dir && echo "---" && ls dir2')).toEqual({
      isSearch: false,
      isRead: false,
      isList: true,
    })
  })

  test('a command that is ONLY neutral is not collapsible', () => {
    expect(isSearchOrReadBashCommand('echo foo')).toEqual(NOT_COLLAPSIBLE)
    // Pins the observable answer, and nothing more: the `hasNonNeutralCommand`
    // early return that appears to produce it is unobservable. If every
    // segment was neutral then hasSearch/hasRead/hasList are all still false,
    // so the early return and the function's normal return are the same three
    // values. Deleting that guard changes no result — verified by probe. The
    // assertion is correct; it is just not what guards that branch.
  })

  test('membership is by whole segment name, not by prefix', () => {
    // `grepdiff` starts with `grep` and `git grep` contains it; neither is the
    // command being run. A substring check would collapse both.
    expect(isSearchOrReadBashCommand('grepdiff foo')).toEqual(NOT_COLLAPSIBLE)
    expect(isSearchOrReadBashCommand('git grep foo')).toEqual(NOT_COLLAPSIBLE)
  })

  test('an empty or blank command is not collapsible', () => {
    // walkCommandSegments answers null for these, and the caller must read
    // that as "not collapsible" rather than as "no disqualifying segment
    // found" — the difference between the two is a `return NOT_COLLAPSIBLE`.
    expect(isSearchOrReadBashCommand('')).toEqual(NOT_COLLAPSIBLE)
    expect(isSearchOrReadBashCommand('   ')).toEqual(NOT_COLLAPSIBLE)
  })

  test('unbalanced quoting still classifies by the command name', () => {
    // The splitter does not throw on this, so the segment name is still `cat`
    // and the block collapses as a read. Harmless — the shell rejects the
    // command before it runs — but pinned so the split cannot change it
    // silently in either direction.
    expect(isSearchOrReadBashCommand("cat 'unterminated")).toEqual({
      isSearch: false,
      isRead: true,
      isList: false,
    })
  })

  test('a stderr redirect does not change the classification', () => {
    expect(isSearchOrReadBashCommand('grep PAT f 2>/dev/null')).toEqual({
      isSearch: true,
      isRead: false,
      isList: false,
    })
  })
})

describe('isSilentBashCommand', () => {
  test('commands that produce no stdout on success are silent', () => {
    expect(isSilentBashCommand('mv a b')).toBe(true)
    expect(isSilentBashCommand('cd /tmp')).toBe(true)
    expect(isSilentBashCommand('mkdir -p x && touch y')).toBe(true)
  })

  test('a command that does print is not silent', () => {
    // ls is the one people expect to be here and must not be: it has output,
    // so "Done" would replace a listing the user asked for.
    expect(isSilentBashCommand('ls')).toBe(false)
    expect(isSilentBashCommand('echo hi')).toBe(false)
  })

  test('a neutral fallback after || does not break silence', () => {
    // `rm x || echo failed` is still a silent command with a diagnostic arm.
    expect(isSilentBashCommand('rm x || echo failed')).toBe(true)
  })

  test('the || exemption covers only neutral commands', () => {
    // `cat y` on the fallback arm genuinely prints, so the whole thing is not
    // silent. This is the assertion that keeps the exemption from widening
    // into "anything after || is ignored".
    expect(isSilentBashCommand('rm x || cat y')).toBe(false)
  })

  test('the exemption is specific to ||, not to every operator', () => {
    // After && the command runs on SUCCESS and its output is real output.
    expect(isSilentBashCommand('rm x && echo done')).toBe(false)
  })

  test('a redirect target is not mistaken for a command', () => {
    // `out` is a filename. Read as a command name it is not in the silent set,
    // and the whole thing would report as noisy.
    expect(isSilentBashCommand('touch f > out')).toBe(true)
  })

  test('membership is by whole command name', () => {
    // `mvn` starts with `mv`. Prefix matching would call a Maven build silent
    // and swallow its entire output.
    expect(isSilentBashCommand('mvn install')).toBe(false)
  })

  test('quoting is respected when splitting', () => {
    expect(isSilentBashCommand("mv 'a b' c")).toBe(true)
  })

  test('an empty command is not silent', () => {
    expect(isSilentBashCommand('')).toBe(false)
  })

  test('a command made only of redirects is not silent', () => {
    // The discriminating fixture for hasNonFallbackCommand. An empty string
    // never reaches that return — it exits on the empty-parts check above — so
    // a test written with `''` alone passes with the flag replaced by `true`.
    // `> out` parses into two parts and skips both, which is the only way to
    // arrive at the final return with nothing counted.
    expect(isSilentBashCommand('> out')).toBe(false)
  })
})

describe('detectBlockedSleepPattern', () => {
  test('a standalone sleep is blocked and says so', () => {
    expect(detectBlockedSleepPattern('sleep 5')).toBe('standalone sleep 5')
  })

  test('a leading sleep names what it was waiting for', () => {
    // The message becomes the Monitor suggestion, so the tail has to survive.
    expect(detectBlockedSleepPattern('sleep 5 && npm test')).toBe(
      'sleep 5 followed by: npm test',
    )
    expect(detectBlockedSleepPattern('sleep 5; check')).toBe(
      'sleep 5 followed by: check',
    )
    expect(detectBlockedSleepPattern('sleep 10 && curl x && echo ok')).toBe(
      'sleep 10 followed by: curl x echo ok',
    )
  })

  test('sub-2s sleeps are pacing, not polling', () => {
    expect(detectBlockedSleepPattern('sleep 1')).toBeNull()
    // 2 is the first blocked value — the boundary, asserted from both sides.
    expect(detectBlockedSleepPattern('sleep 2')).toBe('standalone sleep 2')
  })

  test('a fractional sleep is allowed', () => {
    // The pattern requires an integer, so `sleep 0.5` falls through as pacing.
    expect(detectBlockedSleepPattern('sleep 0.5')).toBeNull()
  })

  test('only a LEADING sleep is blocked', () => {
    // Sleep inside a pipeline or after real work is legitimate; the refusal is
    // aimed at "wait, then look", which Monitor does better.
    expect(detectBlockedSleepPattern('echo hi && sleep 5')).toBeNull()
    expect(detectBlockedSleepPattern('cmd | sleep 5')).toBeNull()
  })

  test('the command name must be exactly sleep', () => {
    expect(detectBlockedSleepPattern('sleeper 5')).toBeNull()
    expect(detectBlockedSleepPattern('npm test')).toBeNull()
  })

  test('a bare sleep with no duration is not blocked', () => {
    expect(detectBlockedSleepPattern('sleep')).toBeNull()
  })

  test('surrounding whitespace is trimmed before matching', () => {
    expect(detectBlockedSleepPattern('  sleep 5  ')).toBe('standalone sleep 5')
  })

  test('an empty command is not blocked', () => {
    expect(detectBlockedSleepPattern('')).toBeNull()
  })
})

describe('isAutobackgroundingAllowed', () => {
  test('ordinary commands may be auto-backgrounded', () => {
    expect(isAutobackgroundingAllowed('npm test')).toBe(true)
    expect(isAutobackgroundingAllowed('sleeper 5')).toBe(true)
  })

  test('an empty command is allowed', () => {
    expect(isAutobackgroundingAllowed('')).toBe(true)
  })

  test('a bare sleep is refused', () => {
    expect(isAutobackgroundingAllowed('sleep')).toBe(false)
  })

  test('KNOWN GAP: `sleep N` is NOT refused, only a bare `sleep` is', () => {
    // Pinning current behaviour, not endorsing it. splitCommand_DEPRECATED
    // returns whole segments, so `baseCommand` here is the string "sleep 5",
    // and DISALLOWED_AUTO_BACKGROUND_COMMANDS holds command NAMES — so the
    // one case the function's own doc comment names ("like sleep") misses.
    //
    // It is not currently user-visible: detectBlockedSleepPattern refuses
    // `sleep 5` earlier in validateInput, so the lenient answer here is never
    // reached for the shape that matters. Left alone deliberately — this
    // branch is a pure relocation and changing the gate would change
    // backgrounding behaviour nobody asked about. If this is ever fixed, this
    // test is the one that should go red.
    expect(isAutobackgroundingAllowed('sleep 5')).toBe(true)
    expect(isAutobackgroundingAllowed('  sleep 5  ')).toBe(true)
  })
})
