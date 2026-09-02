import * as React from 'react'

import { ImportTree } from 'src/commands/import/ImportTree.js'
import {
  buildAgentEntries,
  countConflicts,
  selectedArtifacts,
  type AgentEntry,
} from 'src/commands/import/tree.js'
import { applyImportPlan } from 'src/platform/import/apply.js'
import { collectImportPlan, createCollectContext } from 'src/platform/import/collect.js'
import { detectForeignAgents } from 'src/platform/import/detect.js'
import { markStatuses } from 'src/platform/import/diff.js'
import { formatImportReport } from 'src/platform/import/format.js'
import { allAgentLabels, ADAPTERS } from 'src/platform/import/registry.js'
import type {
  CollectContext,
  ForeignAgentId,
  ImportArtifact,
  ImportPlan,
} from 'src/platform/import/types.js'
import { Box, Text } from 'src/terminal/ink.js'
import { Select } from 'src/terminal/custom-select/index.js'
import type { LocalJSXCommandOnDone } from 'src/shared/types/command.js'

type Phase =
  | { kind: 'loading' }
  | {
      kind: 'selecting'
      ctx: CollectContext
      plan: ImportPlan
      entries: AgentEntry[]
    }
  | {
      kind: 'confirming'
      plan: ImportPlan
      artifacts: ImportArtifact[]
      conflicts: number
      homeDir: string
    }
  | { kind: 'applying' }

/**
 * `/import codex` skips straight to Codex. An unknown argument is ignored
 * rather than refused — the tree that follows already lists what was found.
 */
function requestedAgents(args: string): ForeignAgentId[] {
  const requested = args
    .trim()
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(token => token.length > 0)
  if (requested.length === 0) return []
  return ADAPTERS.filter(
    adapter =>
      requested.includes(adapter.id) ||
      requested.includes(adapter.label.toLowerCase()),
  ).map(adapter => adapter.id)
}

function ImportFlow({
  args,
  onDone,
}: {
  args: string
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const [phase, setPhase] = React.useState<Phase>({ kind: 'loading' })

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      const ctx = createCollectContext()
      const detected = detectForeignAgents(ctx)
      const wanted = requestedAgents(args)
      const selectedAgents =
        wanted.length > 0
          ? detected.filter(agent => wanted.includes(agent.id))
          : detected

      if (selectedAgents.length === 0) {
        onDone(
          `No other AI coding agents detected (looked for: ${allAgentLabels().join(', ')}).`,
        )
        return
      }

      const collected = await collectImportPlan(
        ctx,
        selectedAgents.map(agent => agent.id),
      )
      const plan = markStatuses(collected, ctx)
      const entries = buildAgentEntries(selectedAgents, plan, ctx.homeDir)
      if (cancelled) return

      if (entries.length === 0) {
        const found = selectedAgents.map(agent => agent.label).join(', ')
        onDone(`Found ${found}, but there is nothing left to import.`)
        return
      }
      setPhase({ kind: 'selecting', ctx, plan, entries })
    })()
    return () => {
      cancelled = true
    }
    // Runs once: the import is a snapshot of the filesystem at invocation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const runApply = React.useCallback(
    async (
      plan: ImportPlan,
      artifacts: ImportArtifact[],
      overwriteConflicts: boolean,
      homeDir: string,
    ): Promise<void> => {
      setPhase({ kind: 'applying' })
      const report = await applyImportPlan(plan, artifacts, {
        overwriteConflicts,
      })
      onDone(formatImportReport(report, homeDir))
    },
    [onDone],
  )

  if (phase.kind === 'loading') {
    return (
      <Box marginBottom={1}>
        <Text dimColor>Looking for other AI coding agents…</Text>
      </Box>
    )
  }

  if (phase.kind === 'applying') {
    return (
      <Box marginBottom={1}>
        <Text dimColor>Importing…</Text>
      </Box>
    )
  }

  if (phase.kind === 'confirming') {
    const { plan, artifacts, conflicts, homeDir } = phase
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>
          {`${conflicts} of the selected item${conflicts === 1 ? '' : 's'} already exist${conflicts === 1 ? 's' : ''} here.`}
        </Text>
        <Select
          options={[
            {
              value: 'keep',
              label: 'Import the rest, keep what I already have',
              description: 'Conflicts are listed in the report and left alone.',
            },
            {
              value: 'overwrite',
              label: `Import everything, overwriting ${conflicts}`,
              description: 'Replaces the existing values with the imported ones.',
            },
            { value: 'cancel', label: 'Cancel', description: 'Write nothing.' },
          ]}
          onChange={(value: string) => {
            if (value === 'cancel') {
              onDone()
              return
            }
            void runApply(plan, artifacts, value === 'overwrite', homeDir)
          }}
          onCancel={() => onDone()}
          visibleOptionCount={3}
        />
      </Box>
    )
  }

  const { ctx, plan, entries } = phase
  return (
    <ImportTree
      entries={entries}
      notImportable={[
        ...new Set(plan.notImportable.map(item => item.label)),
      ]}
      onCancel={() => onDone()}
      onSubmit={selected => {
        const artifacts = selectedArtifacts(entries, new Set(selected))
        if (artifacts.length === 0) {
          onDone('Nothing selected — nothing imported.')
          return
        }
        const conflicts = countConflicts(artifacts)
        if (conflicts > 0) {
          setPhase({
            kind: 'confirming',
            plan,
            artifacts,
            conflicts,
            homeDir: ctx.homeDir,
          })
          return
        }
        void runApply(plan, artifacts, false, ctx.homeDir)
      }}
    />
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: unknown,
  args: string,
): Promise<React.ReactNode> {
  return <ImportFlow args={args ?? ''} onDone={onDone} />
}
