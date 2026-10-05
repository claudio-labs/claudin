/**
 * Ctrl+G in the plan dialog: the external editor opens the session's plan
 * file itself, and whatever it leaves there becomes the plan shown and sent.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNotifications } from 'src/terminal/contexts/notifications.js'
import { editFileInEditor } from 'src/terminal/input/promptEditor.js'

const SAVED_NOTE_MS = 5_000

export type PlanEditor = {
  plan: string
  /** The plan now differs from the one the dialog opened with. */
  edited: boolean
  savedNoteVisible: boolean
  openEditor: () => void
}

export function usePlanEditor(planPath: string, initialPlan: string): PlanEditor {
  const [plan, setPlan] = useState(initialPlan)
  const [savedNoteVisible, setSavedNoteVisible] = useState(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const { addNotification } = useNotifications()

  useEffect(() => () => clearTimeout(hideTimer.current), [])

  const openEditor = useCallback(() => {
    const result = editFileInEditor(planPath)
    if (result.error) {
      addNotification({ key: 'external-editor-error', text: result.error, color: 'warning', priority: 'high' })
      return
    }
    if (result.content === null) return
    setPlan(result.content)
    // Shown on every return from the editor, changed or not.
    setSavedNoteVisible(true)
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setSavedNoteVisible(false), SAVED_NOTE_MS)
  }, [planPath, addNotification])

  return { plan, edited: plan !== initialPlan, savedNoteVisible, openEditor }
}
