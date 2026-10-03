/**
 * The rule-string grammar of the permission system, black box.
 *
 * A rule is written `Tool` or `Tool(content)`. Settings files, the CLI and
 * SDK hosts hand rules over in that form, and every rule the decision core
 * consults went through the reader below. So the reader decides which rule
 * is in force: a string it cannot split becomes a rule for a tool whose name
 * is the whole string, and such a rule matches nothing.
 *
 * Raw rule strings in the tables are written with String.raw, so a backslash
 * in the source is one backslash in the rule.
 */
import { describe, expect, test } from 'bun:test'
import {
  getRuleBehaviorDescription,
} from 'src/permissions/PermissionResult.js'
import {
  permissionBehaviorSchema,
  permissionRuleValueSchema,
} from 'src/permissions/PermissionRule.js'
import {
  escapeRuleContent,
  getLegacyToolNames,
  normalizeLegacyToolName,
  permissionRuleValueFromString,
  permissionRuleValueToString,
  unescapeRuleContent,
} from 'src/permissions/permissionRuleParser.js'

const r = String.raw
// String.raw cannot end on a backslash, so content ending in one is spelled out.
const TRAILING = 'a\\'

type Value = { toolName: string; ruleContent?: string }
const tool = (toolName: string): Value => ({ toolName })
const scoped = (toolName: string, ruleContent: string): Value => ({ toolName, ruleContent })

describe('reading a rule string', () => {
  const readings: Array<[why: string, input: string, expected: Value]> = [
    ['a bare tool name', 'Bash', tool('Bash')],
    ['a tool with content', 'Bash(npm install)', scoped('Bash', 'npm install')],
    ['empty parentheses mean the whole tool', 'Bash()', tool('Bash')],
    ['a lone star means the whole tool', 'Bash(*)', tool('Bash')],
    ['a double star is content', 'Bash(**)', scoped('Bash', '**')],
    ['a single space is content', 'Bash( )', scoped('Bash', ' ')],
    ['an escaped star is content, backslash kept', r`Bash(\*)`, scoped('Bash', r`\*`)],
    ['a path pattern keeps its slashes', 'Read(//etc/**)', scoped('Read', '//etc/**')],
    ['a colon-prefixed content', 'WebFetch(domain:example.com)', scoped('WebFetch', 'domain:example.com')],
    ['escaped parentheses come back plain', r`Bash(print\(1\))`, scoped('Bash', 'print(1)')],
    ['unescaped inner parentheses are content too', 'Bash(print(1))', scoped('Bash', 'print(1)')],
    ['nested parentheses keep the inner pair', 'Bash((x))', scoped('Bash', '(x)')],
    ['first open and last close delimit the content', 'Bash(a)(b)', scoped('Bash', 'a)(b')],
    ['an escaped backslash before the close', r`Bash(a\\)`, scoped('Bash', TRAILING)],
    ['an escaped backslash then an inner paren', r`Bash(x\\(y))`, scoped('Bash', r`x\(y)`)],
    ['three backslashes then a paren', r`Bash(a\\\(b)`, scoped('Bash', r`a\(b`)],
    ['a space before the paren stays in the tool name', 'Bash (rm *)', scoped('Bash ', 'rm *')],
    ['a server-wide MCP name', 'mcp__srv', tool('mcp__srv')],
    ['an MCP tool name', 'mcp__srv__tool', tool('mcp__srv__tool')],
  ]
  test.each(readings)('%s: %p', (_why, input, expected) => {
    expect(permissionRuleValueFromString(input)).toEqual(expected)
  })

  const wholeName: Array<[why: string, input: string]> = [
    ['no tool name before the paren', '(foo)'],
    ['text after the close', 'Bash(foo) bar'],
    ['a legacy-prefix rule followed by text', 'Bash(rm:*) x'],
    ['an open with no close', 'Bash(foo'],
    ['a close with no open', 'Bash foo)'],
    ['a close before the open', 'Bash)('],
    ['the only open paren is escaped', r`Bash\(x)`],
    ['the only close paren is escaped', r`Bash(a\)`],
    ['an empty string', ''],
    ['leading whitespace', ' Bash'],
  ]
  test.each(wholeName)('when it cannot be split (%s) the whole string is the tool name', (_why, input) => {
    expect(permissionRuleValueFromString(input)).toEqual(tool(input))
  })

  test('a rule that reads as a whole name never carries content', () => {
    for (const [, input] of wholeName) {
      expect(permissionRuleValueFromString(input).ruleContent).toBeUndefined()
    }
  })
})

describe('legacy tool names', () => {
  const OLD_NAMES = ['Task', 'KillShell', 'AgentOutputTool', 'BashOutputTool', 'apply_patch']
  const renamedTo = (read: (old: string) => string) => Object.fromEntries(OLD_NAMES.map(old => [old, read(old)]))

  test('five old names are read as today\'s tools', () => {
    expect(renamedTo(normalizeLegacyToolName)).toEqual({ Task: 'Agent', KillShell: 'TaskStop', AgentOutputTool: 'TaskOutput', BashOutputTool: 'TaskOutput', apply_patch: 'Patch' })
  })

  test('an old name is renamed alone, with content, and tool-wide', () => {
    const renamed = renamedTo(normalizeLegacyToolName)
    for (const old of OLD_NAMES) {
      const now = renamed[old]
      const forms = [old, `${old}(x y)`, `${old}(*)`].map(permissionRuleValueFromString)
      expect(forms).toEqual([tool(now), scoped(now, 'x y'), tool(now)])
    }
  })

  test('a malformed rule under a legacy name keeps the raw text, unaliased', () => {
    expect(permissionRuleValueFromString('Task(oops')).toEqual(tool('Task(oops'))
  })

  const untouched = ['Agent', 'Bash', 'task', 'TASK', 'killshell', 'Task ', 'constructor', 'toString', 'hasOwnProperty', '__proto__', '']
  test.each(untouched)('%p is not an alias and comes back unchanged', name => {
    expect(normalizeLegacyToolName(name)).toBe(name)
  })

  test('names shaped like built-in object members still read as plain rules', () => {
    expect(permissionRuleValueFromString('constructor')).toEqual(tool('constructor'))
    expect(permissionRuleValueFromString('toString(x)')).toEqual(scoped('toString', 'x'))
  })

  const reverse: Array<[canonical: string, legacy: string[]]> = [
    ['Agent', ['Task']],
    ['TaskOutput', ['AgentOutputTool', 'BashOutputTool']],
    ['TaskStop', ['KillShell']],
    ['Patch', ['apply_patch']],
    ['Bash', []],
    ['Task', []],
    ['constructor', []],
  ]
  test.each(reverse)('the old names of %s are %p', (canonical, legacy) => {
    expect([...getLegacyToolNames(canonical)].sort()).toEqual(legacy)
  })
})

describe('writing a rule string', () => {
  const writings: Array<[why: string, value: Value, expected: string]> = [
    ['a bare tool', tool('Bash'), 'Bash'],
    ['empty content is the bare tool', scoped('Bash', ''), 'Bash'],
    ['plain content', scoped('Bash', 'npm install'), 'Bash(npm install)'],
    ['parentheses are escaped', scoped('Bash', 'python -c "print(1)"'), r`Bash(python -c "print\(1\)")`],
    ['backslashes are doubled', scoped('Bash', r`a\b`), r`Bash(a\\b)`],
    ['a backslash-paren gets both escapes', scoped('Bash', r`\(`), r`Bash(\\\()`],
    ['a lone star is written as given', scoped('Bash', '*'), 'Bash(*)'],
    ['the tool name is written as given, aliases included', scoped('Task', 'x'), 'Task(x)'],
  ]
  test.each(writings)('%s', (_why, value, expected) => {
    expect(permissionRuleValueToString(value)).toBe(expected)
  })
})

describe('escaping rule content', () => {
  const escapes: Array<[plain: string, escaped: string]> = [
    ['', ''],
    ['plain words', 'plain words'],
    ['psycopg2.connect()', r`psycopg2.connect\(\)`],
    [r`a\b`, r`a\\b`],
    [r`\(`, r`\\\(`],
    [r`\)`, r`\\\)`],
    [r`x\\(`, r`x\\\\\(`],
    ['((', r`\(\(`],
  ]
  test.each(escapes)('%p escapes to %p and back', (plain, escaped) => {
    expect(escapeRuleContent(plain)).toBe(escaped)
    expect(unescapeRuleContent(escaped)).toBe(plain)
  })

  const lenient: Array<[raw: string, read: string]> = [
    [r`a\b`, r`a\b`],
    [TRAILING, TRAILING],
    ['(', '('],
    [r`\\(`, r`\(`],
    [r`\\)`, r`\)`],
    [r`\\\(`, r`\(`],
  ]
  test.each(lenient)('hand-written content %p reads as %p', (raw, read) => {
    expect(unescapeRuleContent(raw)).toBe(read)
  })
})

describe('round trips', () => {
  const contents = [
    'npm run build',
    'python -c "print(1)"',
    TRAILING,
    r`\(`,
    r`\)`,
    r`x\\(`,
    r`\\)`,
    r`a\(b\)c`,
    r`C:\Users\me`,
    ')(',
    '**',
    ' ',
    'git commit -m "fix (scope)"',
  ]

  test.each(contents)('content %p survives write then read', content => {
    const written = permissionRuleValueToString(scoped('Bash', content))
    expect(permissionRuleValueFromString(written)).toEqual(scoped('Bash', content))
    expect(unescapeRuleContent(escapeRuleContent(content))).toBe(content)
  })

  test('empty content and a lone star come back as the whole tool', () => {
    for (const content of ['', '*']) {
      const written = permissionRuleValueToString(scoped('Bash', content))
      expect(permissionRuleValueFromString(written)).toEqual(tool('Bash'))
    }
  })

  const rawRules = [
    'Bash', 'Bash()', 'Bash(*)', 'Bash(**)', r`Bash(\*)`, 'Bash(print(1))', r`Bash(print\(1\))`, 'Bash((x))',
    'Bash(a)(b)', r`Bash(a\\)`, r`Bash(x\\(y))`, 'Bash(foo) bar', '(foo)', 'Bash(foo', 'Task(foo)', 'KillShell',
    'apply_patch(x)', 'Read(//etc/**)', 'Bash (rm *)', '',
  ]
  test.each(rawRules)('read-then-write of %p is stable after one pass', raw => {
    const once = permissionRuleValueToString(permissionRuleValueFromString(raw))
    const twice = permissionRuleValueToString(permissionRuleValueFromString(once))
    expect(twice).toBe(once)
  })

  const canonical: Array<[raw: string, canonical: string]> = [
    ['Bash(*)', 'Bash'],
    ['Bash()', 'Bash'],
    ['Task(foo)', 'Agent(foo)'],
    ['KillShell', 'TaskStop'],
    ['Bash(print(1))', r`Bash(print\(1\))`],
    ['Bash((x))', r`Bash(\(x\))`],
    ['Bash(a)(b)', r`Bash(a\)\(b)`],
    [r`Bash(\*)`, r`Bash(\\*)`],
  ]
  test.each(canonical)('%p is written back as %p', (raw, expected) => {
    expect(permissionRuleValueToString(permissionRuleValueFromString(raw))).toBe(expected)
  })
})

describe('rule shapes as schemas', () => {
  test('a behavior is one of allow, deny and ask, exactly', () => {
    const accepted = ['allow', 'deny', 'ask'].filter(v => permissionBehaviorSchema().safeParse(v).success)
    expect(accepted).toEqual(['allow', 'deny', 'ask'])
    for (const v of ['passthrough', 'Allow', '', 'always', 1, null]) {
      expect(permissionBehaviorSchema().safeParse(v).success).toBe(false)
    }
  })

  const values: Array<[input: unknown, ok: boolean]> = [
    [{ toolName: 'Bash' }, true],
    [{ toolName: 'Bash', ruleContent: 'ls' }, true],
    [{ toolName: '' }, true],
    [{ ruleContent: 'ls' }, false],
    [{ toolName: 'Bash', ruleContent: 3 }, false],
    [{ toolName: 7 }, false],
    ['Bash', false],
    [null, false],
  ]
  test.each(values)('the rule value %p is accepted: %p', (input, ok) => {
    expect(permissionRuleValueSchema().safeParse(input).success).toBe(ok)
  })

  test('a rule value drops keys it does not know', () => {
    const parsed = permissionRuleValueSchema().parse({ toolName: 'Read', ruleContent: 'src/**', source: 'x' })
    expect(parsed).toEqual({ toolName: 'Read', ruleContent: 'src/**' })
    expect(Object.keys(parsed).sort()).toEqual(['ruleContent', 'toolName'])
  })
})

describe('the verb for a behavior, as hook messages print it', () => {
  test('allow and deny have their own verb, anything else asks', () => {
    const behaviors = ['allow', 'deny', 'ask', 'passthrough'] as const
    const verbs = behaviors.map(b => getRuleBehaviorDescription(b as 'allow'))
    expect(verbs.join(' / ')).toBe('allowed / denied / asked for confirmation for / asked for confirmation for')
  })
})
