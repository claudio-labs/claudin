// The model-facing rendering of a Container result.
//
// The per-op body is already shaped by `run.ts`; this composes the framing
// around it. The one rule that matters: a FAILURE keeps its raw text, with the
// one-line diagnosis prepended. Summarizing is for successful, noisy output —
// budgeting a failure is how a tool hands back a shorter version of the thing
// the caller needed in full.

import type { ContainerToolOutput } from 'src/tools/ContainerTool/types.js'

function seconds(ms: number): string {
  return ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`
}

export function containerOpFailed(output: ContainerToolOutput): boolean {
  if (output.exitCode !== 0) return true
  // A wait that ran out is not an error exit, but it did not do what was asked.
  if (output.wait && !output.wait.satisfied) return true
  return output.build?.failure != null
}

export function formatContainerResult(output: ContainerToolOutput): string {
  const parts: string[] = []

  if (output.diagnosis) {
    parts.push(output.diagnosis.summary)
  }

  if (output.backgroundTaskId) {
    parts.push(
      `Running in the background as task ${output.backgroundTaskId}. Output arrives as it is produced.`,
    )
  }

  if (output.wait) {
    const w = output.wait
    if (w.impossible) {
      parts.push(w.impossible)
    } else if (w.satisfied) {
      parts.push(`${w.observedState} after ${seconds(w.waitedMs)}.`)
    } else {
      // Never a bare "timed out": the last observed state is the answer the
      // caller actually needs.
      parts.push(
        `Still ${w.observedState}${w.observedHealth ? ` (${w.observedHealth})` : ''} after ${seconds(w.waitedMs)}.`,
      )
    }
  }

  if (output.contextWarning) parts.push(output.contextWarning)

  const body = output.output.trim()
  if (body) parts.push(body)

  if (output.stall) {
    // An observation, not a verdict. A long `RUN apt-get` is legitimately quiet.
    parts.push(
      `Stopped after ${seconds(output.stall.ranMs)} (${output.stall.reason === 'idle' ? 'no output' : 'time limit'}), silent for ${seconds(output.stall.silentMs)}. Last line: ${output.stall.lastLine || '(none)'}`,
    )
  }

  if (output.filtered) {
    parts.push(
      `(${output.filtered.name} filter removed ${output.filtered.reductionPct}% of the output)`,
    )
  }

  return parts.join('\n\n') || `${output.op}: no output`
}
