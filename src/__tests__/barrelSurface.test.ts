/**
 * Pins the public export surface of the modules being turned into barrels.
 *
 * A barrel split moves bodies into siblings and re-exports them. If one
 * re-export is dropped or mistyped, `bun run build` still succeeds and `tsc`
 * still passes — the importer that needed it is the only thing that notices,
 * at runtime, in whatever code path reaches it first. An over-trimmed
 * re-export is exactly the failure mode that got through during the BashTool
 * split (#129), where four characterization tests caught a missing import that
 * both gates had waved past.
 *
 * So: the value exports are compared as a whole sorted list, not checked one
 * by one, because the point is to catch a name that silently vanished. Adding
 * an export is meant to fail here too — update the list deliberately.
 *
 * Type-only exports have no runtime representation, so they are pinned by
 * importing them below; a removed type is a tsc error on this file.
 */
import { describe, expect, test } from 'bun:test'

import * as filePermissions from 'src/permissions/filePermissions.js'
import * as permissions from 'src/permissions/permissions.js'
import * as stableStubState from 'src/agent/compact/stableStubState.js'
import * as yoloClassifier from 'src/permissions/yoloClassifier.js'

// Type-only exports: absent from Object.keys, pinned by being named here.
import type { AutoModeRules, TranscriptEntry } from 'src/permissions/yoloClassifier.js'
import type {
  AnyMessage,
  ClipFrontierMutability,
} from 'src/agent/compact/stableStubState.js'

type PinnedTypes = [AutoModeRules, TranscriptEntry, AnyMessage, ClipFrontierMutability]

const SURFACES: ReadonlyArray<{
  name: string
  module: Record<string, unknown>
  exports: readonly string[]
}> = [
  {
    name: 'src/permissions/filePermissions.ts',
    module: filePermissions,
    exports: [
      'allWorkingDirectories',
      'checkBatchWritePermission',
      'checkEditableInternalPath',
      'checkPathSafetyForAutoEdit',
      'checkReadPermissionForTool',
      'checkReadableInternalPath',
      'checkWritePermissionForTool',
      'generateSuggestions',
      'getFileReadIgnorePatterns',
      'isClaudeSettingsPath',
      'matchingRuleForInput',
      'normalizeCaseForComparison',
      'normalizePatternsToPath',
      'pathInAllowedWorkingPath',
      'pathInWorkingPath',
    ],
  },
  {
    name: 'src/permissions/permissions.ts',
    module: permissions,
    exports: [
      'applyPermissionRulesToPermissionContext',
      'checkRuleBasedPermissions',
      'createPermissionRequestMessage',
      'deletePermissionRule',
      'filterDeniedAgents',
      'getAllowRules',
      'getAskRuleForTool',
      'getAskRules',
      'getDenyRuleForAgent',
      'getDenyRuleForTool',
      'getDenyRules',
      'getRuleByContentsForTool',
      'getRuleByContentsForToolName',
      'hasPermissionsToUseTool',
      'permissionRuleSourceDisplayString',
      'planModeDefersToClassifier',
      'syncPermissionRulesFromDisk',
      'toolAlwaysAllowedRule',
    ],
  },
  {
    name: 'src/permissions/yoloClassifier.ts',
    module: yoloClassifier,
    exports: [
      'YOLO_CLASSIFIER_TOOL_NAME',
      'YOLO_CLASSIFIER_TOOL_SCHEMA',
      '__setClassifierPromptsForTests',
      'buildDefaultExternalSystemPrompt',
      'buildTranscriptForClassifier',
      'buildYoloSystemPrompt',
      'classifyYoloAction',
      'formatActionForClassifier',
      'getAutoModeClassifierErrorDumpPath',
      'getDefaultExternalAutoModeRules',
      'isClassifierBundled',
    ],
  },
  {
    name: 'src/agent/compact/stableStubState.ts',
    module: stableStubState,
    exports: [
      'MAX_PINNED_RESULT_TOKENS',
      'MAX_SHIELDED_PASSES',
      '_getClippedIdsMapSizeForTesting',
      '_getClippedIdsTotalCountForTesting',
      '_getPinnedToolResultsForTesting',
      '_getSpentPinIdsForTesting',
      '_resetAllClippedIdsForTesting',
      '_resetClipFrontierForTesting',
      'addClippedIds',
      'addClippedInputs',
      'applyStableInputStubs',
      'applyStableStubs',
      'buildClipStub',
      'buildClipStubWithHead',
      'bumpStandDownEpoch',
      'collectClearableCandidates',
      'exceedsPinnedResultCeiling',
      'getClipFrontierIndex',
      'getClippedIds',
      'getClippedInputFields',
      'getStandDownEpoch',
      'isClipFrontierEnabled',
      'isClipStubContent',
      'isPinRegistered',
      'isPinShielding',
      'pinShieldsBlock',
      'pinToolResult',
      'pruneContentReplacementState',
      'pruneOldToolResults',
      'pruneOrphanClippedIds',
      'pruneStaleClippedIds',
      'resetClippedIds',
      'retirePinAfterUse',
      'stubToolResultForDisplay',
      'unpinToolResult',
    ],
  },
]

describe('barrel export surfaces', () => {
  for (const surface of SURFACES) {
    test(`${surface.name} exports exactly its pinned surface`, () => {
      expect(Object.keys(surface.module).sort()).toEqual(
        [...surface.exports].sort(),
      )
    })

    test(`${surface.name} exports nothing undefined`, () => {
      // A re-export pointing at a name the sibling does not declare resolves
      // to undefined rather than throwing, so the key is present and the
      // value is not. Object.keys alone would not see that.
      for (const name of surface.exports) {
        expect(surface.module[name]).toBeDefined()
      }
    })
  }
})
