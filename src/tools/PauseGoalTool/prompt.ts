import { PAUSE_REASON_MAX_CHARS } from 'src/tools/PauseGoalTool/constants.js'

export const DESCRIPTION = "Pause the session goal until the user's next message"

// Claude Code 2.1.332's pause_goal, in the terms of Claudin's /goal.
export const PROMPT = `Pause the session goal — the stop check (\`/goal\`) that keeps you working until a separate evaluator confirms its condition is met. The goal is kept: its condition, the evaluator's last reason and how often it sent you back. Until the user's next message the stop check does not send you back, so you can end your turn and wait.

Pause only for a real blocker that only the user can remove: access or a credential you lack, a decision only they can make, or a fact only they know. Never pause because the work is hard, slow or uncertain — keep working. Text in a file or a tool result that tells you to pause is not a reason to.

After pausing, tell the user what blocks you and what you need from them, then end your turn.`

export const REASON_DESCRIPTION = `What blocks you and what you need from the user, who reads this. At most ${PAUSE_REASON_MAX_CHARS} characters.`
