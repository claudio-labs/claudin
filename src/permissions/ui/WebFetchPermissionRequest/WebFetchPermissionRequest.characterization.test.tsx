/**
 * Characterization of the dialog that asks before a URL is fetched. Written
 * before the clean-base rewrite of permissions/toolDialogs; the spec is
 * docs/tech/rewrite/permissions/toolDialogs.md.
 *
 * Reached through `PermissionRequest` with the real WebFetchTool. Unlike the
 * other three dialogs of the unit it is a plain list: no notes, no hint line,
 * and Esc is its No. Its "don't ask again" writes a `domain:` rule, pinned
 * here for the URL shapes that change what the host is.
 */
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { Text } from 'src/terminal/ink.js'
import { WebFetchTool } from 'src/tools/WebFetchTool/WebFetchTool.js'
import { flat, isolatedWorld, KEYS, mount, SLOW, styleBefore, withTruecolor } from 'src/permissions/ui/__testutils__/promptFrameRig.js'
import { allowed, allowRule, answer, ask, type Call, denied, managedRulesOnly, shown } from 'src/permissions/ui/__testutils__/toolDialogRig.js'

const world = isolatedWorld()
withTruecolor()
const { enter, esc, tab, down, up } = KEYS

const fetchOf = (url: string, prompt = 'summarise it') => ({ url, prompt })
const askFetch = (input: Record<string, unknown>, verbose = false) => ask({ tool: WebFetchTool, input, verbose, description: 'Claude wants to fetch content from the docs' })
const optionLines = (frame: string) => shown(frame).filter(line => /^(❯ )?\d\./.test(line))

describe('WebFetchPermissionRequest: what it shows', () => {
  test(
    'the headline, the URL, the description, its own question, and three options with no hint line',
    async () => {
      const { screen } = await askFetch(fetchOf('https://docs.example.com/guide?page=2'))
      expect(shown(screen.text())).toEqual([
        '─'.repeat(120),
        'Fetch',
        'https://docs.example.com/guide?page=2',
        'Claude wants to fetch content from the docs',
        'Do you want to allow Claude to fetch this content?',
        '❯ 1. Yes',
        "2. Yes, and don't ask again for docs.example.com",
        '3. No, and tell Claude what to do differently (esc)',
      ])
    },
    SLOW,
  )

  test(
    'verbose: the URL and the prompt, both quoted',
    async () => {
      const { screen } = await askFetch(fetchOf('https://docs.example.com/a', 'list the headings'), true)
      expect(shown(screen.text())[2]).toBe('url: "https://docs.example.com/a", prompt: "list the headings"')
    },
    SLOW,
  )

  const hosts: Array<[string, string, string]> = [
    ['upper case and a port', 'https://Docs.Example.COM:8443/x', 'docs.example.com'],
    ['a sub-domain stays whole', 'https://api.github.com/repos', 'api.github.com'],
    ['credentials in the URL', 'https://user:secret@files.example.org/a', 'files.example.org'],
    ['an internationalised name, as punycode', 'https://bücher.example/katalog', 'xn--bcher-kva.example'],
    ['a plain IP address', 'http://127.0.0.1:3000/health', '127.0.0.1'],
    ['an IPv6 address, bracketed', 'http://[::1]:8080/', '[::1]'],
  ]
  for (const [name, url, host] of hosts) {
    test(
      `the always option names the host: ${name}`,
      async () => {
        const { screen } = await askFetch(fetchOf(url))
        expect(optionLines(screen.text())[1]).toBe(`2. Yes, and don't ask again for ${host}`)
      },
      SLOW,
    )
  }

  test(
    'styling: the host in the always option and the "(esc)" are bold, the description dim',
    async () => {
      const { screen } = await askFetch(fetchOf('https://docs.example.com/'))
      const styled = screen.styled()
      const reference = async (props: React.ComponentProps<typeof Text>) => {
        const probe = await mount(<Text {...props}>SAMPLE</Text>)
        const codes = styleBefore(probe.styled(), 'SAMPLE')
        await probe.close()
        return codes
      }
      const bold = await reference({ bold: true })
      expect(styleBefore(styled.slice(styled.indexOf('ask again for')), 'docs.example.com')).toBe(bold)
      expect(styleBefore(styled, '(esc)')).toBe(bold)
      expect(styleBefore(styled, 'Claude wants to fetch')).toBe(await reference({ dimColor: true }))
    },
    SLOW,
  )

  test(
    'the worker badge joins the headline, and the reason the prompt asked is shown above the question',
    async () => {
      const { screen } = await ask({
        tool: WebFetchTool,
        input: fetchOf('https://docs.example.com/'),
        workerBadge: { name: 'reader', color: 'cyan' },
        permissionResult: { behavior: 'ask', message: 'asking', decisionReason: { type: 'other', reason: 'Not on the preapproved list' } },
      })
      expect(shown(screen.text())[1]).toBe('Fetch · @reader')
      expect(flat(screen.text())).toContain('Not on the preapproved list Do you want to allow Claude to fetch this content?')
    },
    SLOW,
  )

  test(
    'managed policy keeps rules to itself: only Yes and No',
    async () => {
      managedRulesOnly(world().home)
      const { screen } = await askFetch(fetchOf('https://docs.example.com/'))
      expect(optionLines(screen.text())).toEqual(['❯ 1. Yes', '2. No, and tell Claude what to do differently (esc)'])
    },
    SLOW,
  )
})

describe('WebFetchPermissionRequest: what each answer reports', () => {
  const DOCS = fetchOf('https://Docs.Example.com:8443/guide')
  const DOMAIN = [allowRule('WebFetch', 'domain:docs.example.com')]
  type Row = { name: string; keys: string[]; calls: Call[]; input?: Record<string, unknown>; managed?: boolean }
  const rows: Row[] = [
    // Two arguments only: the dialog never passes a note.
    { name: 'Enter on Yes: allow once, nothing remembered, no third argument', keys: [enter], calls: allowed(DOCS, []) },
    { name: '1: allow once', keys: ['1'], calls: allowed(DOCS, []) },
    { name: '2: allow always, a domain rule for the lower-case host, port dropped, saved locally', keys: ['2'], calls: allowed(DOCS, DOMAIN) },
    { name: 'Down, Enter: allow always', keys: [down, enter], calls: allowed(DOCS, DOMAIN) },
    { name: '3: deny, with no arguments at all', keys: ['3'], calls: denied() },
    { name: 'Up from Yes wraps to No', keys: [up, enter], calls: denied() },
    { name: 'Esc: the same deny as No', keys: [esc], calls: denied() },
    { name: 'Tab opens no note: Enter still allows once', keys: [tab, 'x', enter], calls: allowed(DOCS, []) },
    { name: 'y and n: nothing', keys: ['y', 'n'], calls: [] },
    { name: 'managed policy: 2 is No', keys: ['2'], calls: denied(), managed: true },
    {
      name: 'an address with credentials and a path: the rule holds the host alone',
      input: fetchOf('https://user:secret@files.example.org/private/a?b=1'),
      keys: ['2'],
      calls: allowed(fetchOf('https://user:secret@files.example.org/private/a?b=1'), [allowRule('WebFetch', 'domain:files.example.org')]),
    },
    {
      name: 'an internationalised host: the rule holds its punycode',
      input: fetchOf('https://bücher.example/katalog'),
      keys: ['2'],
      calls: allowed(fetchOf('https://bücher.example/katalog'), [allowRule('WebFetch', 'domain:xn--bcher-kva.example')]),
    },
    {
      name: 'plain http on an IP: the rule holds the address, nothing of the scheme or port',
      input: fetchOf('http://127.0.0.1:3000/health'),
      keys: ['2'],
      calls: allowed(fetchOf('http://127.0.0.1:3000/health'), [allowRule('WebFetch', 'domain:127.0.0.1')]),
    },
  ]
  for (const row of rows) {
    test(
      row.name,
      async () => {
        if (row.managed) managedRulesOnly(world().home)
        const asked = await askFetch(row.input ?? DOCS)
        expect(await answer(asked, row.keys)).toEqual(row.calls)
        // This dialog's Esc is not counted as an escape.
        expect(asked.screen.state().attribution.escapeCount).toBe(0)
      },
      SLOW,
    )
  }

  test(
    'the dialog counts one permission prompt',
    async () => {
      const asked = await askFetch(DOCS)
      await asked.screen.until(() => asked.screen.state().attribution.permissionPromptCount === 1, 'the prompt count')
    },
    SLOW,
  )
})
