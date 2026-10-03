/**
 * The worktree names that tools make up for throwaway work, the only ones the
 * stale sweep may ever remove. Anything a person could have typed stays.
 */

type ThrowawayShape = { readonly madeBy: string; readonly shape: RegExp }

const THROWAWAY_SHAPES: readonly ThrowawayShape[] = [
  { madeBy: 'AgentTool', shape: /^agent-a[\da-f]{7}$/ },
  { madeBy: 'the workflow tool', shape: /^wf_[\da-f]{8}-[\da-f]{3}-[0-9]+$/ },
  { madeBy: 'older workflow builds', shape: /^wf-[0-9]+$/ },
  { madeBy: 'the bridge', shape: /^bridge-\w+(?:-\w+)*$/ },
  { madeBy: 'template jobs', shape: /^job-[\w.-]{1,55}-[\da-f]{8}$/ },
]

export function isThrowawayName(name: string): boolean {
  return THROWAWAY_SHAPES.some(({ shape }) => shape.test(name))
}
