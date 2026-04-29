import type React from 'react'
import { LspSettings } from '../../components/lsp/LspSettings.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: unknown,
  _args?: string,
): Promise<React.ReactNode> {
  return <LspSettings onComplete={onDone} />
}
