/**
 * Rig for the permissions/ruleList characterization suites: the /permissions
 * screen (`PermissionRuleList`) opened over a session that already holds
 * rules, with every answer it gives its caller written to one ledger.
 *
 * Mounting, the key bindings, the app state and the isolated config home come
 * from the promptFrame rig; this file only adds what the rule list needs on
 * top: rules per source, the settings files those sources live in, and the
 * extra keys a tabbed screen is driven with.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import * as React from 'react'
import stripAnsi from 'strip-ansi'
import type { PermissionRuleSource } from 'src/permissions/PermissionRule.js'
import { PermissionRuleList } from 'src/permissions/ui/rules/PermissionRuleList.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { getEmptyToolPermissionContext, type ToolPermissionContext } from 'src/tools/Tool.js'
import { mount, type Screen, type World } from 'src/permissions/ui/__testutils__/promptFrameRig.js'

export const MOVE = { right: '\x1B[C', left: '\x1B[D', backspace: '\x7F' } as const

type Kind = 'allow' | 'deny' | 'ask'
/** Rule strings per kind and per source, as a session would hold them. */
export type Held = Partial<Record<Kind, Partial<Record<PermissionRuleSource, string[]>>>>

const SLOT = { allow: 'alwaysAllowRules', deny: 'alwaysDenyRules', ask: 'alwaysAskRules' } as const

export function sessionHolding(held: Held, extra: Partial<ToolPermissionContext> = {}): ToolPermissionContext {
  const context = { ...getEmptyToolPermissionContext(), ...extra } as ToolPermissionContext
  for (const kind of Object.keys(SLOT) as Kind[]) {
    if (held[kind]) (context as Record<string, unknown>)[SLOT[kind]] = { ...held[kind] }
  }
  return context
}

/** The rule strings the session holds now, per source, for one kind. */
export function heldNow(screen: Screen, kind: Kind): Record<string, string[] | undefined> {
  return screen.state().toolPermissionContext[SLOT[kind]] as Record<string, string[] | undefined>
}

// --- the files behind the editable sources -------------------------------------

export type FileSource = 'userSettings' | 'projectSettings' | 'localSettings'

export function settingsPath(world: World, source: FileSource): string {
  switch (source) {
    case 'userSettings':
      return join(world.config, 'settings.json')
    case 'projectSettings':
      return join(world.project, '.claudin', 'settings.json')
    case 'localSettings':
      return join(world.project, '.claudin', 'settings.local.json')
  }
}

export function writeSettings(world: World, source: FileSource, body: unknown): void {
  const path = settingsPath(world, source)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`)
  resetSettingsCache()
}

export function readSettings(world: World, source: FileSource): unknown {
  const path = settingsPath(world, source)
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
}

// --- opening the screen ------------------------------------------------------------

export type Exit = { result: string | undefined; options: unknown }

export type Opened = {
  screen: Screen
  /** Every `onExit` call, ANSI codes kept. */
  exits: Exit[]
  /** Every `onRetryDenials` call. */
  retries: string[][]
}

type OpenOptions = {
  initialTab?: 'recent' | 'allow' | 'ask' | 'deny' | 'workspace'
  /** Leave `onRetryDenials` out, as a caller may. */
  noRetryHandler?: boolean
  columns?: number
}

export async function openRules(context: ToolPermissionContext, options: OpenOptions = {}): Promise<Opened> {
  const exits: Exit[] = []
  const retries: string[][] = []
  const screen = await mount(
    <PermissionRuleList
      onExit={(result, opts) => exits.push({ result, options: opts })}
      initialTab={options.initialTab}
      onRetryDenials={options.noRetryHandler ? undefined : commands => retries.push(commands)}
    />,
    { appState: { toolPermissionContext: context }, columns: options.columns ?? 100, ready: frame => frame.includes('Permissions:') },
  )
  return { screen, exits, retries }
}

/** The exits with their text stripped of colour, for reading. */
export const plainExits = (exits: Exit[]) =>
  exits.map(exit => ({ result: exit.result === undefined ? undefined : stripAnsi(exit.result), options: exit.options }))

/** The option lines of the visible list, numbers dropped, cursor and scroll marks dropped. */
export function listed(frame: string): string[] {
  return frame
    .split('\n')
    .map(line => /^\s*(?:[❯↑↓]\s*)?\d+\.\s+(.*)$/.exec(line.replace(/│/g, ''))?.[1]?.trim())
    .filter((text): text is string => text !== undefined && text !== '')
}

/** The line the cursor is on, without the mark and number. */
export function focused(frame: string): string | undefined {
  const line = frame.split('\n').find(row => row.includes('❯'))
  return line ? /❯\s*\d+\.\s+(.*)$/.exec(line.replace(/│/g, ''))?.[1]?.trim() : undefined
}
