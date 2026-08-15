/**
 * Validates each filter spec against its captured raw sample.
 *
 * Run with: bun run docs/archive/discovery/bash-output-filter/validation/validate.ts
 *
 * For each (sample, filter), reports:
 *   - rawBytes
 *   - filteredBytes
 *   - reductionPct (actual)
 *   - predictedReductionPct (from .md spec)
 *   - delta (predicted vs actual)
 *   - applied stages
 *   - issues (regex didn't match anything, output empty unexpectedly, etc.)
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applyFilter,
  matchesCommand,
  maybeRewrite,
  type FilterSpec,
} from './pipeline.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
// The sample corpus lives in the source tree — this directory used to hold a
// second, drifting copy. See src/outputFilter/Bash/__fixtures__/samples/README.md.
const SAMPLES = join(
  __dirname,
  '../../../../../src/outputFilter/Bash/__fixtures__/samples',
)

interface TestCase {
  name: string
  command: string
  sampleFile: string
  filter: FilterSpec
  predictedReductionPct: number
  notes?: string
}

const CASES: TestCase[] = [
  // ============================================================
  // git family
  // ============================================================
  {
    name: 'git-status (clean state)',
    command: 'git status',
    sampleFile: 'git-status.txt',
    predictedReductionPct: 26,
    notes: 'Sample atual é 283 bytes (state evoluiu) vs 574 da medição original. Predição reduzida proporcional.',
    filter: {
      name: 'git-status',
      matchCommand: /^git(\s+-[^\s]+)*\s+status\b/,
      matchCommandReject: /--porcelain|--short|-s\b|--json/,
      stripAnsi: true,
      stripLinesMatching: [/^\s*\(use "git /, /^\s*$/],
      replace: [
        { pattern: /^Changes to be committed:$/, replacement: '[STAGED]' },
        { pattern: /^Changes not staged for commit:$/, replacement: '[MODIFIED]' },
        { pattern: /^Untracked files:$/, replacement: '[UNTRACKED]' },
        { pattern: /^\s+modified:\s+/, replacement: '  M ' },
        { pattern: /^\s+new file:\s+/, replacement: '  A ' },
        { pattern: /^\s+deleted:\s+/, replacement: '  D ' },
      ],
      matchOutput: [
        {
          pattern: /nothing to commit, working tree clean/,
          message: '✓ clean working tree',
          unless: /Unmerged|conflict/,
        },
      ],
    },
  },
  {
    name: 'git-log (default — Opção B declarativa)',
    command: 'git log -10',
    sampleFile: 'git-log-default.txt',
    predictedReductionPct: 42,
    notes: 'Opção A (force --oneline) NÃO testável em pipeline (rewrite-command). Esta é Opção B real: ~42%. Os 92% reportados antes só com command rewrite.',
    filter: {
      name: 'git-log',
      matchCommand: /^git(\s+-[^\s]+)*\s+log\b/,
      matchCommandReject: /--oneline|--format=|--pretty=/,
      stripAnsi: true,
      stripLinesMatching: [
        /^\s*Reviewed-on:/,
        /^\s*Co-authored-by:/,
        /^\s*Co-committed-by:/,
        /^\s*Signed-off-by:/,
        /^\s+##\s+(Summary|Impact|Testing|Notes)\s*$/,
        /^\s+-\s+(what changed|why it changed|user-facing impact|developer\/maintainer impact|provider\/model path tested|screenshots attached|follow-up work)/,
        /^\s+-\s+\[\s\]\s+`bun run/,
        /^\s+-\s+focused tests:\s*$/,
        /^Author: .*release-bot/,
        /^\s*$/,
      ],
      replace: [
        { pattern: /^commit ([0-9a-f]{7})[0-9a-f]{33}$/, replacement: 'commit $1' },
        { pattern: /^Author: ([^<]+)<[^>]+>$/, replacement: 'by $1' },
        { pattern: /^Date:\s+.*$/, replacement: '' },
      ],
    },
  },
  {
    name: 'git-log (oneline) — passthrough',
    command: 'git log -10 --oneline',
    sampleFile: 'git-log-oneline.txt',
    predictedReductionPct: 0,
    filter: {
      name: 'git-log',
      matchCommand: /^git(\s+-[^\s]+)*\s+log\b/,
      matchCommandReject: /--oneline|--format=|--pretty=/,
    },
  },
  {
    name: 'git-diff (empty / no changes)',
    command: 'git diff',
    sampleFile: 'git-diff.txt',
    predictedReductionPct: 0,
    notes: 'Sample is empty — passthrough',
    filter: {
      name: 'git-diff',
      matchCommand: /^git(\s+-[^\s]+)*\s+diff\b/,
      matchCommandReject: /--stat|--numstat|--shortstat|--name-only|--name-status/,
      stripAnsi: true,
      stripLinesMatching: [/^index [0-9a-f]+\.\.[0-9a-f]+\s+\d+$/],
    },
  },
  {
    name: 'git-add (--dry-run)',
    command: 'git add --dry-run docs/',
    sampleFile: 'git-add-dryrun.txt',
    predictedReductionPct: 0,
    notes: 'Below maxLines threshold, passthrough',
    filter: {
      name: 'git-add',
      matchCommand: /^git(\s+-[^\s]+)*\s+add\b/,
      stripAnsi: true,
      maxLines: 30,
    },
  },
  {
    name: 'git-push (--dry-run = up-to-date)',
    command: 'git push --dry-run',
    sampleFile: 'git-push-dryrun.txt',
    predictedReductionPct: 0,
    filter: {
      name: 'git-push',
      matchCommand: /^git(\s+-[^\s]+)*\s+push\b/,
      matchCommandReject: /--dry-run/,
      stripAnsi: true,
    },
  },

  // ============================================================
  // file system
  // ============================================================
  {
    name: 'ls -la',
    command: 'ls -la',
    sampleFile: 'ls-la.txt',
    predictedReductionPct: 87,
    notes: 'Spec recomenda native parser; aqui testamos só pipeline declarativo simples (não atinge 87%)',
    filter: {
      name: 'ls-la',
      matchCommand: /^ls(\s|$)/,
      stripAnsi: true,
      stripLinesMatching: [/^total \d+$/, /^\s*$/],
      replace: [
        { pattern: /^[\-dl][rwx\-]{9}[@+]?\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\w+\s+\d+\s+(?:\d+:\d+|\d{4})\s+/, replacement: '' },
      ],
    },
  },
  {
    name: 'ls (plain)',
    command: 'ls',
    sampleFile: 'ls-plain.txt',
    predictedReductionPct: 0,
    filter: {
      name: 'ls',
      matchCommand: /^ls(\s|$)/,
    },
  },
  {
    name: 'find (user-filtered)',
    command: 'find . -maxdepth 2 -type f',
    sampleFile: 'find.txt',
    predictedReductionPct: 0,
    filter: {
      name: 'find',
      matchCommand: /^find(\s|$)/,
      stripLinesMatching: [/^find: '.*': Permission denied$/],
      maxLines: 500,
    },
  },

  // ============================================================
  // search
  // ============================================================
  {
    name: 'grep -rn (paths absolutos)',
    command: 'grep -rn "isAbortError" /home/dev/projects/claudin/src',
    sampleFile: 'grep.txt',
    predictedReductionPct: 20,
    filter: {
      name: 'grep-rg',
      matchCommand: /^(grep|rg|ag|ack)\b/,
      stripAnsi: true,
      stripLinesMatching: [/^grep: .*: Permission denied$/],
      replace: [
        // Match leading absolute path with 4+ segments, keep only last 3 + filename
        { pattern: /^\/(?:[^/:]+\/){3,}([^/:]+\/[^/:]+\/[^:]+):/, replacement: '$1:' },
      ],
      maxLines: 200,
    },
  },
  {
    name: 'rg (com path absoluto — finding inesperado)',
    command: 'rg "isAbortError" /home/dev/projects/claudin/src',
    sampleFile: 'rg.txt',
    predictedReductionPct: 34,
    notes: 'Quando user passa path absoluto, rg também emite paths absolutos — filter strip funciona (~34%).',
    filter: {
      name: 'grep-rg',
      matchCommand: /^(grep|rg|ag|ack)\b/,
      stripAnsi: true,
      stripLinesMatching: [/^rg: .*: IO error$/],
      replace: [
        { pattern: /^\/(?:[^/:]+\/){3,}([^/:]+\/[^/:]+\/[^:]+):/, replacement: '$1:' },
      ],
      maxLines: 200,
    },
  },
  {
    name: 'rg (path relativo — caso compacto)',
    command: 'rg "isAbortError" src --type ts',
    sampleFile: 'rg-relative.txt',
    predictedReductionPct: 0,
    notes: 'Confirma "rg compacto by design" quando user passa path relativo — filter dá 0%.',
    filter: {
      name: 'grep-rg',
      matchCommand: /^(grep|rg|ag|ack)\b/,
      stripAnsi: true,
      stripLinesMatching: [/^rg: .*: IO error$/],
      replace: [
        { pattern: /^\/(?:[^/:]+\/){3,}([^/:]+\/[^/:]+\/[^:]+):/, replacement: '$1:' },
      ],
      maxLines: 200,
    },
  },

  // ============================================================
  // build / test
  // ============================================================
  {
    name: 'cargo build (warm cache, com warnings)',
    command: 'cargo build',
    sampleFile: 'cargo-build.txt',
    predictedReductionPct: 60,
    filter: {
      name: 'cargo-build',
      matchCommand: /^cargo\s+(build|check|run)\b/,
      matchCommandReject: /--message-format=json|--quiet|-q\b/,
      stripAnsi: true,
      stripLinesMatching: [
        /^\s*Compiling\s\S+\sv\d+\.\d+\.\d+\s*$/,
        /^\s*Checking\s\S+\sv\d+\.\d+\.\d+\s*$/,
        /^\s*Updating\s/,
        /^\s*Downloading\s/,
        /^\s*Downloaded\s/,
        /^\s*Blocking waiting for file lock/,
      ],
      matchOutput: [
        {
          pattern: /^\s*Finished\s.*\sin\s\d/m,
          message: '✓ cargo build successful',
          unless: /\b(warning|error)\b/i,
        },
      ],
    },
  },
  {
    name: 'cargo build + dedup (mesmos warning headers repetidos)',
    command: 'cargo build',
    sampleFile: 'cargo-build.txt',
    predictedReductionPct: 67,
    notes: 'Sample tem warning header `direct cast of function item into an integer` 9× — dedup adiciona ~7-12pp acima do base 55%',
    filter: {
      name: 'cargo-build-dedup',
      matchCommand: /^cargo\s+(build|check|run)\b/,
      stripAnsi: true,
      stripLinesMatching: [
        /^\s*Compiling\s\S+\sv\d+\.\d+\.\d+\s*$/,
        /^\s*Checking\s\S+\sv\d+\.\d+\.\d+\s*$/,
        /^\s*Updating\s/,
        /^\s*Downloading\s/,
        /^\s*Downloaded\s/,
      ],
      collapseRuns: true,
      dedupGlobal: true,
    },
  },
  {
    name: 'ps aux + dedup (kthreads quase idênticos)',
    command: 'ps aux',
    sampleFile: 'ps-aux.txt',
    predictedReductionPct: 95,
    notes: 'kthreads têm template variando só por PID — collapseDigitTemplates deve acabar com a maior parte',
    filter: {
      name: 'ps-dedup',
      matchCommand: /^ps(\s|$)/,
      stripLinesMatching: [/\s\[[^\]]+\]\s*$/],
      collapseDigitTemplates: { minRun: 3 },
      truncateLineAt: 200,
      maxLines: 50,
    },
  },
  {
    name: 'cargo check (cold cache)',
    command: 'cargo check',
    sampleFile: 'cargo-check.txt',
    predictedReductionPct: 62,
    filter: {
      name: 'cargo-build',
      matchCommand: /^cargo\s+(build|check|run)\b/,
      stripAnsi: true,
      stripLinesMatching: [
        /^\s*Compiling\s\S+\sv\d+\.\d+\.\d+\s*$/,
        /^\s*Checking\s\S+\sv\d+\.\d+\.\d+\s*$/,
        /^\s*Updating\s/,
        /^\s*Downloading\s/,
        /^\s*Downloaded\s/,
      ],
      matchOutput: [
        {
          pattern: /^\s*Finished\s.*\sin\s\d/m,
          message: '✓ cargo check successful',
          unless: /\b(warning|error)\b/i,
        },
      ],
    },
  },
  {
    name: 'cargo test --no-run',
    command: 'cargo test --no-run',
    sampleFile: 'cargo-test-norun.txt',
    predictedReductionPct: 0,
    notes: 'Sample tem só 1 Compiling line do crate principal (com path entre parênteses) — exceção que filter respeita CORRETAMENTE. Predição revisada: 0%.',
    filter: {
      name: 'cargo-build',
      matchCommand: /^cargo\s+(build|check|run|test)\b/,
      stripAnsi: true,
      stripLinesMatching: [
        /^\s*Compiling\s\S+\sv\d+\.\d+\.\d+\s*$/,
        /^\s*Checking\s/,
        /^\s*Updating\s/,
        /^\s*Downloading\s/,
        /^\s*Downloaded\s/,
        /^\s*Blocking waiting/,
      ],
    },
  },
  {
    name: 'tsc --noEmit (truncated 50KB)',
    command: 'bun run typecheck',
    sampleFile: 'tsc-truncated-50k.txt',
    predictedReductionPct: 1,
    notes: 'Sample tem só 4 ocorrências de hint em 50KB → ~0.6% redução. Predição revisada de 15% (era do output completo) pra 1%. Confirma: tsc precisa de strategy nova, não filter.',
    filter: {
      name: 'tsc',
      matchCommand: /^(tsc|npx\s+tsc|bun\s+(?:run\s+)?typecheck)\b/,
      stripAnsi: true,
      stripLinesMatching: [/^\$\s+tsc\s+--noEmit\s*$/],
      replace: [
        {
          pattern: /\. Do you need to change your target library\? Try changing the 'lib' compiler option to 'es\d+' or later\./g,
          replacement: '.',
        },
        { pattern: /\. Did you mean '\w+'\?/g, replacement: '.' },
      ],
    },
  },

  // ============================================================
  // package managers
  // ============================================================
  {
    name: 'bun install (no changes)',
    command: 'bun install',
    sampleFile: 'bun-install.txt',
    predictedReductionPct: 0,
    notes: 'bun install excluído do conjunto built-in (já compacto)',
    filter: {
      name: 'bun-install-NOOP',
      matchCommand: /^bun\s+install\b/,
    },
  },
  {
    name: 'npm ls --depth=0',
    command: 'npm ls --depth=0',
    sampleFile: 'npm-ls.txt',
    predictedReductionPct: 0,
    notes: 'Não temos filter dedicado; testando passthrough',
    filter: {
      name: 'npm-ls-NOOP',
      matchCommand: /^npm\s+ls\b/,
    },
  },

  // ============================================================
  // containers
  // ============================================================
  {
    name: 'docker ps -a',
    command: 'docker ps -a',
    sampleFile: 'docker-ps.txt',
    predictedReductionPct: 30,
    filter: {
      name: 'docker-ps',
      matchCommand: /^docker(\s+-[^\s]+)*\s+ps\b/,
      matchCommandReject: /--format|--quiet|-q\b|--no-trunc/,
      stripAnsi: true,
      replace: [
        { pattern: /^[0-9a-f]{12}\s+/, replacement: '' },
        { pattern: /^CONTAINER ID\s+/, replacement: '' },
        { pattern: /\s+\d+\s+(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago\b/g, replacement: '' },
        { pattern: /, \[::\]:\d+->\d+\/(?:tcp|udp)/g, replacement: '' },
      ],
      truncateLineAt: 200,
    },
  },

  // ============================================================
  // system
  // ============================================================
  {
    name: 'ps aux',
    command: 'ps aux',
    sampleFile: 'ps-aux.txt',
    predictedReductionPct: 87,
    filter: {
      name: 'ps',
      matchCommand: /^ps(\s|$)/,
      matchCommandReject: /--format|-o\s|--no-headers/,
      stripLinesMatching: [/\s\[[^\]]+\]\s*$/],
      truncateLineAt: 200,
      maxLines: 50,
    },
  },
  {
    name: 'journalctl -u systemd-logind',
    command: 'journalctl --no-pager -n 20 -u systemd-logind',
    sampleFile: 'journalctl.txt',
    predictedReductionPct: 41,
    filter: {
      name: 'journalctl',
      matchCommand: /^(sudo\s+)?journalctl\b/,
      matchCommandReject: /--output=json|--output=cat|-o\s+(json|cat|export)/,
      replace: [
        { pattern: /^(\w{3} \d\d \d\d:\d\d:\d\d) \S+ /, replacement: '$1 ' },
        { pattern: /^(\w{3} \d\d \d\d:\d\d:\d\d) \S+\[\d+\]:\s/, replacement: '$1 ' },
      ],
      stripLinesMatching: [/^-- No entries --$/],
    },
  },
  {
    name: 'df -h',
    command: 'df -h',
    sampleFile: 'df.txt',
    predictedReductionPct: 0,
    notes: 'Zero-ROI documentado',
    filter: {
      name: 'df-NOOP',
      matchCommand: /^df\b/,
    },
  },
  {
    name: 'du -h --max-depth=1',
    command: 'du -h --max-depth=1',
    sampleFile: 'du.txt',
    predictedReductionPct: 0,
    notes: 'Zero-ROI documentado',
    filter: {
      name: 'du-NOOP',
      matchCommand: /^du\b/,
    },
  },
  // ============================================================
  // novos comandos (rodada 2)
  // ============================================================
  {
    name: 'docker logs (postgres tail 50)',
    command: 'docker logs aargau-postgres --tail 50',
    sampleFile: 'docker-logs.txt',
    predictedReductionPct: 19,
    notes: 'Predição revisada: 41/51 linhas casam regex (~80% das linhas), cada match economiza ~27 chars de prefixo. Linhas não-temporais (PostgreSQL banner, LSN data) preservam conteúdo.',
    filter: {
      name: 'docker-logs',
      matchCommand: /^docker(\s+-[^\s]+)*\s+logs\b/,
      matchCommandReject: /-f\b|--follow|--timestamps=false/,
      stripAnsi: true,
      replace: [
        { pattern: /^\d{4}-\d{2}-\d{2}\s+(\d{2}:\d{2}:\d{2})\.\d+\s+UTC\s+\[\d+\]\s+/gm, replacement: '$1 ' },
        { pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s+/gm, replacement: '' },
      ],
      maxLines: 200,
    },
  },
  {
    name: 'docker images',
    command: 'docker images',
    sampleFile: 'docker-images.txt',
    predictedReductionPct: 35,
    filter: {
      name: 'docker-images',
      matchCommand: /^docker(\s+-[^\s]+)*\s+images\b/,
      matchCommandReject: /--format|--quiet|-q\b/,
      stripAnsi: true,
      stripLinesMatching: [
        /^WARNING: This output is designed for human readability/,
      ],
      replace: [
        { pattern: /\b[0-9a-f]{12}\s+/g, replacement: '' },
      ],
      maxLines: 50,
    },
  },
  {
    name: 'curl -v (TLS noise dominates)',
    command: 'curl -v https://httpbin.org/get',
    sampleFile: 'curl-v.txt',
    predictedReductionPct: 54,
    notes: 'Predição revisada: 27/51 linhas strip (TLS=9, SSL=3, bytes=12, IPv=2, Trying=1). Outras linhas (Server cert, headers) são sinal preservado.',
    filter: {
      name: 'curl',
      matchCommand: /^curl\b/,
      matchCommandReject: /-s\b|--silent|-I\b|--head/,
      stripAnsi: true,
      stripLinesMatching: [
        /^\*\s+TLS/,
        /^\*\s+SSL/,
        /^[}{]\s+\[\d+\s+bytes\s+data\]\s*$/,
        /^\*\s+IPv[46]:/,
        /^\*\s+Trying\s/,
        /^\*\s+ALPN:/,
        /^\*\s+Connection #/,
        /^\*\s+CAfile:/,
        /^\*\s+CApath:/,
        /^\*\s+Host\s.*was\s+resolved\./,
      ],
      maxLines: 100,
    },
  },
  {
    name: 'top -bn1',
    command: 'top -bn1',
    sampleFile: 'top-bn1.txt',
    predictedReductionPct: 52,
    notes: 'Filter corrigido: top NÃO usa [brackets] como ps aux — kernel threads em top têm VIRT=0 RES=0 SHR=0. Predição revisada de 30% (estimativa intuitiva) pra 52% medido — kernel threads dominam mais do que esperado.',
    filter: {
      name: 'top',
      matchCommand: /^top\b/,
      matchCommandReject: /-H\b/,
      // kernel threads: PID USER PR NI VIRT=0 RES=0 SHR=0 ...
      stripLinesMatching: [
        /^\s*\d+\s+\S+\s+\d+\s+-?\d+\s+0\s+0\s+0\s+/,
      ],
      truncateLineAt: 200,
      maxLines: 40,
    },
  },
  {
    name: 'ss -tln (already minimal)',
    command: 'ss -tln',
    sampleFile: 'ss-tln.txt',
    predictedReductionPct: 0,
    notes: 'Output já compacto, passthrough',
    filter: {
      name: 'ss-NOOP',
      matchCommand: /^ss\b/,
    },
  },
  {
    name: 'tail (pacman log)',
    command: 'tail -n 30 /var/log/pacman.log',
    sampleFile: 'tail-log.txt',
    predictedReductionPct: 0,
    notes: 'Tail é passthrough — file content é signal puro',
    filter: {
      name: 'cat-NOOP',
      matchCommand: /^(cat|head|tail|less)\s/,
    },
  },

  // ============================================================
  // Dedup tests — collapseRuns / collapseDigitTemplates / dedupGlobal
  // ============================================================
  {
    name: 'dedup: connection retry alternating (collapseRuns NÃO funciona)',
    command: './my-app',
    sampleFile: 'synthetic-runs.txt',
    predictedReductionPct: 0,
    notes: '12 linhas alternando "Connecting" + "Connection failed" — collapseRuns só casa CONSECUTIVOS idênticos. Cada linha "Connecting..." é seguida de "Connection failed" diferente, então nada colapsa. Isso documenta a limitação: cycle detection seria v2 feature.',
    filter: {
      name: 'app-output',
      matchCommand: /^\S/,
      collapseRuns: true,
    },
  },
  {
    name: 'dedup: connection retry alternating (dedupGlobal resolve)',
    command: './my-app',
    sampleFile: 'synthetic-runs.txt',
    predictedReductionPct: 70,
    notes: 'Mesmo sample mas com dedupGlobal — só 3 linhas únicas (Connecting, Failed, Giving up) entre 13 = grande win.',
    filter: {
      name: 'app-output',
      matchCommand: /^\S/,
      dedupGlobal: true,
    },
  },
  {
    name: 'dedup: progress bar (collapseDigitTemplates)',
    command: 'npm run build',
    sampleFile: 'synthetic-progress.txt',
    predictedReductionPct: 77,
    notes: '11 linhas "Progress: N% (N/100)" — todas mesma template, devem colapsar pra 1 sample + count',
    filter: {
      name: 'app-output',
      matchCommand: /^\S/,
      collapseDigitTemplates: true,
    },
  },
  {
    name: 'dedup: progress bar (collapseRuns NÃO suficiente)',
    command: 'npm run build',
    sampleFile: 'synthetic-progress.txt',
    predictedReductionPct: 0,
    notes: 'collapseRuns não casa porque cada linha tem dígito diferente — confirma necessidade de collapseDigitTemplates',
    filter: {
      name: 'app-output',
      matchCommand: /^\S/,
      collapseRuns: true,
    },
  },
  {
    name: 'dedup: cargo warnings repetidos (dedupGlobal)',
    command: 'cargo build',
    sampleFile: 'synthetic-cargo-warnings.txt',
    predictedReductionPct: 0,
    notes: 'Warnings com mesma message MAS linhas diferentes (line 2231 vs 2232 vs 2245) — collapseRuns/Templates não cobre porque source pointer varia. dedupGlobal removeria warning header repetido — mas warnings consecutivos no formato cargo NÃO casam exatamente. Testando como baseline.',
    filter: {
      name: 'app-output',
      matchCommand: /^\S/,
      collapseRuns: true,
      collapseDigitTemplates: true,
    },
  },
  {
    name: 'dedup: cargo warning header repetido (dedupGlobal real)',
    command: 'cargo build',
    sampleFile: 'synthetic-cargo-warnings.txt',
    predictedReductionPct: 30,
    notes: 'dedupGlobal collapses "warning: direct cast..." header (4×) pra 1× + marker. Trade-off: perde correlação de qual warning veio de qual line.',
    filter: {
      name: 'app-output',
      matchCommand: /^\S/,
      dedupGlobal: true,
    },
  },

  // ============================================================
  // Rodada 4: comandos novos com samples capturados
  // ============================================================
  {
    name: 'dig (DNS query)',
    command: 'dig httpbin.org',
    sampleFile: 'dig.txt',
    predictedReductionPct: 50,
    notes: 'dig output tem LOTS de comments (`;`, `;;`) — strip dos metadados, keep ANSWER section.',
    filter: {
      name: 'dig',
      matchCommand: /^dig\b/,
      stripAnsi: true,
      stripLinesMatching: [
        /^;[^;]/,           // single-semicolon comments (sem header `;;`)
        /^$/,                // empty lines
        /^;;\s+(global options|Got answer|->>HEADER|flags:|OPT PSEUDOSECTION|EDNS:|COOKIE:|QUESTION SECTION:)/,
      ],
    },
  },
  {
    name: 'git blame (author + date dominam)',
    command: 'git blame README.md',
    sampleFile: 'git-blame.txt',
    predictedReductionPct: 30,
    notes: 'Cada linha tem `^hash (Author YYYY-MM-DD HH:MM:SS TZ N)` ~50 chars de meta antes do conteúdo. Strip TZ + author email, keep date curto.',
    filter: {
      name: 'git-blame',
      matchCommand: /^git(\s+-[^\s]+)*\s+blame\b/,
      stripAnsi: true,
      replace: [
        // ^hash (Name LongName YYYY-MM-DD HH:MM:SS +TZ N) → ^hash YYYY-MM-DD N)
        // Hash pode ser 7 chars (boundary commit com `^` prefix) ou 8 chars
        { pattern: /(\^?[0-9a-f]{7,8})\s+\([^)]+?(\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}:\d{2}\s+[+\-]\d{4}\s+(\d+)\)/g, replacement: '$1 $2 $3)' },
      ],
    },
  },
  {
    name: 'git branch -a (já compacto)',
    command: 'git branch -a',
    sampleFile: 'git-branch-a.txt',
    predictedReductionPct: 0,
    notes: 'Output já compacto (1 branch por linha). Passthrough.',
    filter: {
      name: 'git-branch',
      matchCommand: /^git(\s+-[^\s]+)*\s+branch\b/,
      stripAnsi: true,
    },
  },
  {
    name: 'git show HEAD --stat',
    command: 'git show HEAD --stat',
    sampleFile: 'git-show.txt',
    predictedReductionPct: 5,
    notes: 'git show é como git log + diff combinado. Stat output já compacto. Apenas autor email pra strip.',
    filter: {
      name: 'git-show',
      matchCommand: /^git(\s+-[^\s]+)*\s+show\b/,
      stripAnsi: true,
      replace: [
        { pattern: /^Author: ([^<]+) <[^>]+>$/m, replacement: 'Author: $1' },
      ],
    },
  },
  {
    name: 'pytest (clean — todos passam)',
    command: 'pytest /tmp/clean-tests -v',
    sampleFile: 'pytest-clean.txt',
    predictedReductionPct: 90,
    notes: 'match_output pra "X passed in Ys" colapsa pra mensagem única — 90%+ confirmado pelo summarizer existente do claudio.',
    filter: {
      name: 'pytest',
      matchCommand: /^(pytest|python\s+-m\s+pytest)\b/,
      stripAnsi: true,
      stripLinesMatching: [
        /^=+ warnings summary =+$/,
        /^PytestDeprecationWarning/,
      ],
      matchOutput: [
        {
          pattern: /^=+ \d+ passed in [\d.]+s =+$/m,
          message: '✓ pytest: all tests passed',
          unless: /\b(failed|error)\b/i,
        },
      ],
      maxLines: 100,
    },
  },
  {
    name: 'ruff check (errors no projeto python)',
    command: 'ruff check python/',
    sampleFile: 'ruff.txt',
    predictedReductionPct: 0,
    notes: 'Ruff já é compacto by design — formato `code [*] msg \\n  --> path:line:col`. Pouco a strippar.',
    filter: {
      name: 'ruff',
      matchCommand: /^ruff\s+(check|format)\b/,
      stripAnsi: true,
      matchOutput: [
        {
          pattern: /^All checks passed!$/m,
          message: '✓ ruff: all clean',
          unless: /\berror\b/i,
        },
      ],
    },
  },
  {
    name: 'ruff check (clean — match_output)',
    command: 'ruff check /tmp/clean-py',
    sampleFile: 'ruff-clean.txt',
    predictedReductionPct: 0,
    notes: 'Já 21 bytes ("All checks passed!"). Match_output usaria ~22 bytes ("✓ ruff: all clean"). Sem ganho real.',
    filter: {
      name: 'ruff',
      matchCommand: /^ruff\s+(check|format)\b/,
      stripAnsi: true,
      matchOutput: [
        {
          pattern: /^All checks passed!$/m,
          message: '✓ ruff: all clean',
          unless: /\berror\b/i,
        },
      ],
    },
  },
  {
    name: 'bun test (já compacto)',
    command: 'bun test ./src/shared/text/truncate.test.ts',
    sampleFile: 'bun-test.txt',
    predictedReductionPct: 0,
    notes: '100 bytes pra 3 testes — bun test é minimal by design. Passthrough confirma análise prévia.',
    filter: {
      name: 'bun-test-NOOP',
      matchCommand: /^bun\s+test\b/,
    },
  },
  {
    name: 'jq pretty-print (já compacto)',
    command: 'jq . input.json',
    sampleFile: 'jq-pretty.txt',
    predictedReductionPct: 0,
    notes: 'jq output é JSON formatado — 100% sinal.',
    filter: {
      name: 'jq-NOOP',
      matchCommand: /^jq\b/,
    },
  },

  // ============================================================
  // Rodada 5: completar família git
  // ============================================================
  {
    name: 'git tag --list',
    command: 'git tag --list',
    sampleFile: 'git-tag-list.txt',
    predictedReductionPct: 0,
    notes: '71 bytes (10 tags). Já compacto (1 tag/linha). Passthrough.',
    filter: {
      name: 'git-tag',
      matchCommand: /^git(\s+-[^\s]+)*\s+tag\b/,
      stripAnsi: true,
    },
  },
  {
    name: 'git remote -v',
    command: 'git remote -v',
    sampleFile: 'git-remote-v.txt',
    predictedReductionPct: 0,
    notes: '131 bytes. Já compacto (2 linhas: fetch + push). Passthrough.',
    filter: {
      name: 'git-remote',
      matchCommand: /^git(\s+-[^\s]+)*\s+remote\b/,
      stripAnsi: true,
    },
  },
  {
    name: 'git worktree list',
    command: 'git worktree list',
    sampleFile: 'git-worktree-list.txt',
    predictedReductionPct: 0,
    notes: '197 bytes (2 worktrees). Já compacto.',
    filter: {
      name: 'git-worktree',
      matchCommand: /^git(\s+-[^\s]+)*\s+worktree\b/,
      stripAnsi: true,
    },
  },
  {
    name: 'git config --list',
    command: 'git config --list',
    sampleFile: 'git-config-list.txt',
    predictedReductionPct: 0,
    notes: '3382 bytes — `key=value` por linha, todas pertencentes ao user. Filtro arriscaria perder config relevante. Passthrough.',
    filter: {
      name: 'git-config',
      matchCommand: /^git(\s+-[^\s]+)*\s+config\b/,
      stripAnsi: true,
    },
  },
  {
    name: 'git reflog',
    command: 'git reflog',
    sampleFile: 'git-reflog.txt',
    predictedReductionPct: 0,
    notes: 'Output formato `hash HEAD@{N}: action: message` — já compacto. Cada linha é coordenada única.',
    filter: {
      name: 'git-reflog',
      matchCommand: /^git(\s+-[^\s]+)*\s+reflog\b/,
      stripAnsi: true,
    },
  },
  {
    name: 'git show HEAD (full com diff)',
    command: 'git show HEAD',
    sampleFile: 'git-show-full.txt',
    predictedReductionPct: 5,
    notes: '9946 bytes — git show é git log + git diff combinado. Strip de Author email + index hashes do diff dá ~5%.',
    filter: {
      name: 'git-show',
      matchCommand: /^git(\s+-[^\s]+)*\s+show\b/,
      stripAnsi: true,
      replace: [
        { pattern: /^Author: ([^<]+) <[^>]+>$/m, replacement: 'Author: $1' },
      ],
      stripLinesMatching: [
        /^index [0-9a-f]+\.\.[0-9a-f]+\s+\d+$/,
      ],
    },
  },
  {
    name: 'git fetch --dry-run',
    command: 'git fetch --dry-run',
    sampleFile: 'git-fetch-dryrun.txt',
    predictedReductionPct: 0,
    notes: '0 bytes (no fetch needed). Passthrough.',
    filter: {
      name: 'git-fetch',
      matchCommand: /^git(\s+-[^\s]+)*\s+fetch\b/,
      stripAnsi: true,
    },
  },
  {
    name: 'git clean -nd (dry run)',
    command: 'git clean -nd',
    sampleFile: 'git-clean-dryrun.txt',
    predictedReductionPct: 0,
    notes: '101 bytes — lista de "Would remove ..." paths. Já compacto.',
    filter: {
      name: 'git-clean',
      matchCommand: /^git(\s+-[^\s]+)*\s+clean\b/,
      stripAnsi: true,
    },
  },
  // ============================================================
  // Rodada 6: gap audit vs rtk
  // ============================================================
  {
    name: 'wget',
    command: 'wget https://httpbin.org/get -O /tmp/dump.json',
    sampleFile: 'wget.txt',
    predictedReductionPct: 72,
    notes: 'wget tem progress bar inline + Resolving/Connecting/HTTP linhas separadas. Strip de TODAS gera ~72% — ficou só "Length:" e linha final "saved [N/N]".',
    filter: {
      name: 'wget',
      matchCommand: /^wget\b/,
      stripAnsi: true,
      stripLinesMatching: [
        /^Loaded CA certificate/,
        /^Resolving\s/,
        /^Connecting\s/,
        /^HTTP request sent,/,
        /^Saving to:/,
        /^\s*\d+K\s+/,
        /^\s*$/,
      ],
    },
  },
  {
    name: 'pip list',
    command: 'pip list',
    sampleFile: 'pip-list.txt',
    predictedReductionPct: 0,
    notes: '4223 bytes para ~150 pacotes. Formato `Package    Version` — já compacto, 1 linha por package. Passthrough.',
    filter: {
      name: 'pip-list',
      matchCommand: /^pip\s+list\b/,
    },
  },
  {
    name: 'pip list --outdated',
    command: 'pip list --outdated',
    sampleFile: 'pip-outdated.txt',
    predictedReductionPct: 0,
    notes: '1180 bytes truncado a head -20. Formato similar a pip list mas com 4 colunas (Package Version Latest Type). Passthrough.',
    filter: {
      name: 'pip-outdated',
      matchCommand: /^pip\s+list\b.*--outdated/,
    },
  },
  {
    name: 'env (filtered grep)',
    command: 'env | grep -i path',
    sampleFile: 'env-filtered.txt',
    predictedReductionPct: 0,
    notes: '1350 bytes — env var values são content. Passthrough confirmado.',
    filter: {
      name: 'env-NOOP',
      matchCommand: /^env\b/,
    },
  },
  {
    name: 'json structure (small json)',
    command: 'jq . input.json',
    sampleFile: 'json-sample.txt',
    predictedReductionPct: 0,
    notes: 'JSON pretty-print é signal puro. rtk tem `rtk json file.json` que mostra structure-only (keys, no values) — feature DIFERENTE do filter declarativo, exigiria parser JSON dedicado.',
    filter: {
      name: 'jq-NOOP',
      matchCommand: /^jq\b/,
    },
  },
  // ============================================================
  // Rodada 7: gap items do rtk (instalados localmente)
  // ============================================================
  {
    name: 'cargo clippy (rtk repo, 40 warnings)',
    command: 'cargo clippy',
    sampleFile: 'cargo-clippy.txt',
    predictedReductionPct: 0,
    notes: 'CORREÇÃO: 21KB com 40 warnings — só 1 Compiling line (do crate principal, corretamente preservada). 40 warnings × source pointer lines = puro sinal. ROI real ~0%. Confirma análise do `cargo-build`: warnings são sinal, build noise era o ganho.',
    filter: {
      name: 'cargo-clippy',
      matchCommand: /^cargo\s+clippy\b/,
      stripAnsi: true,
      stripLinesMatching: [
        /^\s*Compiling\s\S+\sv\d+\.\d+\.\d+\s*$/,
        /^\s*Checking\s\S+\sv\d+\.\d+\.\d+\s*$/,
      ],
      collapseRuns: true,
    },
  },
  {
    name: 'prettier --check (claudio src/utils/u*)',
    command: "prettier --check 'src/utils/u*.ts'",
    sampleFile: 'prettier-check.txt',
    predictedReductionPct: 0,
    notes: '353 bytes pra ~10 arquivos. 1 linha por arquivo (`[warn] path`) — já compacto. matchOutput "Code style issues" não muda muito.',
    filter: {
      name: 'prettier',
      matchCommand: /^(npx\s+(-y\s+)?)?prettier\s+--check\b/,
      stripAnsi: true,
      stripLinesMatching: [
        /^Checking formatting\.\.\.$/,
      ],
    },
  },
  {
    name: 'rubocop (preamble dominate)',
    command: 'rubocop /tmp/ruby-test/foo.rb',
    sampleFile: 'rubocop.txt',
    predictedReductionPct: 80,
    notes: '11KB com ~165 linhas de "new cops not configured" PREAMBLE + ~30 linhas de lint real. Strip do preamble dá 80%+.',
    filter: {
      name: 'rubocop',
      matchCommand: /^rubocop\b/,
      stripAnsi: true,
      stripLinesMatching: [
        /^The following cops were added/,
        /^Please also note that you can opt-in/,
        /^\s+(AllCops|NewCops):/,
        /^\w+\/\w+:\s+# new in/,
        /^\s+Enabled: true$/,
        /^Please set Enabled to either/,
      ],
    },
  },
  {
    name: 'rspec (clean — todos passam)',
    command: 'rspec foo_spec.rb',
    sampleFile: 'rspec.txt',
    predictedReductionPct: 73,
    notes: '93 bytes pra 2 testes passing. Match_output pra "X examples, 0 failures".',
    filter: {
      name: 'rspec',
      matchCommand: /^rspec\b/,
      stripAnsi: true,
      matchOutput: [
        {
          pattern: /\d+ examples?, 0 failures/,
          message: '✓ rspec: all tests passed',
          unless: /\b(fail|error)\b/i,
        },
      ],
    },
  },
  {
    name: 'bundle install',
    command: 'bundle install',
    sampleFile: 'bundle-install.txt',
    predictedReductionPct: 96,
    notes: '579 bytes — Fetching/Installing por gem. Strip do "Fetching" (já vai instalar) + match_output "Bundle complete".',
    filter: {
      name: 'bundle',
      matchCommand: /^bundle\s+install\b/,
      stripAnsi: true,
      stripLinesMatching: [
        /^Fetching\s/,
      ],
      matchOutput: [
        {
          pattern: /Bundle complete!/,
          message: '✓ bundle install completed',
          unless: /(?:error|conflict)/i,
        },
      ],
    },
  },
  {
    name: 'go test -v (clean — todos passam)',
    command: 'go test -v ./...',
    sampleFile: 'go-test.txt',
    predictedReductionPct: 70,
    notes: '167 bytes pra 3 testes. Strip de === RUN/--- PASS + match_output "ok package".',
    filter: {
      name: 'go-test',
      matchCommand: /^go\s+test\b/,
      matchCommandReject: /-json|--json/,
      stripAnsi: true,
      stripLinesMatching: [
        /^=== (RUN|PAUSE|CONT)\s/,
        /^--- PASS:\s/,
        /^PASS$/,
      ],
      matchOutput: [
        {
          pattern: /^ok\s+\S+\s+[\d.]+s$/m,
          message: '✓ go test: all packages passed',
          unless: /FAIL/,
        },
      ],
    },
  },
  {
    name: 'golangci-lint (1 issue)',
    command: 'golangci-lint run',
    sampleFile: 'golangci-lint.txt',
    predictedReductionPct: 0,
    notes: '165 bytes pra 1 issue — formato `path:line:col: msg (linter)` já é compacto.',
    filter: {
      name: 'golangci-lint',
      matchCommand: /^golangci-lint\b/,
      stripAnsi: true,
    },
  },
  {
    name: 'git pull (synthetic, fast-forward 3 files)',
    command: 'git pull',
    sampleFile: 'git-pull-synthetic.txt',
    predictedReductionPct: 45,
    notes: 'Sample sintético (real pull = 0 bytes pq repo está em sync). Strip de remote: progress + Unpacking. Opção P preserva file list; Opção R colapsaria pra ~94%.',
    filter: {
      name: 'git-pull',
      matchCommand: /^git(\s+-[^\s]+)*\s+pull\b/,
      matchCommandReject: /--dry-run|--no-ff/,
      stripAnsi: true,
      stripLinesMatching: [
        /^remote: Enumerating objects/,
        /^remote: Counting objects/,
        /^remote: Compressing objects/,
        /^remote: Total \d+ \(delta/,
        /^remote: Resolving deltas/,
        /^Unpacking objects/,
      ],
      matchOutput: [
        {
          pattern: /Already up to date\./,
          message: '✓ git pull: already up to date',
          unless: /\b(error|conflict|reject)\b/i,
        },
      ],
    },
  },
]

// ============================================================
// runner
// ============================================================

interface ValidationResult {
  testCase: TestCase
  matchesCommand: boolean
  rawBytes: number
  filteredBytes: number
  reductionPct: number
  delta: number
  applied: string[]
  shortCircuited: boolean
  status: 'ok' | 'mismatch' | 'no-match-command' | 'no-sample'
  diagnostics: string[]
}

function runCase(tc: TestCase): ValidationResult {
  const samplePath = join(SAMPLES, tc.sampleFile)
  let raw: string
  try {
    raw = readFileSync(samplePath, 'utf8')
  } catch {
    return {
      testCase: tc,
      matchesCommand: false,
      rawBytes: 0,
      filteredBytes: 0,
      reductionPct: 0,
      delta: 0,
      applied: [],
      shortCircuited: false,
      status: 'no-sample',
      diagnostics: [`Sample file not found: ${tc.sampleFile}`],
    }
  }

  const matchOk = matchesCommand(tc.filter, tc.command)
  if (!matchOk) {
    // matchCommandReject firing is EXPECTED behavior (e.g. --oneline, --dry-run cases)
    const rejectFired = tc.filter.matchCommandReject?.test(tc.command) ?? false
    const status = rejectFired ? 'ok' : 'no-match-command'
    const diagnostics = rejectFired
      ? [`matchCommandReject correctly fired for "${tc.command}" → passthrough`]
      : [
          `Filter matchCommand=${tc.filter.matchCommand} did not match "${tc.command}"`,
        ]
    return {
      testCase: tc,
      matchesCommand: false,
      rawBytes: raw.length,
      filteredBytes: raw.length,
      reductionPct: 0,
      delta: -tc.predictedReductionPct,
      applied: [],
      shortCircuited: false,
      status,
      diagnostics,
    }
  }

  const result = applyFilter(tc.filter, raw)
  const rawBytes = raw.length
  const filteredBytes = result.body.length
  const reductionPct = rawBytes === 0
    ? 0
    : Math.round(100 * (1 - filteredBytes / rawBytes))
  const delta = reductionPct - tc.predictedReductionPct

  const diagnostics: string[] = []
  // Only flag "regex unused" if sample is non-trivial and filter doesn't short-circuit
  // (some filters are defensive safety nets — that's fine if they don't match)
  if (rawBytes > 200 && !result.shortCircuited) {
    if (tc.filter.stripLinesMatching) {
      const unused = tc.filter.stripLinesMatching.filter(re => !re.test(raw))
      if (unused.length === tc.filter.stripLinesMatching.length && tc.filter.stripLinesMatching.length > 0) {
        diagnostics.push(
          `[info] all ${unused.length} stripLinesMatching regex(es) defensive (didn't match this sample)`,
        )
      }
    }
  }
  if (filteredBytes === 0 && rawBytes > 100) {
    diagnostics.push('[error] Output is empty — possible over-stripping')
  }
  // Real concern: actual reduction far below predicted
  const isRealMiss = Math.abs(delta) > 15 && rawBytes > 200
  if (isRealMiss) {
    diagnostics.push(
      `[error] Reduction delta > 15pp (predicted ${tc.predictedReductionPct}%, actual ${reductionPct}%)`,
    )
  }

  const hasError = diagnostics.some(d => d.startsWith('[error]'))
  const status = hasError ? 'mismatch' : 'ok'

  return {
    testCase: tc,
    matchesCommand: matchOk,
    rawBytes,
    filteredBytes,
    reductionPct,
    delta,
    applied: result.applied,
    shortCircuited: result.shortCircuited ?? false,
    status,
    diagnostics,
  }
}

function buildReport(results: ValidationResult[], safety: SafetyResult[], rewrites: RewriteResult[] = []): string {
  const total = results.length
  const ok = results.filter(r => r.status === 'ok').length
  const mismatch = results.filter(r => r.status === 'mismatch').length
  const noMatch = results.filter(r => r.status === 'no-match-command').length
  const noSample = results.filter(r => r.status === 'no-sample').length

  const safetyPassed = safety.filter(s => s.passed).length

  let md = `# Validation Results

> Generated by \`bun run docs/archive/discovery/bash-output-filter/validation/validate.ts\`
> Date: ${new Date().toISOString().split('T')[0]}

## Summary

- **Pipeline cases:** ${total}
  - **OK:** ${ok}
  - **Mismatch:** ${mismatch}
  - **No match (command not covered):** ${noMatch}
  - **No sample file:** ${noSample}
- **Safety tests:** ${safety.length}
  - **Passed:** ${safetyPassed}
  - **Failed (CRITICAL — filter swallows errors):** ${safety.length - safetyPassed}

## Safety test results

Verifies that \`match_output\` rules don't swallow errors / warnings / conflict markers.

| # | Test | Result | Reason |
|---|---|---|---|
`

  safety.forEach((s, i) => {
    const symbol = s.passed ? '✓ PASS' : '✗ **FAIL**'
    md += `| ${i + 1} | ${s.test.name} | ${symbol} | ${s.reason} |\n`
  })

  if (rewrites.length > 0) {
    md += '\n## Rewrite tests\n\n'
    md += '| # | Test | Fired | Target match | Original → Rewritten bytes | Reduction |\n'
    md += '|---|---|---|---|---|---|\n'
    rewrites.forEach((r, i) => {
      const fired = r.rewriteFired ? '✓' : '✗'
      const target = r.matchesExpected ? '✓' : '✗'
      md += `| ${i + 1} | ${r.test.name} | ${fired} | ${target} | ${r.originalBytes} → ${r.rewrittenBytes} | ${r.reductionPct}% |\n`
    })
  }

  md += '\n## Per-case results\n\n'
  md += '| # | Case | Raw | Filtered | Actual % | Predicted % | Delta | Status |\n'
  md += '|---|---|---|---|---|---|---|---|\n'

  results.forEach((r, i) => {
    const status =
      r.status === 'ok'
        ? '✓ OK'
        : r.status === 'mismatch'
        ? '⚠ MISS'
        : r.status === 'no-match-command'
        ? '✗ no-match'
        : '✗ no-sample'
    md += `| ${i + 1} | ${r.testCase.name} | ${r.rawBytes} | ${r.filteredBytes} | ${r.reductionPct}% | ${r.testCase.predictedReductionPct}% | ${r.delta >= 0 ? '+' : ''}${r.delta}pp | ${status} |\n`
  })

  md += '\n## Detalhes por caso\n\n'

  for (const r of results) {
    md += `### ${r.testCase.name}\n\n`
    md += `- **Command:** \`${r.testCase.command}\`\n`
    md += `- **Sample:** \`${r.testCase.sampleFile}\` (${r.rawBytes} bytes)\n`
    md += `- **Filter:** \`${r.testCase.filter.name}\`\n`
    md += `- **Match command:** ${r.matchesCommand ? '✓' : '✗'}\n`
    md += `- **Reduction:** ${r.rawBytes} → ${r.filteredBytes} bytes (${r.reductionPct}%)\n`
    md += `- **Predicted:** ${r.testCase.predictedReductionPct}% (delta ${r.delta >= 0 ? '+' : ''}${r.delta}pp)\n`
    md += `- **Pipeline applied:** ${r.applied.length > 0 ? r.applied.join(' → ') : '_none_'}\n`
    if (r.shortCircuited) md += `- **Short-circuited:** ✓ (matchOutput rule fired)\n`
    if (r.diagnostics.length > 0) {
      md += `- **Diagnostics:**\n`
      for (const d of r.diagnostics) md += `  - ⚠ ${d}\n`
    }
    if (r.testCase.notes) md += `- **Notes:** ${r.testCase.notes}\n`
    md += '\n'
  }

  return md
}

// ============================================================
// Safety tests — verify `unless` doesn't swallow errors
// ============================================================

interface SafetyTest {
  name: string
  filter: FilterSpec
  inputWithError: string
  errorKeyword: string
}

function findCase(name: string): FilterSpec {
  const tc = CASES.find(c => c.name === name)
  if (!tc) throw new Error(`Case not found: ${name}`)
  return tc.filter
}

const SAFETY_TESTS: SafetyTest[] = [
  {
    name: 'cargo-build: warning preserves output (unless `warning`)',
    inputWithError: '   Compiling foo v1.0.0\nwarning: unused variable\n    Finished `dev` profile in 1s',
    errorKeyword: 'warning: unused variable',
    filter: findCase('cargo build (warm cache, com warnings)'),
  },
  {
    name: 'cargo-build: error preserves output',
    inputWithError: '   Compiling foo v1.0.0\nerror[E0308]: mismatched types\n    Finished\n',
    errorKeyword: 'error[E0308]',
    filter: findCase('cargo build (warm cache, com warnings)'),
  },
  {
    name: 'git-status: Unmerged path NOT collapsed by match_output',
    inputWithError: 'On branch main\nUnmerged paths:\n  both modified: foo.ts\nnothing to commit, working tree clean',
    errorKeyword: 'Unmerged',
    filter: findCase('git-status (clean state)'),
  },
]

interface SafetyResult {
  test: SafetyTest
  passed: boolean
  filteredBody: string
  reason: string
}

function runSafetyTest(t: SafetyTest): SafetyResult {
  const r = applyFilter(t.filter, t.inputWithError)
  // Pass: filter did NOT short-circuit AND error keyword still present in output
  const errorPresent = r.body.includes(t.errorKeyword)
  const didNotSwallow = !r.shortCircuited || errorPresent
  return {
    test: t,
    passed: didNotSwallow && errorPresent,
    filteredBody: r.body,
    reason: r.shortCircuited
      ? errorPresent
        ? 'short-circuited but error survived in message'
        : `SWALLOWED: short-circuited and "${t.errorKeyword}" missing`
      : errorPresent
        ? 'error preserved through pipeline'
        : `STRIPPED: error keyword "${t.errorKeyword}" was removed by filter`,
  }
}

// ============================================================
// Rewrite tests — end-to-end: simulated rewrite + real captured output
// ============================================================

interface RewriteTest {
  name: string
  filter: FilterSpec
  inputCommand: string
  /** sample file containing output of the *rewritten* command (the result we'd get) */
  rewrittenSampleFile: string
  expectedRewriteTarget: string  // what command we expect after rewrite
  /** sample file containing output of the *original* command (for ROI comparison) */
  originalSampleFile: string
}

const REWRITE_TESTS: RewriteTest[] = [
  {
    name: 'git-log: rewrite default → --oneline',
    inputCommand: 'git log -10',
    expectedRewriteTarget: 'git log --oneline -10',
    originalSampleFile: 'git-log-default.txt',     // 9.220 bytes verbose
    rewrittenSampleFile: 'git-log-oneline.txt',    // 696 bytes compact
    filter: {
      name: 'git-log-rewrite',
      matchCommand: /^git(\s+-[^\s]+)*\s+log\b/,
      matchCommandReject: /--oneline|--format=|--pretty=|-p\b|--patch|\s-1\b|\s-2\b|\s-3\b/,
      rewriteCommand: ({ args }) => {
        // Append --oneline; preserve user's -N if any
        const otherArgs = args.filter(a => a !== 'log')
        return `git log --oneline ${otherArgs.join(' ')}`.replace(/\s+/g, ' ').trim()
      },
    },
  },
]

interface RewriteResult {
  test: RewriteTest
  rewriteFired: boolean
  rewrittenCommand: string | null
  matchesExpected: boolean
  originalBytes: number
  rewrittenBytes: number
  reductionPct: number
  status: 'ok' | 'rewrite-skipped' | 'wrong-target' | 'no-sample'
  diagnostics: string[]
}

function runRewriteTest(t: RewriteTest): RewriteResult {
  const diagnostics: string[] = []

  // Read both samples
  let originalBytes = 0
  let rewrittenBytes = 0
  try {
    originalBytes = readFileSync(join(SAMPLES, t.originalSampleFile), 'utf8').length
    rewrittenBytes = readFileSync(join(SAMPLES, t.rewrittenSampleFile), 'utf8').length
  } catch {
    return {
      test: t,
      rewriteFired: false,
      rewrittenCommand: null,
      matchesExpected: false,
      originalBytes,
      rewrittenBytes,
      reductionPct: 0,
      status: 'no-sample',
      diagnostics: ['Sample file(s) not found'],
    }
  }

  // Test rewrite logic
  const rewriteResult = maybeRewrite(t.filter, t.inputCommand)
  if (!rewriteResult) {
    return {
      test: t,
      rewriteFired: false,
      rewrittenCommand: null,
      matchesExpected: false,
      originalBytes,
      rewrittenBytes,
      reductionPct: 0,
      status: 'rewrite-skipped',
      diagnostics: [`Rewrite did not fire for "${t.inputCommand}"`],
    }
  }

  const matchesExpected = rewriteResult.rewritten === t.expectedRewriteTarget
  if (!matchesExpected) {
    diagnostics.push(`Expected "${t.expectedRewriteTarget}", got "${rewriteResult.rewritten}"`)
  }

  const reductionPct = originalBytes === 0
    ? 0
    : Math.round(100 * (1 - rewrittenBytes / originalBytes))

  return {
    test: t,
    rewriteFired: true,
    rewrittenCommand: rewriteResult.rewritten,
    matchesExpected,
    originalBytes,
    rewrittenBytes,
    reductionPct,
    status: matchesExpected ? 'ok' : 'wrong-target',
    diagnostics,
  }
}

const results = CASES.map(runCase)
const safetyResults = SAFETY_TESTS.map(runSafetyTest)
const rewriteResults = REWRITE_TESTS.map(runRewriteTest)
const report = buildReport(results, safetyResults, rewriteResults)

const outPath = join(__dirname, 'results.md')
writeFileSync(outPath, report)

// Console summary
console.log('=== Validation Summary ===')
console.log(`Pipeline cases: ${results.length}`)
console.log(`  OK: ${results.filter(r => r.status === 'ok').length}`)
console.log(`  Mismatch: ${results.filter(r => r.status === 'mismatch').length}`)
console.log(`  No-match command: ${results.filter(r => r.status === 'no-match-command').length}`)
console.log(`  No sample: ${results.filter(r => r.status === 'no-sample').length}`)
console.log(`Safety tests: ${safetyResults.length}`)
console.log(`  Passed: ${safetyResults.filter(s => s.passed).length}`)
console.log(`  Failed: ${safetyResults.filter(s => !s.passed).length}`)
console.log(`Rewrite tests: ${rewriteResults.length}`)
console.log(`  OK: ${rewriteResults.filter(r => r.status === 'ok').length}`)
console.log(`  Failed: ${rewriteResults.filter(r => r.status !== 'ok').length}`)
console.log(`\nReport: ${outPath}`)
console.log()

// Print quick table
for (const r of results) {
  const symbol =
    r.status === 'ok' ? '✓' : r.status === 'mismatch' ? '⚠' : '✗'
  const name = r.testCase.name.padEnd(50)
  const reduction = `${r.reductionPct}%`.padStart(5)
  const predicted = `(pred ${r.testCase.predictedReductionPct}%)`.padStart(12)
  console.log(`${symbol} ${name} ${reduction} ${predicted}`)
}
