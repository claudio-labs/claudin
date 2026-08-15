import { logError } from 'src/utils/log.js'
import {
  createTask,
  getTaskListId,
  isTodoV2Enabled,
  listTasks,
} from 'src/tasks/tasks.js'

export type ParsedPlanTask = {
  subject: string
  description: string
}

// A markdown heading whose text starts with "Tasks" (case-insensitive),
// optionally followed by a parenthetical like "Tasks (implementation checklist)".
const TASKS_HEADING_RE = /^#{1,6}\s+tasks\b/i
// Any markdown heading — marks the end of the Tasks section.
const ANY_HEADING_RE = /^#{1,6}\s+/
// A top-level list item: "- [ ] x", "- x", "* x", or "1. x" with no leading
// indent. The captured group is the item text (marker already stripped).
const TOP_LEVEL_ITEM_RE = /^(?:[-*]\s+(?:\[[ xX]?\]\s+)?|\d+[.)]\s+)(.*)$/
// Opening/closing fence of a fenced code block (``` or ~~~).
const FENCE_RE = /^\s*(?:```|~~~)/
// An indented, non-blank continuation line (belongs to the current task).
const INDENTED_LINE_RE = /^\s+\S/

/**
 * Extract discrete tasks from a plan's `## Tasks` section. Each top-level list
 * item becomes one task: its text is the subject, and the following
 * more-indented lines become the description. Non-indented prose between items
 * is ignored. Returns [] when there is no Tasks section or it has no items.
 */
export function parsePlanTasks(planMarkdown: string): ParsedPlanTask[] {
  // Normalize CRLF/CR so a Windows-authored plan parses the same as LF.
  const lines = planMarkdown.replace(/\r\n?/g, '\n').split('\n')

  // Find the Tasks heading, ignoring any heading inside a fenced code block
  // (e.g. an example "## Tasks" shown in a ``` block, like the plan-mode
  // instructions inject).
  let i = 0
  let inFence = false
  while (i < lines.length) {
    const line = lines[i]!
    if (FENCE_RE.test(line)) inFence = !inFence
    else if (!inFence && TASKS_HEADING_RE.test(line)) break
    i++
  }
  if (i >= lines.length) return []
  i++ // skip the heading line

  const tasks: ParsedPlanTask[] = []
  let current: ParsedPlanTask | null = null
  const descLines: string[] = []

  const flush = (): void => {
    if (current) {
      current.description = descLines.join('\n').trim()
      tasks.push(current)
    }
    descLines.length = 0
  }

  for (; i < lines.length; i++) {
    const line = lines[i]!
    // Stop at the next heading.
    if (ANY_HEADING_RE.test(line)) break

    const topLevel = TOP_LEVEL_ITEM_RE.exec(line)
    if (topLevel) {
      flush()
      current = { subject: topLevel[1]!.trim(), description: '' }
    } else if (current && INDENTED_LINE_RE.test(line)) {
      // Indented continuation (sub-bullet / note) → current task's description.
      // Non-indented prose is intentionally ignored so stray sentences between
      // the heading and the list don't get folded into a task.
      descLines.push(line.trim())
    }
  }
  flush()

  return tasks.filter(t => t.subject !== '')
}

/**
 * Seed the TodoV2 task list from a plan's `## Tasks` section. Skips items whose
 * subject is already live in the list, so re-approving a refined plan doesn't
 * duplicate entries. Fail-soft: any error is logged and swallowed (returns 0)
 * so it never blocks plan exit. Returns the number of tasks created.
 *
 * "Live" means *not archived*, which is a different line than "not completed".
 * `archiveCompletedTasks` is what closes a batch; until it runs, finished tasks
 * are still on screen and still count as duplicates — otherwise refining a plan
 * mid-batch recreates every item you already ticked off as a pending twin.
 * Archived ones must NOT count, or a later plan that legitimately reuses a
 * subject gets silently swallowed ("Run the tests" is the same three words
 * every time).
 */
export async function seedTasksFromPlan(plan: string): Promise<number> {
  try {
    if (!isTodoV2Enabled()) return 0
    const parsed = parsePlanTasks(plan)
    if (parsed.length === 0) return 0

    const taskListId = getTaskListId()
    const existingSubjects = new Set(
      (await listTasks(taskListId))
        .filter(t => !t.metadata?._internal)
        .map(t => t.subject),
    )

    let created = 0
    for (const { subject, description } of parsed) {
      if (existingSubjects.has(subject)) continue
      await createTask(taskListId, {
        subject,
        description,
        status: 'pending',
        owner: undefined,
        blocks: [],
        blockedBy: [],
        metadata: { source: 'plan' },
      })
      existingSubjects.add(subject)
      created++
    }
    return created
  } catch (e) {
    logError(e)
    return 0
  }
}
