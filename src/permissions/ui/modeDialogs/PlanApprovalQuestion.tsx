/**
 * The question part of "Ready to code?": the question, the answers, the
 * editor hint and the saved note. It is drawn inside the dialog, or in the
 * fullscreen layout's sticky footer when the layout offers one.
 */
import React from 'react'
import type { PastedContent } from 'src/platform/config/config.js'
import { type OptionWithDescription, Select } from 'src/terminal/custom-select/index.js'
import type { ImageDimensions } from 'src/terminal/image/imageResizer.js'
import { Box, Text } from 'src/terminal/ink.js'
import { useCwdBranchSegment } from 'src/vcs/hooks/useCwdBranchSegment.js'
import type { ResponseValue } from 'src/permissions/ui/modeDialogs/planExitChoices.js'

export type PlanApprovalQuestionProps = {
  question: string
  options: OptionWithDescription<ResponseValue>[]
  onAnswer: (value: ResponseValue) => void
  onCancel: () => void
  pasted: Record<number, PastedContent>
  onImagePaste: (base64: string, mediaType?: string, filename?: string, dimensions?: ImageDimensions, sourcePath?: string) => void
  onRemoveImage: (id: number) => void
  /** `ctrl-g to edit in …`, or null when no editor is configured. */
  editorHint: string | null
  savedNoteVisible: boolean
}

export function PlanApprovalQuestion(props: PlanApprovalQuestionProps): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text>{props.question}</Text>
      <Box marginTop={1}>
        <Select
          layout="compact-vertical"
          options={props.options}
          onChange={props.onAnswer}
          onCancel={props.onCancel}
          onImagePaste={props.onImagePaste}
          pastedContents={props.pasted}
          onRemoveImage={props.onRemoveImage}
        />
      </Box>
      {props.editorHint !== null && (
        <Box marginTop={1}>
          <Text dimColor>{props.editorHint}</Text>
        </Box>
      )}
      {props.savedNoteVisible && <Text color="success">Plan saved!</Text>}
    </Box>
  )
}

/**
 * The footer's frame. Like the prompt it stands in for, its bottom border
 * names the working directory and branch. No side borders, so each answer
 * line starts with its pointer.
 */
export function PlanFooterFrame({ children }: { children: React.ReactNode }): React.ReactNode {
  const { combined } = useCwdBranchSegment()
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="planMode"
      borderLeft={false}
      borderRight={false}
      paddingX={1}
      borderText={combined ? { content: combined, position: 'bottom', align: 'end', offset: 1 } : undefined}
    >
      {children}
    </Box>
  )
}
