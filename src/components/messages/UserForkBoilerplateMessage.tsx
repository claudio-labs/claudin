import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import React from 'react'
import {
  FORK_BOILERPLATE_TAG,
  FORK_DIRECTIVE_PREFIX,
} from 'src/constants/xml.js'
import { UserPromptMessage } from 'src/components/messages/UserPromptMessage.js'

type Props = {
  addMargin: boolean
  param: TextBlockParam
}

/**
 * Strips the fork boilerplate block and the directive prefix, leaving the
 * per-child directive. Keep in sync with `buildChildMessage()` in
 * `src/tools/AgentTool/forkSubagent.ts`, which generates this text.
 *
 * Returns '' when the text isn't a fork child message, so the caller can fall
 * back to rendering it verbatim instead of hiding it.
 */
export function extractForkDirective(text: string): string {
  const closingTag = `</${FORK_BOILERPLATE_TAG}>`
  const end = text.lastIndexOf(closingTag)
  if (end === -1) return ''
  const rest = text.slice(end + closingTag.length).trim()
  return rest.startsWith(FORK_DIRECTIVE_PREFIX)
    ? rest.slice(FORK_DIRECTIVE_PREFIX.length)
    : rest
}

/**
 * First message of a fork child. It carries a long fixed boilerplate block —
 * byte-identical across every fork so they share the prompt cache — followed
 * by the per-child directive. Only the directive is worth showing, styled like
 * any other user prompt.
 */
export function UserForkBoilerplateMessage({
  addMargin,
  param,
}: Props): React.ReactNode {
  const directive = extractForkDirective(param.text)
  return (
    <UserPromptMessage
      addMargin={addMargin}
      param={{ type: 'text', text: directive || param.text }}
    />
  )
}
