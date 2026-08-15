import { describe, expect, it, beforeEach } from 'bun:test'
import { acceptsGitCommand } from 'src/tools/GitTool/grammar.js'
import {
  isRedirectableGitCommand,
  renderGitRedirect,
  resetGitRedirectMemoForTesting,
  shouldRedirectToGit,
  stripOutputTrimTail,
} from 'src/tools/GitTool/redirect.js'

beforeEach(() => {
  resetGitRedirectMemoForTesting()
})

describe('isRedirectableGitCommand', () => {
  it('redirects the read shapes the tool handles', () => {
    for (const cmd of [
      'git diff',
      'git diff --stat HEAD~1',
      'git log --oneline -20',
      'git status',
      'git status --short',
      'git show abc1234',
      'git blame src/x.ts',
      'gh pr view 12',
      'gh pr list --state open',
      'gh pr checks 12',
    ]) {
      expect(isRedirectableGitCommand(cmd)).toBe(true)
    }
  })

  it('redirects the gh reads the tool renders better', () => {
    // Each of these has a renderer on the other side: the CI-log parser for
    // `run view`, the diff budget (plus the delta lane) for `pr diff`, the
    // body budget for `issue view`.
    for (const cmd of [
      'gh run view 18492',
      'gh run view --job 92198424809 --repo claudio-labs/claudin --log',
      'gh run view --job 92198424809 --log-failed',
      'gh pr diff 52',
      'gh pr diff 52 --repo claudio-labs/claudin',
      'gh issue view 31',
    ]) {
      expect(isRedirectableGitCommand(cmd)).toBe(true)
    }
  })

  it('redirects the watch shapes, which the tool runs on different terms', () => {
    // Not a renderer this time: a 10-minute ceiling instead of Bash's 2, a live
    // clock, and a result collapsed to the final refresh.
    for (const cmd of [
      'gh run watch 31442753617',
      'gh run watch 31442753617 --compact',
      'gh pr checks 72 --watch',
    ]) {
      expect(isRedirectableGitCommand(cmd)).toBe(true)
    }
  })

  it('leaves a watch with an explicit interval alone', () => {
    // `-i` is in the opt-out set because it means `--interactive` everywhere
    // else, and a missed redirect costs nothing. Pinned so the day someone
    // narrows that flag, this reads as a deliberate consequence.
    expect(isRedirectableGitCommand('gh run watch 1 -i 5')).toBe(false)
  })

  it('leaves the gh reads the tool hands back unchanged in Bash', () => {
    // A refusal costs a round-trip. Spending one on output the tool does not
    // reduce buys nothing — batching alone did not survive the A/B.
    for (const cmd of [
      'gh run list --limit 20',
      'gh issue list --state open',
      'gh workflow view ci.yml',
      'gh release view v1.0.8',
      'gh api repos/claudio-labs/claudin/pulls/52/comments',
      'gh search prs --author @me',
    ]) {
      expect(isRedirectableGitCommand(cmd)).toBe(false)
    }
  })

  it('leaves mutations in Bash', () => {
    // Reads carry 1.36M of the 1.70M recorded git/gh chars; refusing a
    // mutation would buy nothing and put a dialog in front of a command the
    // model already had permission for.
    for (const cmd of [
      'git add -A',
      'git commit -m "x"',
      'git push',
      'git checkout main',
      'git stash',
      'gh pr create --title x --body y',
      'gh pr merge 12',
      'gh run rerun 18492',
      'gh run cancel 18492',
      'gh issue create --title x --body y',
    ]) {
      expect(isRedirectableGitCommand(cmd)).toBe(false)
    }
  })

  it('does not fire on a command that merely mentions a read', () => {
    // The worst possible false positive: a search blocked by the git tool.
    for (const cmd of [
      'grep -rn "git diff" src',
      'rg "git status" --glob "*.ts"',
      'echo git log',
      'cat git-diff.txt',
    ]) {
      expect(isRedirectableGitCommand(cmd)).toBe(false)
    }
  })

  it('opts out of global options rather than guessing', () => {
    // `git -C /elsewhere diff` runs somewhere else and `--no-pager` is an
    // explicit output choice. Both are rare; a missed redirect costs nothing.
    expect(isRedirectableGitCommand('git -C /tmp/other diff')).toBe(false)
    expect(isRedirectableGitCommand('git --no-pager log -5')).toBe(false)
  })

  it('opts out of TTY, browser and help forms', () => {
    // `-i` needs a TTY and the tool refuses those forms outright, so
    // redirecting one would leave the command with nowhere to run.
    expect(isRedirectableGitCommand('git log -i --grep=fix')).toBe(false)
    expect(isRedirectableGitCommand('gh pr view 12 --web')).toBe(false)
    expect(isRedirectableGitCommand('git diff --help')).toBe(false)
    expect(isRedirectableGitCommand('gh run view 18492 --web')).toBe(false)
  })

  it('still redirects `-p`, which is a patch and not an interactive prompt', () => {
    // `-p` means "interactive" for add/checkout/restore/stash — none of which
    // this allowlist admits — and "show the patch" for log/show/diff.
    expect(isRedirectableGitCommand('git log -p -3')).toBe(true)
    expect(isRedirectableGitCommand('git show -p HEAD')).toBe(true)
  })
})

describe('quoted arguments', () => {
  it('redirects a read whose operators are inside quotes', () => {
    // The gap `hasShellComposition` left: a `|` or `;` inside quotes is not
    // composition, bash hands it to git verbatim, and the tool runs the
    // command unchanged. All recorded shapes.
    for (const cmd of [
      "git log -3 --format='%an|%s%n%b%n---'",
      "git log main..HEAD --format='=== %h %s%n%b'",
      "git log --pretty=format:'%h %s' -20",
      'git log -3 --format="%s"',
      'git log --since="2 weeks ago"',
      "git show --stat --format='' HEAD",
      "git diff -- 'src/**/*.ts'",
      "gh pr view 36 --json body,title -q '.title + \"---\" + .body'",
      "gh run view 30938431610 --json status,conclusion --jq '.status'",
    ]) {
      expect(isRedirectableGitCommand(cmd)).toBe(true)
    }
  })

  it('still keeps an operator OUTSIDE quotes in Bash', () => {
    // The quote-awareness must not become a blanket pass: these compose.
    for (const cmd of [
      "git log --format='%h %s' > /tmp/log.txt",
      "git log --format='%h' -3; git status",
      "git diff --stat && git log --format='%s' -1",
    ]) {
      expect(isRedirectableGitCommand(cmd)).toBe(false)
    }
  })

  it('keeps anything the shell would rewrite in Bash', () => {
    // The tool runs the command without a shell, so an expansion it would not
    // perform must not be redirected — `$` and a backtick are only literal
    // inside single quotes.
    for (const cmd of [
      'git log --grep="$USER" -5',
      'git show $(git rev-parse HEAD)',
      'git log --format="`date`" -1',
      "git log --format='%h",
    ]) {
      expect(isRedirectableGitCommand(cmd)).toBe(false)
    }
  })

  it('redirects a quoted read through its trim tail', () => {
    expect(
      isRedirectableGitCommand("git log -3 --format='--- %s%n%b' | head -30"),
    ).toBe(true)
    expect(
      stripOutputTrimTail("git log -3 --format='--- %s%n%b' | head -30"),
    ).toBe("git log -3 --format='--- %s%n%b'")
  })

  it('does not strip a filter name that lives inside a quoted argument', () => {
    // `| tail -5` here is part of the pattern, not a trim tail.
    const cmd = "git log --grep='fix | tail -5' -3"
    expect(stripOutputTrimTail(cmd)).toBe(cmd)
    expect(isRedirectableGitCommand(cmd)).toBe(true)
  })
})

describe('output-trim tails', () => {
  it('redirects through a trim tail — the bulk of the real surface', () => {
    // Measured over 760 recorded sessions: 64 of 162 `git diff` calls, 67 of
    // 137 `git log` and 68 of 268 `git status` carry one of these. Treating
    // them as shell composition is what kept the RunTests redirect from ever
    // firing on Rust.
    for (const cmd of [
      'git diff | head -50',
      'git diff --stat | tail -5',
      'git log --oneline -20 2>&1 | tail -15',
      'git status --short | grep -i subtitle',
      'gh pr checks 31 2>&1 | tail -15',
    ]) {
      expect(isRedirectableGitCommand(cmd)).toBe(true)
    }
  })

  it('redirects a CI log read through its trim tail', () => {
    // The recorded shape this whole `gh run view` line exists for: the model
    // pipes the log into `tail`/`grep` because the raw dump is unreadable,
    // which is exactly what the tool's log renderer does for it.
    expect(
      isRedirectableGitCommand(
        'gh run view --job 92198424809 --repo claudio-labs/claudin --log-failed 2>&1 | tail -60',
      ),
    ).toBe(true)
  })

  it('leaves a `2>/dev/null` read in Bash — that is a shell redirect', () => {
    // Only `2>&1` is a trim tail. `/dev/null` needs a shell, and the tool
    // refuses the string outright, so redirecting it would deadlock.
    for (const cmd of [
      'gh run view --job 92198424809 --log 2>/dev/null | grep -A 25 "label tracks" | head -45',
      'gh run view --job 92198424809 --log 2>/dev/null > /tmp/ci.log; grep -nE "error:" /tmp/ci.log',
    ]) {
      expect(isRedirectableGitCommand(cmd)).toBe(false)
    }
  })

  it('leaves `| wc` in Bash — a count is not a summary', () => {
    expect(isRedirectableGitCommand('git status --short | wc -l')).toBe(false)
    expect(isRedirectableGitCommand('git diff | wc -c')).toBe(false)
  })

  it('does NOT treat a tail carrying more commands as a trim', () => {
    // The shared stripper's argument run is "not a pipe or a quote", so it
    // swallows whole extra commands after the filter. Suggesting the stripped
    // form would silently drop them — both of these are real recorded
    // commands.
    const withSemicolons =
      'git show --stat 6016051 | head -30; echo ---; git log --oneline --graph HEAD origin/main -8'
    const withAnd = 'git diff | head -100 && echo done'

    expect(stripOutputTrimTail(withSemicolons)).toBe(withSemicolons)
    expect(stripOutputTrimTail(withAnd)).toBe(withAnd)
    expect(isRedirectableGitCommand(withSemicolons)).toBe(false)
    expect(isRedirectableGitCommand(withAnd)).toBe(false)
  })

  it('strips a genuine trim tail down to the bare command', () => {
    expect(stripOutputTrimTail('git diff --stat 2>&1 | tail -5')).toBe(
      'git diff --stat',
    )
  })
})

describe('shouldRedirectToGit — one-shot', () => {
  it('refuses once, then lets the identical re-send through', () => {
    expect(shouldRedirectToGit('git diff')).toBe(true)
    expect(shouldRedirectToGit('git diff')).toBe(false)
    expect(shouldRedirectToGit('git diff')).toBe(false)
  })

  it('tracks commands independently', () => {
    expect(shouldRedirectToGit('git diff')).toBe(true)
    expect(shouldRedirectToGit('git status')).toBe(true)
    expect(shouldRedirectToGit('git diff')).toBe(false)
  })

  it('never arms on a command it would not redirect', () => {
    expect(shouldRedirectToGit('git push')).toBe(false)
    expect(shouldRedirectToGit('git push')).toBe(false)
  })
})

describe('renderGitRedirect', () => {
  it('names the tool, the exact call, and the list affordance', () => {
    const msg = renderGitRedirect('git diff --stat')
    expect(msg).toContain('Git')
    expect(msg).toContain('commands: ["git diff --stat"]')
    // The batching affordance is half the point of the tool taking a list.
    expect(msg).toContain('LIST')
    expect(msg).toContain('re-send this exact Bash command')
  })

  it('suggests the stripped command and says why the filter is gone', () => {
    const msg = renderGitRedirect('git diff 2>&1 | tail -20')
    expect(msg).toContain('commands: ["git diff"]')
    expect(msg).toContain('output filter is dropped on purpose')
  })

  it('omits the filter note when there was no filter', () => {
    expect(renderGitRedirect('git diff')).not.toContain(
      'output filter is dropped',
    )
  })
})

/**
 * Real commands sampled from 1,608 distinct recorded Bash invocations
 * (`scripts/profile/git-tool-baseline.ts --json`). Committed rather than read
 * from the transcripts at test time so the invariant runs anywhere.
 */
const RECORDED_COMMANDS: readonly string[] = [
  // Trim tails — the coverage this redirect exists to reach.
  'gh pr checks 157 --repo ferrous-networking/ferrous-dns 2>&1 | head -50',
  'gh pr view 33 --json number,title,state,headRefName,url,isDraft,body 2>&1 | head -40',
  'gh run view --job 92198424809 --repo claudio-labs/claudin --log-failed 2>&1 | tail -60',
  'git diff --stat | tail -5',
  'git diff main...HEAD --stat 2>&1 | tail -15',
  'git diff src/components/workflows/RunningWorkflowsTab.tsx | grep "^@@"',
  'git log --stat -1 d67e21a | head -50',
  'git show --stat b5a5edc 2>&1 | head -40',
  'git status --short | grep -i subtitle',
  // Plain reads.
  'gh pr checks 5 2>&1',
  'gh pr view 13 --json state,mergedAt,headRefName 2>&1',
  'gh pr view 3416 --repo morpheus65535/bazarr --comments',
  'gh pr diff 52',
  'gh run view --job 92198424809 --repo claudio-labs/claudin --log',
  'git diff',
  'git diff -- src/terminal/explorer/ExplorerDialog.tsx',
  'git diff --stat ROADMAP.md',
  'git diff .claudin/memory/team/MEMORY.md',
  'git diff HEAD --stat',
  'git diff main...HEAD --stat',
  'git diff src/constants/prompts.ts',
  'git log --oneline -15',
  'git log --oneline -5',
  'git status --short',
  'git status -sb',
  // Head matches but composition keeps them in Bash.
  'git diff --stat && git diff',
  'gh run view --job 92198424809 --log 2>/dev/null | grep -A 25 "label tracks" | head -45',
  'gh run view --job 92198424809 --log 2>/dev/null > /tmp/ci.log; grep -nE "error:" /tmp/ci.log',
  'git diff v1.0.16..HEAD -- .env.example | cat',
  'git log --oneline -3 && git status --short | head -20',
  'git show --stat 6016051 | head -30; echo ---; git log --oneline --graph HEAD -8',
  'git status && echo "=== DIFF STAT ===" && git diff --stat',
  'git status --porcelain | head; echo "---"; sed -n \'255,270p\' src/x.ts',
  'git status --short && git checkout -b feat/x && git branch --show-current',
  'git status --short --branch && git log --oneline -3 && git stash list | head -5',
  // Quoted arguments — operators the shell never acts on.
  "git log -3 --format='%an|%s%n%b%n---'",
  "git log -20 --format='%h %s%n%b---' main..HEAD | head -200",
  "git log --oneline -S\"strict: true\" -- src/services/api/codexShim.ts | tail -5",
  "git show --stat --format='%b' eaabb20 | head -20",
  "gh pr view 51 --json comments,reviews --jq '.comments[] | .body' 2>&1 | head -50",
  "gh run view 31442130244 --json status,conclusion,jobs --jq '.status'",
  // Mutations, which stay in Bash by design.
  'git add -A && git commit -q -m "x"',
  'git push -u origin feat/git-tool',
  'git stash push -m wip',
  "git commit -q -F - <<'EOF'",
]

describe('deadlock invariant', () => {
  /**
   * If Bash refuses a command that the Git tool ALSO refuses, the model is
   * stuck with no way to run it. Every redirected command must therefore be
   * one the tool accepts, in the exact form the refusal suggests.
   *
   * Note this pins the grammar's syntactic gate. A refusal added elsewhere in
   * the tool (the interactive-form check in `run.ts`, say) is not visible
   * here — the opt-out flags above are the guard for that.
   */
  it('every redirected command is accepted by the Git tool', () => {
    const redirected = RECORDED_COMMANDS.filter(isRedirectableGitCommand)
    expect(redirected.length).toBeGreaterThan(15)

    const violations = redirected.filter(
      cmd => !acceptsGitCommand(stripOutputTrimTail(cmd)),
    )
    expect(violations).toEqual([])
  })

  it('holds for the synthetic edge cases too', () => {
    const edge = [
      'git diff',
      'git diff | head -50',
      'git log --oneline -20 2>&1 | tail -15',
      'git show HEAD -- "src/a b.ts"',
      'gh pr view 12 --json title',
      'git blame -L 10,20 src/x.ts',
    ]
    for (const cmd of edge) {
      if (!isRedirectableGitCommand(cmd)) continue
      expect(acceptsGitCommand(stripOutputTrimTail(cmd))).toBe(true)
    }
  })

  it('the suggested call is exactly what the tool would accept', () => {
    // The message must not hand back something the tool then rejects.
    for (const cmd of RECORDED_COMMANDS.filter(isRedirectableGitCommand)) {
      const suggested = stripOutputTrimTail(cmd)
      expect(renderGitRedirect(cmd)).toContain(
        `commands: [${JSON.stringify(suggested)}]`,
      )
    }
  })
})
