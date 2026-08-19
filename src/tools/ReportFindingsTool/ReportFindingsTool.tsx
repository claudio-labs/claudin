import * as React from 'react'
import { z } from 'zod/v4'
import { BLACK_CIRCLE } from 'src/shared/constants/figures.js'
import { getModeColor } from 'src/permissions/PermissionMode.js'
import { Box, Text } from 'src/terminal/ink.js'
import { buildTool, type Tool, type ToolDef } from 'src/tools/Tool.js'
import { EFFORT_LEVELS } from 'src/providers/effort/effort.js'
import { lazySchema } from 'src/shared/data/lazySchema.js'
import {
  MAX_CATEGORY_CHARS,
  MAX_FINDINGS,
  REPORT_FINDINGS_TOOL_NAME,
} from 'src/tools/ReportFindingsTool/constants.js'
import { DESCRIPTION, PROMPT } from 'src/tools/ReportFindingsTool/prompt.js'

const findingSchema = lazySchema(() =>
  z.strictObject({
    file: z.string().describe('Repo-relative path of the file the finding is in'),
    summary: z.string().describe('One-sentence statement of the defect'),
    failure_scenario: z
      .string()
      .describe('Concrete inputs/state → wrong output/crash'),
    line: z
      .number()
      .int()
      .optional()
      .describe('1-indexed line the finding anchors to'),
    category: z
      .string()
      .max(MAX_CATEGORY_CHARS)
      .optional()
      .describe(
        'Short kebab-case slug of the finding type, e.g. "correctness", "simplification", "efficiency", "test-coverage"',
      ),
    verdict: z
      .enum(['CONFIRMED', 'PLAUSIBLE'])
      .optional()
      .describe('Set when a verify pass ran; absent on inline-only reviews'),
    outcome: z
      .enum(['fixed', 'skipped', 'no_change_needed'])
      .optional()
      .describe(
        'Set ONLY when re-reporting after applying fixes: what happened to this finding',
      ),
  }),
)

const inputSchema = lazySchema(() =>
  z.strictObject({
    findings: z
      .array(findingSchema())
      .max(MAX_FINDINGS)
      .describe('Verified findings, most-severe first; empty if none survived'),
    level: z
      .enum(EFFORT_LEVELS)
      .optional()
      .describe('Effort level the review ran at'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    findings: z.array(findingSchema()),
    level: z.enum(EFFORT_LEVELS).optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Finding = z.infer<ReturnType<typeof findingSchema>>
export type Output = z.infer<OutputSchema>

const countFindings = (n: number): string => `${n} finding${n === 1 ? '' : 's'}`

function ReportFindingsResultMessage({ findings }: { findings: Finding[] }) {
  const label =
    findings.length === 0
      ? 'No findings survived verification.'
      : `Reported ${countFindings(findings.length)}:`
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color={getModeColor('default')}>{BLACK_CIRCLE}&nbsp;</Text>
        <Text>{label}</Text>
      </Box>
      <Box flexDirection="column">
        {findings.map((f, i) => (
          <Box key={`${f.file}:${f.line ?? 0}:${i}`} flexDirection="column">
            {/* Marker in its own fixed column so a wrapped summary hangs
                under the text rather than back at column 0. */}
            <Box flexDirection="row">
              <Box width={2} flexShrink={0}>
                <Text color="inactive">{'· '}</Text>
              </Box>
              <Box flexGrow={1}>
                {/* wrap-trim: plain "wrap" keeps the space it broke on, which
                    would push every continuation one column past the indent. */}
                <Text color="inactive" wrap="wrap-trim">
                  {f.file}
                  {f.line != null ? `:${f.line}` : ''} — {f.summary}
                  {f.verdict ? ` (${f.verdict})` : ''}
                  {f.outcome ? ` [${f.outcome}]` : ''}
                </Text>
              </Box>
            </Box>
            <Box flexDirection="row">
              <Box width={4} flexShrink={0}>
                <Text color="inactive">{'  ↳ '}</Text>
              </Box>
              <Box flexGrow={1}>
                <Text color="inactive" wrap="wrap-trim">
                  {f.failure_scenario}
                </Text>
              </Box>
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

export const ReportFindingsTool: Tool<InputSchema, Output> = buildTool({
  name: REPORT_FINDINGS_TOOL_NAME,
  searchHint: 'report code-review findings as a typed, host-rendered list',
  maxResultSizeChars: 100_000,
  strict: true,
  // Review-only: keep its schema out of every non-review request's tool list
  // (and out of casual reach). The /code-review skill loads it via ToolSearch.
  shouldDefer: true,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return REPORT_FINDINGS_TOOL_NAME
  },
  // Pure structured output: no side effect, safe to run alongside anything.
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return `${input.findings.length} findings`
  },
  async checkPermissions(input) {
    // No side effect — nothing to gate.
    return { behavior: 'allow', updatedInput: input }
  },
  renderToolUseMessage() {
    return null
  },
  renderToolResultMessage({ findings }, _progressMessages) {
    return <ReportFindingsResultMessage findings={findings} />
  },
  async call({ findings, level }, _context) {
    return {
      data: {
        findings,
        ...(level != null && { level }),
      },
    }
  },
  mapToolResultToToolResultBlockParam({ findings }, toolUseID) {
    const content =
      findings.length === 0
        ? 'Findings reported: none survived verification.'
        : `Reported ${countFindings(findings.length)} to the host. Do not also print them as text.`
    return {
      type: 'tool_result',
      content,
      tool_use_id: toolUseID,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
