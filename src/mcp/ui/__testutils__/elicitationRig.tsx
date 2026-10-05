/**
 * Puts an MCP elicitation in front of the user, the way the REPL does: one
 * queued event handed to `ElicitationDialog`, whose two callbacks are written
 * down in the order they fire. Mounting, keys and the isolated config home
 * come from the promptFrame rig.
 */
import * as React from 'react'
import type { ElicitationRequestEvent } from 'src/mcp/elicitationHandler.js'
import { ElicitationDialog } from 'src/mcp/ui/ElicitationDialog.js'
import { mount, type Screen } from 'src/permissions/ui/__testutils__/promptFrameRig.js'

/** What the dialog reported, oldest first. */
export type Reported =
  | { via: 'onResponse'; action: string; content?: unknown }
  | { via: 'onWaitingDismiss'; action: string }

export type Field = Record<string, unknown>

export type FormShape = {
  fields: Record<string, Field>
  required?: string[]
  message?: string
  server?: string
}

export type LinkShape = {
  url: string
  message?: string
  server?: string
  waitingState?: { actionLabel: string; showCancel?: boolean }
}

export type Opened = {
  screen: Screen
  log: Reported[]
  /** Aborts the request's signal, as a server cancelling it would. */
  abort: () => void
  /** Re-renders with the event marked completed, as the completion notice does. */
  complete: () => Promise<void>
  /** The last onResponse, or undefined. */
  answered: () => Reported | undefined
}

type Options = { preAborted?: boolean; withoutWaitingDismiss?: boolean; columns?: number }

function formParams(shape: FormShape) {
  const schema: Record<string, unknown> = { type: 'object', properties: shape.fields }
  if (shape.required) schema.required = shape.required
  return { message: shape.message ?? 'Fill this in please', requestedSchema: schema }
}

function linkParams(shape: LinkShape) {
  return { mode: 'url', message: shape.message ?? 'Sign in to continue', url: shape.url, elicitationId: 'elic-7' }
}

async function present(params: unknown, server: string, waitingState: LinkShape['waitingState'], options: Options): Promise<Opened> {
  const log: Reported[] = []
  const controller = new AbortController()
  if (options.preAborted) controller.abort()
  const base = {
    serverName: server,
    requestId: 41,
    params,
    signal: controller.signal,
    respond: () => {},
    ...(waitingState ? { waitingState } : {}),
  } as unknown as ElicitationRequestEvent
  const onResponse = (action: string, content?: unknown) =>
    log.push(content === undefined ? { via: 'onResponse', action } : { via: 'onResponse', action, content })
  const onWaitingDismiss = options.withoutWaitingDismiss
    ? undefined
    : (action: string) => log.push({ via: 'onWaitingDismiss', action })
  const draw = (event: ElicitationRequestEvent) => (
    <ElicitationDialog event={event} onResponse={onResponse} onWaitingDismiss={onWaitingDismiss} />
  )
  const screen = await mount(draw(base), { columns: options.columns ?? 100, ready: frame => frame.includes('MCP server') })
  return {
    screen,
    log,
    abort: () => controller.abort(),
    complete: () => screen.replace(draw({ ...base, completed: true })),
    answered: () => log.findLast(entry => entry.via === 'onResponse'),
  }
}

export function openForm(shape: FormShape, options: Options = {}): Promise<Opened> {
  return present(formParams(shape), shape.server ?? 'notes', undefined, options)
}

export function openLink(shape: LinkShape, options: Options = {}): Promise<Opened> {
  return present(linkParams(shape), shape.server ?? 'notes', shape.waitingState, options)
}

/** The frame's lines, trimmed, blanks dropped. */
export const rows = (frame: string): string[] =>
  frame
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')

/** The line that names the field, as drawn. */
export function fieldRow(frame: string, label: string): string {
  const found = rows(frame).find(line => new RegExp(`(^|\\s)${escapeForRegex(label)}: `).test(line) || line.endsWith(`${label}:`))
  if (found === undefined) throw new Error(`no row for ${label} in:\n${frame}`)
  return found
}

function escapeForRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, ch => `\\${ch}`)
}

/** The row holding the buttons. */
export const buttonRow = (frame: string): string => {
  const found = rows(frame).find(line => /Accept|Reopen URL/.test(line))
  if (found === undefined) throw new Error(`no buttons in:\n${frame}`)
  return found
}

/** The last line, which carries the key guide. */
export const guide = (frame: string): string => rows(frame).at(-1) ?? ''

/** Typing a word is pressing its characters one at a time. */
export const letters = (text: string): string[] => [...text]
