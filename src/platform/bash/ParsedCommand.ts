import {
  extractOutputRedirections,
  splitCommandWithOperators,
} from 'src/platform/bash/commands.js'

export type OutputRedirection = {
  target: string
  operator: '>' | '>>'
}

/**
 * Interface for parsed command implementations.
 *
 * There used to be two: this one over shell-quote, and a tree-sitter sibling
 * that needed a parser module no shipped bundle ever loaded. The sibling and
 * its `getTreeSitterAnalysis()` member are gone, so the interface is now a
 * description of the only implementation rather than a seam between two.
 */
export interface IParsedCommand {
  readonly originalCommand: string
  toString(): string
  getPipeSegments(): string[]
  withoutOutputRedirections(): string
  getOutputRedirections(): OutputRedirection[]
}

/**
 * @deprecated in name only — the `_DEPRECATED` suffix marks it as the legacy
 * regex/shell-quote path, and since the AST sibling was removed it is the only
 * path. Renaming it is a separate change; the name is load-bearing in enough
 * call sites and comments that moving it would bury this removal.
 */
export class RegexParsedCommand_DEPRECATED implements IParsedCommand {
  readonly originalCommand: string

  constructor(command: string) {
    this.originalCommand = command
  }

  toString(): string {
    return this.originalCommand
  }

  getPipeSegments(): string[] {
    try {
      const parts = splitCommandWithOperators(this.originalCommand)
      const segments: string[] = []
      let currentSegment: string[] = []

      for (const part of parts) {
        if (part === '|') {
          if (currentSegment.length > 0) {
            segments.push(currentSegment.join(' '))
            currentSegment = []
          }
        } else {
          currentSegment.push(part)
        }
      }

      if (currentSegment.length > 0) {
        segments.push(currentSegment.join(' '))
      }

      return segments.length > 0 ? segments : [this.originalCommand]
    } catch {
      return [this.originalCommand]
    }
  }

  withoutOutputRedirections(): string {
    if (!this.originalCommand.includes('>')) {
      return this.originalCommand
    }
    const { commandWithoutRedirections, redirections } =
      extractOutputRedirections(this.originalCommand)
    return redirections.length > 0
      ? commandWithoutRedirections
      : this.originalCommand
  }

  getOutputRedirections(): OutputRedirection[] {
    const { redirections } = extractOutputRedirections(this.originalCommand)
    return redirections
  }
}

/**
 * ParsedCommand provides methods for working with shell commands.
 *
 * It used to choose between tree-sitter and the regex implementation, and
 * cache the most recent result because a tree-sitter parse cost a native call
 * plus six tree walks. Neither applies now: the only implementation is a
 * constructor that stores a string, so the choice and the cache are gone.
 * `parse` stays async, and stays returning `null` for the empty command,
 * because every caller awaits it and branches on null.
 */
export const ParsedCommand = {
  parse(command: string): Promise<IParsedCommand | null> {
    return Promise.resolve(
      command ? new RegexParsedCommand_DEPRECATED(command) : null,
    )
  },
}
