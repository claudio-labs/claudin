/**
 * Characterization of the form an MCP server opens when it elicits input
 * (`ElicitationDialog` without `mode: 'url'`). Written before the clean-base
 * rewrite of mcp/elicitationDialog; the spec is
 * docs/tech/rewrite/mcp/elicitationDialog.md.
 *
 * Each test mounts the real dialog on a fake terminal, presses real keys and
 * reads two things: the screen, and what the dialog reported to the REPL
 * (`onResponse(action, content)`), which is what the server receives.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as React from 'react'
import { Text } from 'src/terminal/ink.js'
import { isolatedWorld, KEYS, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { buttonRow, fieldRow, guide, letters, openForm, rows } from 'src/mcp/ui/__testutils__/elicitationRig.js'

isolatedWorld()

const { enter, esc, up, down, ctrlC } = KEYS
const left = '\x1B[D'
const right = '\x1B[C'
const space = ' '
const backspace = '\x7F'

const savedTz = process.env.TZ
beforeAll(() => {
  process.env.TZ = 'UTC'
})
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ
  else process.env.TZ = savedTz
})

/** The row the pointer is on. */
const pointed = (frame: string) => rows(frame).filter(line => line.startsWith('❯'))

/** Down from the first field to the Accept button. */
const toAccept = (fieldCount: number) => Array<string>(fieldCount).fill(down)

const accepted = (content: unknown) => [{ via: 'onResponse', action: 'accept', content }]

// --- what the dialog shows ---------------------------------------------------

describe('the frame', () => {
  test(
    'a form without fields: title, message, Accept already chosen, and the plain key guide',
    async () => {
      const { screen } = await openForm({ fields: {}, server: 'tracker', message: 'Confirm the export' })
      expect(rows(screen.text())).toEqual([
        '─'.repeat(100),
        'MCP server “tracker” requests your input',
        'Confirm the export',
        '❯ Accept    Decline',
        'Esc to cancel · ↑↓ to navigate',
      ])
    },
    SLOW,
  )

  test(
    'a form without fields: Enter accepts at once with empty content',
    async () => {
      const opened = await openForm({ fields: {} })
      await opened.screen.press(enter)
      expect(opened.log).toEqual(accepted({}) as never)
    },
    SLOW,
  )

  test(
    'fields: label from title or name, required star, description under it, not set, and the first field focused',
    async () => {
      const { screen } = await openForm({
        fields: {
          project: { type: 'string', title: 'Project name', description: 'Where the notes go' },
          owner: { type: 'string' },
        },
        required: ['owner'],
      })
      expect(rows(screen.text()).slice(1)).toEqual([
        'MCP server “notes” requests your input',
        'Fill this in please',
        '❯   Project name: Type something…',
        'Where the notes go',
        '* owner: not set',
        'Accept    Decline',
        'Esc to cancel · ↑↓ to navigate · Backspace to unset',
      ])
    },
    SLOW,
  )

  test(
    'defaults are filled in and ticked; a bad text default is flagged from the start',
    async () => {
      const opened = await openForm({
        fields: {
          headline: { type: 'string', default: 'Weekly' },
          contact: { type: 'string', format: 'email', default: 'not-an-address' },
          loud: { type: 'boolean', default: true },
        },
      })
      const frame = opened.screen.text()
      expect(fieldRow(frame, 'contact')).toBe('⚠ contact: not-an-address')
      expect(fieldRow(frame, 'loud')).toBe('✔ loud: ☒')
      expect(rows(frame)).toContain('Must be a valid email address, e.g. user@example.com')
      // The first field is being edited, so its value sits in the input.
      expect(fieldRow(frame, 'headline')).toBe('❯ ✔ headline: Weekly')
    },
    SLOW,
  )

  test(
    'the dialog registers the elicitation overlay while it is up, and removes it when it goes',
    async () => {
      const { screen } = await openForm({ fields: { a: { type: 'string' } } })
      expect([...screen.state().activeOverlays]).toEqual(['elicitation'])
      await screen.replace(<Text>after</Text>)
      expect([...screen.state().activeOverlays]).toEqual([])
    },
    SLOW,
  )

  type GuideCase = { what: string; fields: Record<string, Record<string, unknown>>; keys: string[]; guide: string }
  const guides: GuideCase[] = [
    { what: 'a text field', fields: { a: { type: 'string' } }, keys: [], guide: 'Esc to cancel · ↑↓ to navigate · Backspace to unset' },
    { what: 'a yes/no field', fields: { a: { type: 'boolean' } }, keys: [], guide: 'Esc to cancel · ↑↓ to navigate · Backspace to unset · Space to toggle' },
    { what: 'a closed choice', fields: { a: { type: 'string', enum: ['x', 'y'] } }, keys: [], guide: 'Esc to cancel · ↑↓ to navigate · Backspace to unset · → to expand' },
    { what: 'an open choice', fields: { a: { type: 'string', enum: ['x', 'y'] } }, keys: [right], guide: 'Esc to cancel · ↑↓ to navigate · Backspace to unset · Space to select' },
    { what: 'a closed multi choice', fields: { a: { type: 'array', items: { enum: ['x', 'y'] } } }, keys: [], guide: 'Esc to cancel · ↑↓ to navigate · Backspace to unset · → to expand' },
    { what: 'an open multi choice', fields: { a: { type: 'array', items: { enum: ['x', 'y'] } } }, keys: [right], guide: 'Esc to cancel · ↑↓ to navigate · Backspace to unset · Space to toggle' },
    { what: 'the Accept button', fields: { a: { type: 'boolean' } }, keys: [down], guide: 'Esc to cancel · ↑↓ to navigate' },
  ]
  for (const c of guides) {
    test(
      `the key guide on ${c.what}`,
      async () => {
        const { screen } = await openForm({ fields: c.fields })
        await screen.press(...c.keys)
        expect(guide(screen.text())).toBe(c.guide)
      },
      SLOW,
    )
  }

  test(
    'a first Ctrl+C on a button warns before exiting, in place of the key guide',
    async () => {
      const { screen, log } = await openForm({ fields: {} })
      await screen.press(ctrlC)
      expect(guide(screen.text())).toBe('Press Ctrl-C again to exit')
      expect(log).toEqual([])
    },
    SLOW,
  )
})

// --- moving around -------------------------------------------------------------

describe('moving around', () => {
  const three = { first: { type: 'boolean' }, second: { type: 'boolean' }, third: { type: 'boolean' } }

  test(
    'Down walks the fields, then Accept, then Decline, then wraps to the first field',
    async () => {
      const { screen } = await openForm({ fields: three })
      const where = () => pointed(screen.text()).find(line => !line.includes('Accept')) ?? buttonRow(screen.text())
      const seen = [where()]
      for (let i = 0; i < 5; i++) {
        await screen.press(down)
        seen.push(where())
      }
      expect(seen).toEqual([
        '❯   first: ☐',
        '❯   second: ☐',
        '❯   third: ☐',
        '❯ Accept    Decline',
        'Accept  ❯ Decline',
        '❯   first: ☐',
      ])
    },
    SLOW,
  )

  test(
    'Up from the first field lands on Decline; Left and Right swap the two buttons',
    async () => {
      const { screen } = await openForm({ fields: three })
      await screen.press(up)
      expect(buttonRow(screen.text())).toBe('Accept  ❯ Decline')
      await screen.press(left)
      expect(buttonRow(screen.text())).toBe('❯ Accept    Decline')
      await screen.press(right)
      expect(buttonRow(screen.text())).toBe('Accept  ❯ Decline')
      await screen.press(up)
      expect(buttonRow(screen.text())).toBe('❯ Accept    Decline')
      await screen.press(up)
      expect(pointed(screen.text())).toEqual(['❯   third: ☐'])
    },
    SLOW,
  )

  test(
    'Enter in a text field moves to the next one',
    async () => {
      const { screen } = await openForm({ fields: { a: { type: 'string' }, b: { type: 'string' } } })
      await screen.press(...letters('hi'), enter)
      const frame = screen.text()
      expect(fieldRow(frame, 'a')).toBe('✔ a: hi')
      expect(pointed(frame)).toEqual(['❯   b: Type something…'])
    },
    SLOW,
  )

  test(
    'with more fields than fit in 24 rows, three are shown and the rest are counted above and below',
    async () => {
      const fields = Object.fromEntries(['f1', 'f2', 'f3', 'f4', 'f5'].map(name => [name, { type: 'boolean' }]))
      const { screen } = await openForm({ fields })
      const view = () =>
        rows(screen.text()).filter(line => /^(❯ )?\s*f\d:|more (above|below)$/.test(line))
      const frames: string[][] = [view()]
      for (const _ of [1, 2, 3, 4, 5]) {
        await screen.press(down)
        frames.push(view())
      }
      expect(frames.map(lines => lines.join(' | '))).toEqual([
        '❯   f1: ☐ | f2: not set | f3: not set | ↓ 2 more below',
        'f1: not set | ❯   f2: ☐ | f3: not set | ↓ 2 more below',
        '↑ 1 more above | f2: not set | ❯   f3: ☐ | f4: not set | ↓ 1 more below',
        '↑ 2 more above | f3: not set | ❯   f4: ☐ | f5: not set',
        '↑ 2 more above | f3: not set | f4: not set | ❯   f5: ☐',
        // On the buttons the window stays on the last fields.
        '↑ 2 more above | f3: not set | f4: not set | f5: not set',
      ])
    },
    SLOW,
  )
})

// --- what goes back to the server ------------------------------------------------

describe('answers', () => {
  const everyKind = {
    name: { type: 'string' },
    age: { type: 'integer', minimum: 0, maximum: 120 },
    ratio: { type: 'number' },
    subscribed: { type: 'boolean' },
    colour: { type: 'string', oneOf: [{ const: 'r', title: 'Red' }, { const: 'g', title: 'Green' }] },
    tags: { type: 'array', items: { enum: ['alpha', 'beta', 'gamma'] } },
  }

  test(
    'Accept sends every set field with its type: text, numbers, yes/no, the chosen value and the list',
    async () => {
      const opened = await openForm({ fields: everyKind })
      await opened.screen.press(...letters('Ada'), down, ...letters('36'), down, ...letters('0.5'), down, space, down)
      await opened.screen.press(right, down, enter) // Green, then on to tags
      await opened.screen.press(right, space, down, down, space, enter) // alpha and gamma
      await opened.screen.press(enter)
      expect(opened.log).toEqual(accepted({ name: 'Ada', age: 36, ratio: 0.5, subscribed: true, colour: 'g', tags: ['alpha', 'gamma'] }) as never)
    },
    SLOW,
  )

  test(
    'fields left unset are absent from the content; defaults are sent as given',
    async () => {
      const opened = await openForm({
        fields: { title: { type: 'string', default: 'Draft' }, count: { type: 'number', default: 2 }, note: { type: 'string' }, flag: { type: 'boolean' } },
      })
      await opened.screen.press(...toAccept(4), enter)
      expect(opened.log).toEqual(accepted({ title: 'Draft', count: 2 }) as never)
    },
    SLOW,
  )

  test(
    'Decline sends decline with no content, whatever was typed',
    async () => {
      const opened = await openForm({ fields: { secret: { type: 'string' } } })
      await opened.screen.press(...letters('typed'), down, right, enter)
      expect(opened.log).toEqual([{ via: 'onResponse', action: 'decline' }])
    },
    SLOW,
  )

  type CancelCase = { what: string; keys: string[] }
  const cancels: CancelCase[] = [
    { what: 'Esc while a text field is being edited', keys: [...letters('half'), esc] },
    { what: 'Esc on a closed choice', keys: [down, esc] },
    { what: 'Esc on the Accept button', keys: [down, down, esc] },
    { what: 'n on the Accept button', keys: [down, down, 'n'] },
    { what: 'n on the Decline button', keys: [up, 'n'] },
  ]
  for (const c of cancels) {
    test(
      `${c.what} cancels, with no content`,
      async () => {
        const opened = await openForm({ fields: { words: { type: 'string' }, pick: { type: 'string', enum: ['a', 'b'] } } })
        await opened.screen.press(...c.keys)
        expect(opened.log).toEqual([{ via: 'onResponse', action: 'cancel' }])
      },
      SLOW,
    )
  }

  test(
    'n typed into a text field is a letter, not a cancel',
    async () => {
      const opened = await openForm({ fields: { words: { type: 'string' } } })
      await opened.screen.press('n', 'o')
      expect(opened.log).toEqual([])
      expect(fieldRow(opened.screen.text(), 'words')).toBe('❯ ✔ words: no')
    },
    SLOW,
  )

  test(
    'Accept with a required field missing sends nothing, marks every missing one and jumps to the first',
    async () => {
      const opened = await openForm({
        fields: { opt: { type: 'string' }, who: { type: 'string' }, when: { type: 'boolean' } },
        required: ['who', 'when'],
      })
      await opened.screen.press(...toAccept(3), enter)
      const frame = opened.screen.text()
      expect(opened.log).toEqual([])
      expect(rows(frame).filter(line => line === 'This field is required')).toHaveLength(2)
      expect(pointed(frame)).toEqual(['❯ ⚠ who: Type something…'])
      expect(buttonRow(frame)).toBe('Accept    Decline')
    },
    SLOW,
  )

  test(
    'giving the missing value clears "This field is required", and Accept then goes through',
    async () => {
      const opened = await openForm({ fields: { who: { type: 'string' } }, required: ['who'] })
      await opened.screen.press(down, enter)
      expect(rows(opened.screen.text())).toContain('This field is required')
      await opened.screen.press('x')
      expect(rows(opened.screen.text())).not.toContain('This field is required')
      await opened.screen.press(down, enter)
      expect(opened.log).toEqual(accepted({ who: 'x' }) as never)
    },
    SLOW,
  )

  type Supplied = { what: string; field: Record<string, unknown>; keys: string[]; content: Record<string, unknown> }
  const supplied: Supplied[] = [
    { what: 'a yes/no field toggled', field: { type: 'boolean' }, keys: [space], content: { must: true } },
    { what: 'a choice made', field: { type: 'string', enum: ['p', 'q'] }, keys: [right, space], content: { must: 'p' } },
    { what: 'a multi choice ticked', field: { type: 'array', items: { enum: ['p', 'q'] } }, keys: [right, down, space, left], content: { must: ['q'] } },
  ]
  for (const c of supplied) {
    test(
      `"This field is required" goes as soon as ${c.what} gives a value, and Accept goes through`,
      async () => {
        const opened = await openForm({ fields: { must: c.field }, required: ['must'] })
        await opened.screen.press(down, enter)
        expect(rows(opened.screen.text())).toContain('This field is required')
        await opened.screen.press(...c.keys)
        expect(rows(opened.screen.text())).not.toContain('This field is required')
        await opened.screen.press(down, enter)
        expect(opened.log).toEqual(accepted(c.content) as never)
      },
      SLOW,
    )
  }

  test(
    'Accept with a field in error sends nothing and returns to that field, its message kept',
    async () => {
      const opened = await openForm({ fields: { ok: { type: 'string' }, size: { type: 'integer', minimum: 1, maximum: 9 } } })
      await opened.screen.press(down, ...letters('12'), down, enter)
      const frame = opened.screen.text()
      expect(opened.log).toEqual([])
      expect(pointed(frame)).toEqual(['❯ ⚠ size: 12'])
      expect(rows(frame)).toContain('Must be an integer between 1 and 9')
    },
    SLOW,
  )

  test(
    'a required text field emptied after typing still holds Accept back, and nothing is sent',
    async () => {
      const opened = await openForm({ fields: { who: { type: 'string' } }, required: ['who'] })
      await opened.screen.press('x', backspace, down, enter)
      expect(opened.log).toEqual([])
    },
    SLOW,
  )

  test(
    'the server cancelling the request answers cancel',
    async () => {
      const opened = await openForm({ fields: { a: { type: 'string' } } })
      opened.abort()
      await Bun.sleep(50)
      expect(opened.log).toEqual([{ via: 'onResponse', action: 'cancel' }])
    },
    SLOW,
  )

  test(
    'a request already cancelled when the dialog opens answers cancel at once',
    async () => {
      const opened = await openForm({ fields: { a: { type: 'string' } } }, { preAborted: true })
      expect(opened.log).toEqual([{ via: 'onResponse', action: 'cancel' }])
    },
    SLOW,
  )
})

// --- text and number fields --------------------------------------------------------

describe('text and number fields', () => {
  type Typed = { what: string; field: Record<string, unknown>; keys: string[]; row: string; message?: string; content: Record<string, unknown> | 'blocked' }
  const typed: Typed[] = [
    { what: 'text is kept as typed, inner and outer spaces included', field: { type: 'string' }, keys: [...letters(' a b ')], row: '✔ v:  a b', content: { v: ' a b ' } },
    { what: 'only spaces in an unset text field leave it unset', field: { type: 'string' }, keys: [space, space], row: 'v: not set', content: {} },
    { what: 'a text field emptied after typing is sent as the empty string', field: { type: 'string' }, keys: ['q', backspace], row: '✔ v:', content: { v: '' } },
    { what: 'a text field emptied and then Backspace once more is unset', field: { type: 'string' }, keys: ['q', backspace, backspace], row: 'v: not set', content: {} },
    { what: 'an integer is sent as a number', field: { type: 'integer' }, keys: [...letters('42')], row: '✔ v: 42', content: { v: 42 } },
    { what: 'a number keeps its fraction', field: { type: 'number' }, keys: [...letters('2.75')], row: '✔ v: 2.75', content: { v: 2.75 } },
    { what: 'a number emptied is unset, not zero', field: { type: 'number' }, keys: ['7', backspace], row: 'v: not set', content: {} },
    { what: 'a word in a number field is flagged', field: { type: 'number' }, keys: [...letters('ten')], row: '⚠ v: ten', message: 'Must be a number', content: 'blocked' },
    { what: 'an integer out of range is flagged', field: { type: 'integer', minimum: 1, maximum: 5 }, keys: ['9'], row: '⚠ v: 9', message: 'Must be an integer between 1 and 5', content: 'blocked' },
    { what: 'a short text under minLength is flagged', field: { type: 'string', minLength: 3 }, keys: ['a'], row: '⚠ v: a', message: 'Must be at least 3 characters', content: 'blocked' },
    { what: 'a bad email is flagged', field: { type: 'string', format: 'email' }, keys: [...letters('ann@')], row: '⚠ v: ann@', message: 'Must be a valid email address, e.g. user@example.com', content: 'blocked' },
    { what: 'a bad uri is flagged', field: { type: 'string', format: 'uri' }, keys: [...letters('host')], row: '⚠ v: host', message: 'Must be a valid URI, e.g. https://example.com', content: 'blocked' },
    { what: 'an emptied email field is unset and its error goes', field: { type: 'string', format: 'email' }, keys: ['x', backspace], row: 'v: not set', content: {} },
    { what: 'fixing a flagged value clears its error', field: { type: 'integer', maximum: 5 }, keys: ['9', backspace, '4'], row: '✔ v: 4', content: { v: 4 } },
  ]
  for (const c of typed) {
    test(
      c.what,
      async () => {
        const opened = await openForm({ fields: { v: c.field } })
        await opened.screen.press(...c.keys, down)
        const frame = opened.screen.text()
        expect(fieldRow(frame, 'v')).toBe(c.row)
        const messages = rows(frame).filter(line => /^Must /.test(line))
        expect(messages).toEqual(c.message ? [c.message] : [])
        await opened.screen.press(enter)
        expect(opened.log).toEqual(c.content === 'blocked' ? [] : (accepted(c.content) as never))
      },
      SLOW,
    )
  }

  test(
    'Backspace in an empty field that holds an error unsets it and drops the error',
    async () => {
      const opened = await openForm({ fields: { v: { type: 'integer', default: 'x' } } })
      expect(rows(opened.screen.text())).toContain('Must be an integer')
      await opened.screen.press(backspace)
      expect(fieldRow(opened.screen.text(), 'v')).toBe('❯   v: Type something…')
      await opened.screen.press(down)
      expect(fieldRow(opened.screen.text(), 'v')).toBe('v: not set')
      expect(rows(opened.screen.text())).not.toContain('Must be an integer')
    },
    SLOW,
  )

  test(
    'coming back to a field puts its value back in the input',
    async () => {
      const opened = await openForm({ fields: { a: { type: 'string' }, b: { type: 'integer' } } })
      await opened.screen.press(...letters('kept'), down, '5', up)
      const frame = opened.screen.text()
      expect(pointed(frame)).toEqual(['❯ ✔ a: kept'])
      expect(fieldRow(frame, 'b')).toBe('✔ b: 5')
    },
    SLOW,
  )
})

// --- yes/no fields ------------------------------------------------------------------

describe('yes/no fields', () => {
  type Flip = { keys: string[]; row: string; content: Record<string, unknown> }
  const flips: Flip[] = [
    { keys: [], row: '❯   on: ☐', content: {} },
    { keys: [space], row: '❯ ✔ on: ☒', content: { on: true } },
    { keys: [space, space], row: '❯ ✔ on: ☐', content: { on: false } },
    { keys: [space, space, space], row: '❯ ✔ on: ☒', content: { on: true } },
    { keys: [space, backspace], row: '❯   on: ☐', content: {} },
    { keys: ['y'], row: '❯ ✔ on: ☒', content: { on: true } },
    { keys: ['n'], row: '❯ ✔ on: ☐', content: { on: false } },
    { keys: ['x'], row: '❯   on: ☐', content: {} },
  ]
  for (const c of flips) {
    test(
      `keys ${JSON.stringify(c.keys)} leave ${JSON.stringify(c.content)}`,
      async () => {
        const opened = await openForm({ fields: { on: { type: 'boolean' } } })
        await opened.screen.press(...c.keys)
        expect(fieldRow(opened.screen.text(), 'on')).toBe(c.row)
        await opened.screen.press(down, enter)
        expect(opened.log).toEqual(accepted(c.content) as never)
      },
      SLOW,
    )
  }

  test(
    'typing ahead: "ye" still matches yes; Enter moves on; away from focus the value shows as a box',
    async () => {
      const opened = await openForm({ fields: { on: { type: 'boolean' }, off: { type: 'boolean', default: false }, other: { type: 'string' } } })
      await opened.screen.press('n', 'y', 'e')
      // "nye" matches neither label, so the n still stands.
      expect(fieldRow(opened.screen.text(), 'on')).toBe('❯ ✔ on: ☐')
      await opened.screen.press(enter)
      const frame = opened.screen.text()
      expect(fieldRow(frame, 'on')).toBe('✔ on: ☐')
      expect(fieldRow(frame, 'off')).toBe('❯ ✔ off: ☐')
    },
    SLOW,
  )
})

describe('typing ahead', () => {
  test(
    'the typed prefix is forgotten after two idle seconds',
    async () => {
      const opened = await openForm({ fields: { on: { type: 'boolean' } } })
      await opened.screen.press('n')
      await Bun.sleep(2_100)
      await opened.screen.press('y')
      expect(fieldRow(opened.screen.text(), 'on')).toBe('❯ ✔ on: ☒')
    },
    SLOW,
  )

  test(
    'the typed prefix is forgotten when moving to another field',
    async () => {
      const opened = await openForm({ fields: { on: { type: 'boolean' }, other: { type: 'boolean' } } })
      await opened.screen.press('n', down, up, 'y')
      expect(fieldRow(opened.screen.text(), 'on')).toBe('❯ ✔ on: ☒')
    },
    SLOW,
  )

  test(
    'keys that mean nothing to a yes/no field change nothing',
    async () => {
      const opened = await openForm({ fields: { on: { type: 'boolean', default: true } } })
      await opened.screen.press(right, left)
      expect(fieldRow(opened.screen.text(), 'on')).toBe('❯ ✔ on: ☒')
      expect(opened.log).toEqual([])
    },
    SLOW,
  )
})

describe('a field of a kind the form does not know', () => {
  test(
    'is listed with its value as text, or not set, and its default is sent back',
    async () => {
      const opened = await openForm({
        fields: { first: { type: 'string' }, raw: { type: 'object', default: 'kept' }, bare: { type: 'array' } },
      })
      const frame = opened.screen.text()
      expect(fieldRow(frame, 'raw')).toBe('✔ raw: kept')
      expect(fieldRow(frame, 'bare')).toBe('bare: not set')
      await opened.screen.press(down, down, down, enter)
      expect(opened.log).toEqual(accepted({ raw: 'kept' }) as never)
    },
    SLOW,
  )
})

// --- single choice ---------------------------------------------------------------------

describe('single choice', () => {
  const colour = { type: 'string', oneOf: [{ const: 'r', title: 'Red' }, { const: 'g', title: 'Green' }, { const: 'b', title: 'Blue' }] }
  const form = { fields: { colour, after: { type: 'boolean' } } }
  const options = (frame: string) => rows(frame).filter(line => /[◉◯] /.test(line))

  test(
    'Right opens the list: one radio per label, the pointer on the first when nothing is chosen',
    async () => {
      const { screen } = await openForm(form)
      expect(fieldRow(screen.text(), 'colour')).toBe('❯   colour: ▸ not set')
      await screen.press(right)
      const frame = screen.text()
      expect(fieldRow(frame, 'colour')).toBe('❯   colour: ▾')
      expect(options(frame)).toEqual(['❯ ◯ Red', '◯ Green', '◯ Blue'])
    },
    SLOW,
  )

  type Pick = { what: string; keys: string[]; colourRow: string; pointer: string; content: Record<string, unknown> }
  const picks: Pick[] = [
    { what: 'Space chooses and closes, staying on the field', keys: [right, down, space], colourRow: '❯ ✔ colour: ▸ Green', pointer: 'colour', content: { colour: 'g' } },
    { what: 'Enter chooses, closes and moves on', keys: [right, down, down, enter], colourRow: '✔ colour: Blue', pointer: 'after', content: { colour: 'b' } },
    { what: 'Down past the last option closes and moves on, choosing nothing', keys: [right, down, down, down], colourRow: 'colour: not set', pointer: 'after', content: {} },
    { what: 'Up from the first option closes, choosing nothing', keys: [right, up], colourRow: '❯   colour: ▸ not set', pointer: 'colour', content: {} },
    { what: 'Left closes, choosing nothing', keys: [right, down, left], colourRow: '❯   colour: ▸ not set', pointer: 'colour', content: {} },
    { what: 'Esc closes the list and does not cancel', keys: [right, esc], colourRow: '❯   colour: ▸ not set', pointer: 'colour', content: {} },
    { what: 'typing on the closed field opens it on the match', keys: ['b', space], colourRow: '❯ ✔ colour: ▸ Blue', pointer: 'colour', content: { colour: 'b' } },
    { what: 'typing inside the open list jumps to the match', keys: [right, 'g', enter], colourRow: '✔ colour: Green', pointer: 'after', content: { colour: 'g' } },
    { what: 'a typed prefix with no match leaves the pointer', keys: [right, down, 'z', space], colourRow: '❯ ✔ colour: ▸ Green', pointer: 'colour', content: { colour: 'g' } },
    { what: 'Backspace unsets a choice', keys: [right, space, backspace], colourRow: '❯   colour: ▸ not set', pointer: 'colour', content: {} },
    { what: 'Enter on the closed field moves on', keys: [enter], colourRow: 'colour: not set', pointer: 'after', content: {} },
  ]
  for (const c of picks) {
    test(
      c.what,
      async () => {
        const opened = await openForm(form)
        await opened.screen.press(...c.keys)
        const frame = opened.screen.text()
        expect(opened.log).toEqual([])
        expect(fieldRow(frame, 'colour')).toBe(c.colourRow)
        expect(pointed(frame).join()).toContain(c.pointer)
        await opened.screen.press(...(c.pointer === 'colour' ? [down, down] : [down]), enter)
        expect(opened.log).toEqual(accepted(c.content) as never)
      },
      SLOW,
    )
  }

  test(
    'a key that means nothing in the open list leaves it open as it was',
    async () => {
      const { screen } = await openForm(form)
      await screen.press(right, down, KEYS.tab)
      expect(options(screen.text())).toEqual(['◯ Red', '❯ ◯ Green', '◯ Blue'])
    },
    SLOW,
  )

  test(
    'a default outside the list is flagged from the start with the allowed values, and holds Accept back',
    async () => {
      const opened = await openForm({ fields: { first: { type: 'string' }, pick: { type: 'string', enum: ['a', 'b'], default: 'zzz' } } })
      const frame = opened.screen.text()
      expect(fieldRow(frame, 'pick')).toBe('⚠ pick: zzz')
      const message = rows(frame).find(line => line.includes('"a"'))
      expect(message).toContain('"b"')
      await opened.screen.press(down, down, enter)
      expect(opened.log).toEqual([])
      expect(pointed(opened.screen.text())).toEqual(['❯ ⚠ pick: ▸ zzz'])
    },
    SLOW,
  )

  test(
    'reopening the list puts the pointer on the chosen option and fills its radio',
    async () => {
      const { screen } = await openForm(form)
      await screen.press(right, down, down, space, right)
      expect(options(screen.text())).toEqual(['◯ Red', '◯ Green', '❯ ◉ Blue'])
      await screen.press(up)
      expect(options(screen.text())).toEqual(['◯ Red', '❯ ◯ Green', '◉ Blue'])
    },
    SLOW,
  )

  test(
    'legacy enumNames are the labels; a plain enum shows its values; the value is what is sent',
    async () => {
      const opened = await openForm({
        fields: {
          size: { type: 'string', enum: ['s', 'l'], enumNames: ['Small', 'Large'] },
          plain: { type: 'string', enum: ['north', 'south'], default: 'south' },
        },
      })
      await opened.screen.press(right, down, space)
      const frame = opened.screen.text()
      expect(fieldRow(frame, 'size')).toBe('❯ ✔ size: ▸ Large')
      expect(fieldRow(frame, 'plain')).toBe('✔ plain: south')
      await opened.screen.press(down, down, enter)
      expect(opened.log).toEqual(accepted({ size: 'l', plain: 'south' }) as never)
    },
    SLOW,
  )
})

// --- multi choice --------------------------------------------------------------------

describe('multi choice', () => {
  const tags = (extra: Record<string, unknown> = {}) => ({
    type: 'array',
    items: { anyOf: [{ const: 'a', title: 'Apple' }, { const: 'b', title: 'Banana' }, { const: 'c', title: 'Cherry' }] },
    ...extra,
  })
  const options = (frame: string) => rows(frame).filter(line => /[☒☐] /.test(line))
  const errors = (frame: string) => rows(frame).filter(line => line.startsWith('Select '))

  test(
    'Right opens the list with a box per label; Space ticks and unticks without closing',
    async () => {
      const { screen } = await openForm({ fields: { tags: tags() } })
      await screen.press(right)
      expect(options(screen.text())).toEqual(['❯ ☐ Apple', '☐ Banana', '☐ Cherry'])
      await screen.press(space, down, down, space)
      expect(options(screen.text())).toEqual(['☒ Apple', '☐ Banana', '❯ ☒ Cherry'])
      await screen.press(up, up, space)
      expect(options(screen.text())).toEqual(['❯ ☐ Apple', '☐ Banana', '☒ Cherry'])
    },
    SLOW,
  )

  type Ticks = { what: string; extra?: Record<string, unknown>; required?: boolean; keys: string[]; row: string; errors: string[]; content: Record<string, unknown> | 'blocked' }
  const ticks: Ticks[] = [
    { what: 'closed, the ticked labels are joined with commas in ticking order', keys: [right, down, space, up, space, left], row: '❯ ✔ tags: ▸ Banana, Apple', errors: [], content: { tags: ['b', 'a'] } },
    { what: 'Enter ticks the focused option, closes and moves on', keys: [right, down, enter], row: '✔ tags: Banana', errors: [], content: { tags: ['b'] } },
    { what: 'Enter on an already ticked option keeps it ticked', keys: [right, space, enter], row: '✔ tags: Apple', errors: [], content: { tags: ['a'] } },
    { what: 'unticking the last one unsets the field', keys: [right, space, space, left], row: '❯   tags: ▸ not set', errors: [], content: {} },
    { what: 'Down past the last option closes and moves on', keys: [right, space, down, down, down], row: '✔ tags: Apple', errors: [], content: { tags: ['a'] } },
    { what: 'Esc closes the list and does not cancel', keys: [right, space, esc], row: '❯ ✔ tags: ▸ Apple', errors: [], content: { tags: ['a'] } },
    { what: 'Backspace on the closed field clears every tick', keys: [right, space, down, space, left, backspace], row: '❯   tags: ▸ not set', errors: [], content: {} },
    { what: 'typing on the closed field opens on the match', keys: ['c', space, left], row: '❯ ✔ tags: ▸ Cherry', errors: [], content: { tags: ['c'] } },
    { what: 'below minItems: "Select at least 2 items" as soon as one is ticked', extra: { minItems: 2 }, keys: [right, space], row: '❯ ⚠ tags: ▾', errors: ['Select at least 2 items'], content: 'blocked' },
    { what: 'reaching minItems clears the message', extra: { minItems: 2 }, keys: [right, space, down, space, left], row: '❯ ✔ tags: ▸ Apple, Banana', errors: [], content: { tags: ['a', 'b'] } },
    { what: 'above maxItems: "Select at most 1 item"', extra: { maxItems: 1 }, keys: [right, space, down, space], row: '❯ ⚠ tags: ▾', errors: ['Select at most 1 item'], content: 'blocked' },
    { what: 'optional with minItems and nothing ticked: no message', extra: { minItems: 2 }, keys: [right, left], row: '❯   tags: ▸ not set', errors: [], content: {} },
    { what: 'required with minItems: closing with nothing ticked asks for the minimum', extra: { minItems: 2 }, required: true, keys: [right, left], row: '❯ ⚠ tags: ▸ not set', errors: ['Select at least 2 items'], content: 'blocked' },
    { what: 'required with minItems: moving away with nothing ticked asks too', extra: { minItems: 1 }, required: true, keys: [down, up], row: '❯ ⚠ tags: ▸ not set', errors: ['Select at least 1 item'], content: 'blocked' },
    { what: 'closing with Up from the first option checks the count', extra: { maxItems: 1 }, keys: [right, space, down, space, up, up], row: '❯ ⚠ tags: ▸ Apple, Banana', errors: ['Select at most 1 item'], content: 'blocked' },
  ]
  for (const c of ticks) {
    test(
      c.what,
      async () => {
        const opened = await openForm({ fields: { tags: tags(c.extra), end: { type: 'string' } }, ...(c.required ? { required: ['tags'] } : {}) })
        await opened.screen.press(...c.keys)
        const frame = opened.screen.text()
        expect(fieldRow(frame, 'tags')).toBe(c.row)
        expect(errors(frame)).toEqual(c.errors)
        const onTags = pointed(frame).some(line => line.includes('tags:'))
        await opened.screen.press(...(onTags ? [left, down, down] : [down]), enter)
        expect(opened.log).toEqual(c.content === 'blocked' ? [] : (accepted(c.content) as never))
      },
      SLOW,
    )
  }

  test(
    'typing inside the open list moves the pointer to the match without ticking it',
    async () => {
      const { screen } = await openForm({ fields: { tags: tags() } })
      await screen.press(right, 'b')
      expect(options(screen.text())).toEqual(['☐ Apple', '❯ ☐ Banana', '☐ Cherry'])
      await screen.press('x', KEYS.tab)
      // Neither an unmatched letter nor a key without a letter changes the list.
      expect(options(screen.text())).toEqual(['☐ Apple', '❯ ☐ Banana', '☐ Cherry'])
    },
    SLOW,
  )

  test(
    'a plain items.enum shows its values as labels',
    async () => {
      const opened = await openForm({ fields: { v: { type: 'array', items: { enum: ['x1', 'x2'] }, default: ['x2'] } } })
      expect(fieldRow(opened.screen.text(), 'v')).toBe('❯ ✔ v: ▸ x2')
      await opened.screen.press(right)
      expect(options(opened.screen.text())).toEqual(['❯ ☐ x1', '☒ x2'])
    },
    SLOW,
  )
})

// --- dates typed as ISO ------------------------------------------------------------------

describe('date fields with ISO input', () => {
  type DateCase = { format: 'date' | 'date-time'; typed: string; shown: string }
  const dates: DateCase[] = [
    { format: 'date', typed: '2024-03-15', shown: 'Fri, Mar 15, 2024' },
    { format: 'date-time', typed: '2024-03-15T14:30:00Z', shown: 'Fri, Mar 15, 2024, 2:30 PM UTC' },
  ]
  for (const c of dates) {
    test(
      `a ${c.format} is shown readably once left, and sent as typed`,
      async () => {
        const opened = await openForm({ fields: { when: { type: 'string', format: c.format } } })
        await opened.screen.press(...letters(c.typed), down)
        expect(fieldRow(opened.screen.text(), 'when')).toBe(`✔ when: ${c.shown}`)
        await opened.screen.press(enter)
        expect(opened.log).toEqual(accepted({ when: c.typed }) as never)
      },
      SLOW,
    )
  }

  test(
    'a default date is shown readably from the start; an impossible one is flagged',
    async () => {
      const { screen } = await openForm({
        fields: {
          first: { type: 'string' },
          day: { type: 'string', format: 'date', default: '2025-12-31' },
          odd: { type: 'string', format: 'date', default: '2025-02-30' },
        },
      })
      const frame = screen.text()
      expect(fieldRow(frame, 'day')).toBe('✔ day: Wed, Dec 31, 2025')
      // How an impossible date is displayed is not pinned (spec, findings).
      expect(fieldRow(frame, 'odd')).toStartWith('⚠ odd: ')
      expect(rows(frame)).toContain('Must be a valid date, e.g. 2024-03-15, today, next Monday')
      await screen.close()
      // Text that is no date at all, or a date with fewer than three parts, is shown as given.
      const other = await openForm({
        fields: {
          first: { type: 'string' },
          vague: { type: 'string', format: 'date-time', default: 'someday' },
          year: { type: 'string', format: 'date', default: '2025' },
        },
      })
      expect(fieldRow(other.screen.text(), 'vague')).toBe('⚠ vague: someday')
      expect(fieldRow(other.screen.text(), 'year')).toBe('⚠ year: 2025')
      expect(rows(other.screen.text())).toContain('Must be a valid date-time, e.g. 2024-03-15T14:30:00Z, tomorrow at 3pm')
    },
    SLOW,
  )
})
