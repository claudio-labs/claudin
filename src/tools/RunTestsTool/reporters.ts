import { randomBytes } from 'crypto'
import * as os from 'os'
import * as path from 'path'
import type { Framework } from './types.js'

/**
 * Reporter-flag injection. For each framework we prefer to append a *built-in*
 * machine reporter (no extra dependency to install) so parsing is exact:
 *   - vitest / bun → JUnit XML to a temp file
 *   - pytest       → --junitxml to a temp file
 *   - phpunit      → --log-junit to a temp file
 *   - go           → -json on stdout
 *   - maven/gradle → surefire already writes XML under the build dir; we scan it
 * Runners whose JUnit output needs a third-party plugin (jest, rspec, dotnet)
 * are left untouched and handled by the heuristic text parser.
 *
 * Injection is skipped entirely when the command is a package-manager script
 * wrapper (`npm test`, `yarn test`, …) because flags wouldn't reach the runner.
 */

export type ReporterPlan = {
  command: string
  /** A temp file the reporter will write; read + deleted after the run. */
  reportFile?: string
  /** A directory to scan for `*.xml` reports after the run (surefire). */
  reportDir?: string
  /** True when the command wraps a pkg script and no reporter could be added. */
  wrapped: boolean
}

// A package-manager *script* wrapper hides the real runner, so injected flags
// wouldn't reach it. `bun test` is deliberately excluded: it is Bun's native
// test runner (it accepts --reporter=junit), not a script indirection — only
// `bun run <script>` is a wrapper.
const WRAPPED_RE = /^\s*(?:(?:npm|pnpm|yarn|bun)\s+run\s+\S+|(?:npm|pnpm|yarn)\s+(?:test|t))\b/
const WATCH_RE = /(?:^|\s)(?:--watch(?:All)?|-w|--ui|--watch-path)\b/

export function isWrappedScript(command: string): boolean {
  return WRAPPED_RE.test(command)
}

export function hasWatchFlag(command: string): boolean {
  return WATCH_RE.test(command)
}

function tmpReport(ext: string): string {
  return path.join(os.tmpdir(), `claudin-tests-${randomBytes(6).toString('hex')}.${ext}`)
}

export function planReporter(framework: Framework, command: string): ReporterPlan {
  if (isWrappedScript(command)) {
    return { command, wrapped: true }
  }

  switch (framework) {
    case 'vitest': {
      const file = tmpReport('xml')
      return { command: `${command} --reporter=junit --outputFile=${file}`, reportFile: file, wrapped: false }
    }
    case 'bun': {
      const file = tmpReport('xml')
      return { command: `${command} --reporter=junit --reporter-outfile=${file}`, reportFile: file, wrapped: false }
    }
    case 'pytest': {
      const file = tmpReport('xml')
      return { command: `${command} --junitxml=${file}`, reportFile: file, wrapped: false }
    }
    case 'phpunit':
    case 'pest': {
      // Pest wraps PHPUnit and forwards --log-junit.
      const file = tmpReport('xml')
      return { command: `${command} --log-junit ${file}`, reportFile: file, wrapped: false }
    }
    case 'deno': {
      // --junit-path keeps human stdout; no --reporter needed (Deno ≥1.36).
      const file = tmpReport('xml')
      return { command: `${command} --junit-path=${file}`, reportFile: file, wrapped: false }
    }
    case 'dart': {
      // Native JSON on stdout (like go -json), no report file. Flutter uses
      // --machine; pure Dart uses --reporter=json. Inject if absent.
      if (/\bflutter\b/.test(command)) {
        return {
          command: /--machine\b/.test(command) ? command : `${command} --machine`,
          wrapped: false,
        }
      }
      return {
        command: /--reporter[= ]/.test(command) ? command : `${command} --reporter=json`,
        wrapped: false,
      }
    }
    case 'ctest': {
      const file = tmpReport('xml')
      return { command: `${command} --output-junit ${file}`, reportFile: file, wrapped: false }
    }
    case 'catch2': {
      const file = tmpReport('xml')
      return { command: `${command} -r junit -o ${file}`, reportFile: file, wrapped: false }
    }
    case 'doctest': {
      const file = tmpReport('xml')
      return { command: `${command} --reporters=junit --out=${file}`, reportFile: file, wrapped: false }
    }
    case 'playwright': {
      // The junit reporter prints to stdout unless this env var points at a file.
      const file = tmpReport('xml')
      const cmd = /--reporter[= ]/.test(command) ? command : `${command} --reporter=junit`
      return {
        command: `PLAYWRIGHT_JUNIT_OUTPUT_NAME=${file} ${cmd}`,
        reportFile: file,
        wrapped: false,
      }
    }
    case 'go': {
      // -json streams structured events on stdout (no file needed).
      return command.includes('-json')
        ? { command, wrapped: false }
        : { command: command.replace(/\bgo\s+test\b/, 'go test -json'), wrapped: false }
    }
    case 'maven':
      return { command, reportDir: 'target/surefire-reports', wrapped: false }
    case 'gradle':
      return { command, reportDir: 'build/test-results/test', wrapped: false }
    default:
      // jest, rspec, dotnet, cargo, nextest, node-test, mocha, elixir, minitest,
      // unknown → no injectable built-in reporter → text/native parser.
      return { command, wrapped: false }
  }
}
