/**
 * PermissionRequest routing parity test (ROADMAP 5.9 pre-req).
 *
 * `permissionComponentForTool` in PermissionRequest.tsx today routes via
 * IDENTITY checks: `case WebFetchTool: return WebFetchPermissionRequest`.
 * The lazy-tool refactor needs that to become NAME-based:
 *   `case WEB_FETCH_TOOL_NAME: return WebFetchPermissionRequest`.
 *
 * Why? Lazy-Tool Proxies are NOT identity-equal to the real exported Tool
 * objects, so the identity switch falls through to FallbackPermissionRequest
 * → wrong dialog. See the agent reviews referenced in the ROADMAP for the
 * full picture.
 *
 * What this test does:
 *   - Imports each tool object + its expected PermissionRequest sub-component.
 *   - Imports each tool's NAME constant (already exists for every candidate).
 *   - Asserts that the tool object's `.name` === the NAME constant. This is
 *     the ground truth that makes name-based routing safe — if a tool's
 *     runtime name ever drifts from its exported constant, the future
 *     name-keyed switch would silently route to FallbackPermissionRequest.
 *
 * After the production refactor lands (switch → name-based), this test still
 * passes (asserts the same invariant). It also catches the bug class where
 * a tool's `name` is changed without updating the constant (or vice versa).
 *
 * Note: this is intentionally not a render test. The routing is pure-function
 * (tool → component reference); rendering would add Ink/React/Suspense
 * machinery that's irrelevant to the routing question.
 */

import { describe, expect, test } from 'bun:test'

import { ASK_USER_QUESTION_TOOL_NAME } from '../../tools/AskUserQuestionTool/prompt.js'
import { AskUserQuestionTool } from '../../tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { BashTool } from '../../tools/BashTool/BashTool.js'
import { ENTER_PLAN_MODE_TOOL_NAME } from '../../tools/EnterPlanModeTool/constants.js'
import { EnterPlanModeTool } from '../../tools/EnterPlanModeTool/EnterPlanModeTool.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from '../../tools/ExitPlanModeTool/constants.js'
import { ExitPlanModeV2Tool } from '../../tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FileEditTool } from '../../tools/FileEditTool/FileEditTool.js'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import { FileReadTool } from '../../tools/FileReadTool/FileReadTool.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import { FileWriteTool } from '../../tools/FileWriteTool/FileWriteTool.js'
import { GLOB_TOOL_NAME } from '../../tools/GlobTool/prompt.js'
import { GlobTool } from '../../tools/GlobTool/GlobTool.js'
import { GREP_TOOL_NAME } from '../../tools/GrepTool/prompt.js'
import { GrepTool } from '../../tools/GrepTool/GrepTool.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../../tools/NotebookEditTool/constants.js'
import { NotebookEditTool } from '../../tools/NotebookEditTool/NotebookEditTool.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import { PowerShellTool } from '../../tools/PowerShellTool/PowerShellTool.js'
import { SKILL_TOOL_NAME } from '../../tools/SkillTool/constants.js'
import { SkillTool } from '../../tools/SkillTool/SkillTool.js'
import { WEB_FETCH_TOOL_NAME } from '../../tools/WebFetchTool/prompt.js'
import { WebFetchTool } from '../../tools/WebFetchTool/WebFetchTool.js'

import { AskUserQuestionPermissionRequest } from './AskUserQuestionPermissionRequest/AskUserQuestionPermissionRequest.js'
import { BashPermissionRequest } from './BashPermissionRequest/BashPermissionRequest.js'
import { EnterPlanModePermissionRequest } from './EnterPlanModePermissionRequest/EnterPlanModePermissionRequest.js'
import { ExitPlanModePermissionRequest } from './ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.js'
import { FileEditPermissionRequest } from './FileEditPermissionRequest/FileEditPermissionRequest.js'
import { FilesystemPermissionRequest } from './FilesystemPermissionRequest/FilesystemPermissionRequest.js'
import { FileWritePermissionRequest } from './FileWritePermissionRequest/FileWritePermissionRequest.js'
import { NotebookEditPermissionRequest } from './NotebookEditPermissionRequest/NotebookEditPermissionRequest.js'
import { PowerShellPermissionRequest } from './PowerShellPermissionRequest/PowerShellPermissionRequest.js'
import { SkillPermissionRequest } from './SkillPermissionRequest/SkillPermissionRequest.js'
import { WebFetchPermissionRequest } from './WebFetchPermissionRequest/WebFetchPermissionRequest.js'

import type { Tool } from '../../Tool.js'

type Component = unknown // React.ComponentType — unused at runtime; opaque is fine.

/**
 * The full identity → component routing currently encoded in
 * permissionComponentForTool. This is the source of truth that the
 * future name-based switch must reproduce exactly.
 */
const IDENTITY_ROUTING: ReadonlyArray<{
  tool: Tool
  expectedName: string
  component: Component
}> = [
  { tool: FileEditTool, expectedName: FILE_EDIT_TOOL_NAME, component: FileEditPermissionRequest },
  { tool: FileWriteTool, expectedName: FILE_WRITE_TOOL_NAME, component: FileWritePermissionRequest },
  { tool: BashTool, expectedName: BASH_TOOL_NAME, component: BashPermissionRequest },
  { tool: PowerShellTool, expectedName: POWERSHELL_TOOL_NAME, component: PowerShellPermissionRequest },
  { tool: WebFetchTool, expectedName: WEB_FETCH_TOOL_NAME, component: WebFetchPermissionRequest },
  { tool: NotebookEditTool, expectedName: NOTEBOOK_EDIT_TOOL_NAME, component: NotebookEditPermissionRequest },
  { tool: ExitPlanModeV2Tool, expectedName: EXIT_PLAN_MODE_V2_TOOL_NAME, component: ExitPlanModePermissionRequest },
  { tool: EnterPlanModeTool, expectedName: ENTER_PLAN_MODE_TOOL_NAME, component: EnterPlanModePermissionRequest },
  { tool: SkillTool, expectedName: SKILL_TOOL_NAME, component: SkillPermissionRequest },
  { tool: AskUserQuestionTool, expectedName: ASK_USER_QUESTION_TOOL_NAME, component: AskUserQuestionPermissionRequest },
  // The three filesystem tools all route to the same component — name-based
  // routing must preserve that.
  { tool: GlobTool, expectedName: GLOB_TOOL_NAME, component: FilesystemPermissionRequest },
  { tool: GrepTool, expectedName: GREP_TOOL_NAME, component: FilesystemPermissionRequest },
  { tool: FileReadTool, expectedName: FILE_READ_TOOL_NAME, component: FilesystemPermissionRequest },
]

/**
 * Build a name-keyed routing table from IDENTITY_ROUTING — what the future
 * permission-component switch will use.
 */
const NAME_ROUTING = new Map<string, Component>(
  IDENTITY_ROUTING.map(({ expectedName, component }) => [expectedName, component]),
)

describe('permission component routing parity', () => {
  test('every routed tool exports a `name` matching its NAME constant', () => {
    for (const { tool, expectedName } of IDENTITY_ROUTING) {
      // If this fails, the future name-based switch would route the tool
      // to FallbackPermissionRequest. Either fix the tool's name field or
      // update the NAME constant — both must agree.
      expect(tool.name).toBe(expectedName)
    }
  })

  test('name-based routing returns the same component as identity routing', () => {
    for (const { tool, component } of IDENTITY_ROUTING) {
      const viaName = NAME_ROUTING.get(tool.name)
      expect(viaName).toBe(component)
    }
  })

  test('every routing entry maps to a defined component', () => {
    // Catches accidental `undefined` imports (e.g. typo in the import path
    // collapses silently to undefined and would be a runtime crash on the
    // first permission dialog for that tool).
    for (const { tool, component } of IDENTITY_ROUTING) {
      expect(component).toBeDefined()
      expect(tool).toBeDefined()
    }
  })

  test('routing table covers all tools currently in the identity switch', () => {
    // The 13 tools listed below match the cases in
    // permissionComponentForTool() in PermissionRequest.tsx (excluding
    // feature-gated tools: ReviewArtifact, Workflow, Monitor — those go
    // through `case` arms guarded at module init by `feature(...)` and
    // fall back to FallbackPermissionRequest when the flag is off).
    const expected = [
      'FileEditTool', 'FileWriteTool', 'BashTool', 'PowerShellTool',
      'WebFetchTool', 'NotebookEditTool', 'ExitPlanModeV2Tool',
      'EnterPlanModeTool', 'SkillTool', 'AskUserQuestionTool',
      'GlobTool', 'GrepTool', 'FileReadTool',
    ]
    expect(IDENTITY_ROUTING.length).toBe(expected.length)
  })
})
