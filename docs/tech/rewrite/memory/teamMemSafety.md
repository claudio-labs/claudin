# Spec: `memory/teamMemSafety`

Four files: `src/memory/memdir/secretScanner.ts`, `teamMemSecretGuard.ts`,
`teamMemoryOps.ts` and `memoryScan.ts`.

## Purpose

Team memory is the `team/` directory inside the private memory directory
(`getTeamMemPath()` in `teamMemPaths.ts`, owned by `memory/memdir`). It is
checked into the repository, so anything written there reaches every
collaborator on the next commit. This unit holds the safety and bookkeeping
around it:

- **The secret scanner** tells whether a piece of text holds something shaped
  like a credential, and which kind.
- **The write guard** is what the file tools call before writing. It refuses a
  write into team memory when the content holds a credential, with a message
  the model reads back.
- **The team-memory operations** let the collapsed transcript view tell
  team-memory reads, searches and writes apart from other tool calls, and give
  the words it uses for them.
- **The memory listing** reads a memory directory's files and their
  frontmatter, and renders the manifest that the extraction and recall prompts
  embed.

## Public contract

Every export keeps its name and signature. Paths in "Used by" are under `src/`
unless they start with `scripts/`.

| Export | Signature | Used by |
|---|---|---|
| `SecretMatch` (type, `secretScanner.ts`) | `{ ruleId: string; label: string }` | the guard; tests |
| `scanForSecrets` (`secretScanner.ts`) | `(content: string) => SecretMatch[]` | the guard (loaded lazily); `memory/memdir/teamMemSecretGuard.test.ts` |
| `checkTeamMemSecrets` (`teamMemSecretGuard.ts`) | `(filePath: string, content: string) => string \| null` | `tools/FileWriteTool/FileWriteTool.ts`, `tools/FileEditTool/FileEditTool.ts`, `tools/ApplyPatchTool/applyPatch.ts`, `tools/shared/stagedWrite/stagedWrite.ts` |
| `isTeamMemFile` (re-exported by `teamMemoryOps.ts`) | `(filePath: string) => boolean` | `agent/tools/collapseReadSearch.ts` |
| `isTeamMemorySearch` (`teamMemoryOps.ts`) | `(toolInput: unknown) => boolean` | `agent/tools/collapseReadSearch.ts` |
| `isTeamMemoryWriteOrEdit` (`teamMemoryOps.ts`) | `(toolName: string, toolInput: unknown) => boolean` | `agent/tools/collapseReadSearch.ts` |
| `appendTeamMemorySummaryParts` (`teamMemoryOps.ts`) | `(memoryCounts: { teamMemoryReadCount?: number; teamMemorySearchCount?: number; teamMemoryWriteCount?: number }, isActive: boolean, parts: string[]) => void` | `agent/tools/collapseReadSearch.ts` |
| `MemoryHeader` (type, `memoryScan.ts`) | `{ filename: string; filePath: string; mtimeMs: number; description: string \| null; type: MemoryType \| undefined }` | `memory/ui/memoryDirRows.ts`, `memory/ui/MemoryDirBrowser.tsx`, tests |
| `scanMemoryFiles` (`memoryScan.ts`) | `(memoryDir: string, signal: AbortSignal) => Promise<MemoryHeader[]>` | `memory/extract/extractMemories.ts`, `memory/ui/MemoryDirBrowser.tsx`, `scripts/bench/perf/memory-bench.ts` |
| `formatMemoryManifest` (`memoryScan.ts`) | `(memories: MemoryHeader[]) => string` | `memory/extract/extractMemories.ts` |

**Load-order constraints the callers rely on.**
- `teamMemSecretGuard.ts` must be safe to import unconditionally from the file
  tools. It must not load the scanner or the team paths at import time, so a
  build without the team flag carries neither.
- `teamMemoryOps.ts` is itself loaded lazily by `collapseReadSearch.ts`, and
  only in a build with the team flag.
- `memoryScan.ts` must not import the memory prompt module (`memdir.ts`) or
  anything that pulls in the API client. `extractMemories.ts` imports it, and
  that chain would close an import cycle.

**The team build flag.** `feature('TEAMMEM')` is on in the shipped build
(`scripts/build/build.ts`) and off under plain `bun test`. Only the guard
reads it. Its tests run themselves again in a child `bun test
--feature=TEAMMEM` to check the shipped behaviour.

## Observable behaviour

### 1. The secret scanner: `scanForSecrets(content)`

- **Families.** It knows 36 credential families. They are the rules of the
  public gitleaks config that carry the same IDs, and the scanner keeps only
  those with a distinctive vendor prefix or marker. Generic rules ("a long
  string next to the word `password`") are left out on purpose. Each family
  has a rule ID and a label. In the order the scanner reports them:

  | # | Rule ID | Label | What it is |
  |---|---|---|---|
  | 1 | `aws-access-token` | AWS Access Token | AWS access key ID: long-term, temporary and the older prefixes |
  | 2 | `gcp-api-key` | GCP API Key | Google Cloud API key |
  | 3 | `azure-ad-client-secret` | Azure AD Client Secret | Entra ID (Azure AD) application client secret |
  | 4 | `digitalocean-pat` | DigitalOcean PAT | DigitalOcean personal access token |
  | 5 | `digitalocean-access-token` | DigitalOcean Access Token | DigitalOcean OAuth access token |
  | 6 | `anthropic-api-key` | Anthropic API Key | Anthropic API key |
  | 7 | `anthropic-admin-api-key` | Anthropic Admin API Key | Anthropic admin key |
  | 8 | `openai-api-key` | OpenAI API Key | OpenAI key: legacy, project, service-account and admin shapes |
  | 9 | `huggingface-access-token` | HuggingFace Access Token | Hugging Face user access token |
  | 10 | `github-pat` | GitHub PAT | GitHub classic personal access token |
  | 11 | `github-fine-grained-pat` | GitHub Fine Grained PAT | GitHub fine-grained PAT |
  | 12 | `github-app-token` | GitHub App Token | GitHub user-to-server and server-to-server tokens |
  | 13 | `github-oauth` | GitHub OAuth | GitHub OAuth access token |
  | 14 | `github-refresh-token` | GitHub Refresh Token | GitHub refresh token |
  | 15 | `gitlab-pat` | GitLab PAT | GitLab personal access token |
  | 16 | `gitlab-deploy-token` | GitLab Deploy Token | GitLab deploy token |
  | 17 | `slack-bot-token` | Slack Bot Token | Slack bot token |
  | 18 | `slack-user-token` | Slack User Token | Slack user and configuration tokens |
  | 19 | `slack-app-token` | Slack App Token | Slack app-level token |
  | 20 | `twilio-api-key` | Twilio API Key | Twilio API key SID |
  | 21 | `sendgrid-api-token` | SendGrid API Token | SendGrid API key |
  | 22 | `npm-access-token` | NPM Access Token | npm access token |
  | 23 | `pypi-upload-token` | PyPI Upload Token | PyPI upload token |
  | 24 | `databricks-api-token` | Databricks API Token | Databricks personal access token, with or without its numeric suffix |
  | 25 | `hashicorp-tf-api-token` | HashiCorp TF API Token | Terraform Cloud / Enterprise API token |
  | 26 | `pulumi-api-token` | Pulumi API Token | Pulumi access token |
  | 27 | `postman-api-token` | Postman API Token | Postman API key |
  | 28 | `grafana-api-key` | Grafana API Key | Grafana legacy API key |
  | 29 | `grafana-cloud-api-token` | Grafana Cloud API Token | Grafana Cloud token |
  | 30 | `grafana-service-account-token` | Grafana Service Account Token | Grafana service-account token |
  | 31 | `sentry-user-token` | Sentry User Token | Sentry user auth token |
  | 32 | `sentry-org-token` | Sentry Org Token | Sentry organization auth token, with any of its region-URL spellings |
  | 33 | `stripe-access-token` | Stripe Access Token | Stripe secret or restricted key, in test, live or prod mode |
  | 34 | `shopify-access-token` | Shopify Access Token | Shopify Admin API access token |
  | 35 | `shopify-shared-secret` | Shopify Shared Secret | Shopify app shared secret |
  | 36 | `private-key` | Private Key | a PEM private key of any kind (RSA, EC, OpenSSH, PKCS#8, encrypted, PGP key block) |

  The suite holds a realistic sample of every family, glued together at run
  time, and the lookalikes that must pass. The shapes come from the gitleaks
  config. Go's inline case flags become explicit character classes, and no
  family is widened or narrowed beyond what the tests pin.
- **The result.** One `{ ruleId, label }` per family found, in the table's
  order, whatever order the text holds them in. A family found many times
  appears once. Text with nothing in it gives `[]`, and so does empty text.
- **The value never leaves.** A match has exactly the two keys `ruleId` and
  `label`. Nothing of the matched text is returned, logged or kept.
- **Repeatable.** The same text gives the same answer on every call, and
  calls do not affect each other. Each call returns a new array.
- **Labels.** The rule ID's words, each capitalized and joined by spaces. Some
  words take a fixed spelling: AWS, GCP, API, PAT, AD, TF, OAuth, NPM, PyPI,
  GitHub, GitLab, OpenAI, DigitalOcean, HuggingFace, HashiCorp and SendGrid.
  The table above is the full result.
- **Where a token ends.** The suite pins five behaviours:
  - **Families 2, 4–9, 21, 22, 24, 26–31 and 33.** The token must start at a
    word boundary. It must be followed by the end of the text, whitespace,
    `"`, `'`, a backtick, `;`, or the two-character escapes `\n` and `\r` (a
    key inside a JSON string). A token glued to a preceding word, or running
    on into more token characters, is not flagged.
  - **Family 1 (AWS).** It needs a word boundary on both sides, so any
    punctuation ends it (`.`, `,`, `)`, `/`), but a following letter, digit
    or `_` does not.
  - **Family 32 (Sentry org).** It needs a word boundary before it, and
    nothing after it.
  - **Families 10–20, 23, 25, 34, 35 and 36.** These have no boundary rule,
    and a longer run or a preceding word does not stop them.
  - **Family 3 (Azure).** It needs a delimiter on both sides. Before it: the
    start of the text, whitespace, a quote or backtick, a backslash, `(`,
    `)`, `,`, `=`, `:` or `>`. After it: the end of the text, whitespace, a
    quote or backtick, a backslash, `)`, `,` or `<`.
- **Letter case.** Slack app tokens and private-key markers match in any case.
  Everything else matches only in the vendor's own case: a lowercase AWS key,
  a capitalized GitHub prefix, an uppercase Databricks token and a capitalized
  Terraform marker all pass.
- **Private keys.** A `BEGIN … PRIVATE KEY` marker and a matching `END` line
  with at least 64 characters between them. A shorter body, a missing `END`,
  public keys and certificates all pass.

### 2. The write guard: `checkTeamMemSecrets(filePath, content)`

- **Without the team build flag** it returns `null` for every input.
- **With the flag**:
  - The path is resolved lexically. Dot segments are applied, a relative path
    is resolved against the process working directory, and symlinks are not
    followed. A path below the team directory is checked. Any other path gets
    `null`, including private memory, a sibling such as `team-old/`, a path
    that climbs out of `team/`, and the project.
  - It checks every file below `team/`, whatever its extension, the team index
    `MEMORY.md` included.
  - It checks even when auto memory is switched off.
  - Content that the scanner finds clean, or empty, gets `null`.
  - Otherwise it returns a refusal message. The message:
    - starts with `Content contains potential secrets (` followed by the labels
      of every family found, in the scanner's order, joined by `, `, then `)`;
    - says the content cannot be written to team memory;
    - says that team memory is shared with all repository collaborators;
    - asks the model to remove the sensitive content and try again;
    - never contains the matched value.

    Two writes with the same families get the same message. The callers hand
    it back to the model as the tool's error.
- **What the callers pass.** Write passes the whole new file. Edit passes only
  `new_string`. Patch passes the added file's content, or the patched text at
  the move target when there is one. The staged write passes the new content.

### 3. Team-memory operations (`teamMemoryOps.ts`)

- **`isTeamMemFile(path)`** is true when auto memory is on and the path
  resolves below the team directory.
- **`isTeamMemoryWriteOrEdit(toolName, input)`**:
  - It is true only for the tool names `Write` and `Edit`, exactly as spelled
    (the names exported by `FileWriteTool/prompt.ts` and `FileEditTool/constants.ts`).
  - The target is `input.file_path`, or `input.path` when `file_path` is
    absent, and it must pass `isTeamMemFile`.
  - Any other tool (`Read`, `Patch`, a differently cased name), a missing or
    `null` input, or an input without either key gives false.
- **`isTeamMemorySearch(input)`**:
  - It is true when `input.path` is a non-empty string that passes
    `isTeamMemFile`.
  - `pattern` and `glob` are ignored, even when they name the team directory.
  - A missing or `null` input, or an empty `path`, gives false.
- **`appendTeamMemorySummaryParts(counts, isActive, parts)`** pushes up to
  three parts onto `parts`, in this order, and returns nothing. A missing count
  is 0, and a count of 0 adds nothing.

  | Count | Running (`isActive`) | Done |
  |---|---|---|
  | reads, `n` | `Recalling n team memories` | `Recalled n team memories` |
  | searches | `Searching team memories` | `Searched team memories` |
  | writes, `n` | `Writing n team memories` | `Wrote n team memories` |

  - A count of 1 reads `1 team memory`. The search part never carries a
    number.
  - A part's verb is capitalized only when `parts` is empty at the moment it
    is pushed. That covers parts pushed earlier by the same call, so with all
    three counts and an empty `parts` the result is `Recalled 2 team memories`,
    `searched team memories`, `wrote 1 team memory`.

### 4. The memory listing (`memoryScan.ts`)

- **`scanMemoryFiles(memoryDir, signal)`**:
  - **Which files.** The listing walks the directory recursively, and
    symlinked directories are walked like real ones, under the link's name.
    It lists every file whose name ends in `.md` (lowercase) and lies at most
    two directories below `memoryDir`. Files named exactly `MEMORY.md` are
    left out in every directory. Other files, `.MD` among them, are left out,
    and so are the deeper levels. `memory.md` is listed.
  - **Each entry.**
    - `filename` is the path relative to `memoryDir`, with the platform
      separator.
    - `filePath` is `memoryDir` joined with it.
    - `mtimeMs` is the file's modification time.
    - `description` is the frontmatter `description`, or `null` when it is
      missing or empty.
    - `type` is the frontmatter `type` when it is one of the four memory types
      (`parseMemoryType`, exact case), else `undefined`.
  - **Only the head of a file is read**, up to its first 30 lines. Frontmatter
    that has not closed by then counts as absent. So does frontmatter that
    never closes, or a file without any, and that file is still listed. A large
    body changes nothing.
  - **The order.** Newest modification first, and only the 200 newest are
    kept.
  - A file that cannot be read is skipped, and the others are still listed.
    A directory named like `x.md` is one such case.
  - **Failures.** It resolves to `[]` when the directory is missing, when the
    path is a file, when the directory is empty, when the signal is already
    aborted, or when the listing itself fails. It never rejects.
- **`formatMemoryManifest(headers)`**:
  - It renders one line per header, in the order given, joined by `\n`, with
    no trailing newline. No headers render as `''`.
  - A line reads `- [type] filename (ISO time): description`:
    - the `[type] ` tag is left out when there is no type;
    - the `: description` is left out when the description is `null` or empty;
    - the time is `mtimeMs` as an ISO-8601 UTC string, with milliseconds.

  This text goes into the extraction and recall prompts. No file outside the
  unit pins it byte for byte, because the extraction suites build their
  expected manifests by calling this function.

## Edge cases and errors

| Case | What the caller sees |
|---|---|
| `scanForSecrets('')` | `[]` |
| a vendor prefix with no body, a placeholder (`ghp_<your-token>`), `${TOKEN}` | `[]` |
| a Stripe publishable key, a git SHA, a UUID, a public key, a certificate | `[]` |
| the guard without the team flag | `null`, whatever the path and content |
| the guard on a relative path | resolved against the process working directory, so normally `null` |
| the guard after the session moves to another project | the team directory follows the project, so the old directory's paths get `null` |
| `isTeamMemoryWriteOrEdit` / `isTeamMemorySearch` with auto memory off | false |
| `scanMemoryFiles` on a missing directory, a file or an aborted signal | `[]` |
| a memory file that is unreadable or is a directory | skipped |
| frontmatter that closes after line 30 | `description: null`, `type: undefined` |

## Security requirements

- **The guard fails closed on the content it is given.** A family match always
  refuses the write. No setting, no environment variable, and the auto-memory
  switch do not turn it off. Only the build flag does.
- **No secret leaves the scanner.** Neither matches nor the refusal carry any
  part of the matched text, because the refusal is read back by the model and
  can end up in transcripts and logs.
- **The family list does not shrink.** Each of the 36 families stays
  detected on its samples, and every pinned lookalike stays allowed. Hardening
  that catches more real credentials is welcome (see Findings), but it must
  keep every lookalike in the suite passing.
- **The scan is stateless.** A previous call never changes the next one.
- **Fixtures.** Tests build every credential-shaped value at run time from
  pieces. No token-shaped literal is committed, so the repository's own
  scanners never fire. The scanner source should keep doing the same for its
  Anthropic prefix, since the bundle is checked for that byte sequence.

## Tests that pin it

- `src/memory/memdir/teamMemSafety.scanner.characterization.test.ts`: the
  families, lookalikes, token ends, case, ordering, deduplication and
  statelessness (88 tests).
- `src/memory/memdir/teamMemSafety.guard.characterization.test.ts`: the guard
  with the flag off (2 tests in-process, one of which runs the child) and on
  (16 tests in the child `bun test --feature=TEAMMEM`).
- `src/memory/memdir/teamMemSafety.ops.characterization.test.ts`: the
  team-memory operations and the summary words (37 tests).
- `src/memory/memdir/teamMemSafety.scan.characterization.test.ts`: the listing
  and the manifest (29 tests).
- `src/memory/memdir/teamMemSecretGuard.test.ts`: this project's own, kept. It
  pins the team-path predicate and three scanner cases.
- `scripts/migrations/probes/rewrite-memory-teamMemSafety.json`: 40 probes
  across the four files, each of which turns the suites red.
- `src/memory/extract/extractMemories*.characterization.test.ts` use the
  listing and the manifest through the extraction.

The inherited test that `phase-2.md` names, `memoryScan.test.ts`, is no
longer in the tree. Nothing was left to fold in, and the scan suite covers the
listing and the manifest.

## Out of scope

- **Counting Patch calls as team-memory writes.** Kept as it is (see
  Findings).
- **Resolving symlinks in the team-path test.** The predicate belongs to
  `memory/memdir` (see Findings).
- Nothing is dropped.

## Findings

| # | Finding | Decision |
|---|---|---|
| 1 | **The private-key check takes quadratic time.** Text made of repeated `BEGIN … PRIVATE KEY` markers with no end marker costs 1.7 s at 108 KB and 27 s at 432 KB. That time is spent synchronously, inside the file tools' input validation, so content steered by a prompt injection can freeze the CLI. | **Fix** (hardening). Match private keys in linear time, for example by finding each marker and then the next end marker. Legitimate use never notices. The rewrite adds a time-bounded test, which the old code would fail. |
| 2 | **Some terminators are missed.** For the families with an end rule (2, 4–9, 21, 22, 24, 26–31, 33), a token followed by `.`, `,`, `)`, `]` or `>` is let through. That covers a key at the end of a sentence, inside markdown parentheses or brackets, or in a list. All are common in memory prose. AWS keys do not have this gap. | **Fix** (hardening). Any character that cannot continue the token ends it. The pinned lookalikes (a token running on into more token characters, a token glued to a preceding word) still pass. This departs from gitleaks on purpose. |
| 3 | **A symlink cycle breaks the listing.** Bun fails the walk (`ELOOP`), so the listing comes back empty. Node, the shipped runtime, lists files again under `loop/…` with one cycle, and with two it spends about 4 s and then comes back empty. | **Fix.** Walk the tree without entering a directory twice, and let a bad entry be skipped rather than empty the listing. No caller depends on either outcome. Not pinned. |
| 4 | **A search of the team directory itself is missed.** With `path` set to the team directory, with or without a trailing separator, `isTeamMemorySearch` returns false, because a resolved path loses its trailing separator. The collapsed view then counts it as a private-memory or plain search. | **Fix.** The team directory itself counts. The change is visible only in the collapsed summary. Not pinned. |
| 5 | **`description` is not always a string.** It can be a number, `true` or a list, because the YAML value passes through as it is, although the type says `string \| null`. The manifest prints `42` or `x,y`. | **Fix.** Text scalars stay as text, and numbers and booleans become their text. Anything else becomes `null`. Manifest lines for scalars are unchanged. Not pinned. |
| 6 | **A multi-line `description` breaks the manifest.** A YAML block scalar puts its line breaks into the manifest, breaking its one-line-per-file shape. | **Fix** (hardening). Collapse whitespace runs to one space. Not pinned. |
| 7 | **A write through a symlink is not scanned.** The team-path test is lexical, so a write to a path outside `team/` that is a symlink to a file inside it goes through unchecked. | **Keep for parity** in this unit. The fix (resolving both sides, the team directory included, because `/tmp` and macOS paths are symlinked) belongs to the `isTeamMemPath` predicate that `memory/memdir` owns and specifies as lexical. Route it there. |
| 8 | **Edit checks only `new_string`.** A credential split across the existing text and the new text, or built over two edits, is never seen. The cause is in `FileEditTool`, outside the unit. | **Keep for parity** here, and route it to the `tools` phase. |
| 9 | **Patch calls are not counted as team-memory writes.** The collapsed summary's write check only knows `Write` and `Edit`. | **Keep for parity.** A Patch names its files inside its patch text, and counting them needs the patch parser, which the caller owns. |

## Target design

- **`secretScanner.ts`** is a pure module with a data table of families and
  one scanning function. Each family entry holds its ID, label, matcher and
  end rule, so the label is data, not derived at run time. Keep the gitleaks
  attribution (MIT) in the file header and in `THIRD_PARTY_NOTICES.md`.
  Compile the patterns once, without the global or sticky flags, and give
  private keys a linear-time matcher (finding 1).
- **`teamMemSecretGuard.ts`** is a thin adapter: the flag gate, lazy loads of
  the path predicate and the scanner, and the message built from labels. The
  message wording lives in one constant beside the function.
- **`teamMemoryOps.ts`** holds pure predicates over a typed view of the tool
  input (`{ file_path?: string; path?: string }`), narrowed with a type guard
  rather than a cast. The summary words come from one table keyed by
  operation, with a function for case and number.
- **`memoryScan.ts`** splits in two:
  - a directory walker with a depth limit and cycle safety (finding 3);
  - a header reader (bounded head read, frontmatter, type and description
    normalization; findings 5 and 6).

  The formatter is a pure function. Keep it free of the prompt and API-client
  imports.
- **Types.** Explicit throughout, with no `any`. `MemoryHeader.description`
  is truly `string | null`.

## Outcome

Rewritten per method on 2026-10-03.
- **The rewrite.** The 9 inherited bodies and the secret rule table were
  written anew. The 36 rule families are now data, each with its ID, label,
  pattern and boundary. The rule IDs and token shapes come from gitleaks (MIT).
  Its notice is in `THIRD_PARTY_NOTICES.md`, and the copyright line was checked
  against gitleaks' LICENSE. The private-key check and the directory walk moved
  into `secretScanner/` and `memoryScan/`. The characterization suites and
  `teamMemSecretGuard.test.ts` pass unchanged.
- **Fixes**, each with a test:
  - 432 KB of `BEGIN` markers scans in 17 ms instead of 27 s;
  - a token ends at any character outside its family's alphabet;
  - no directory is entered twice;
  - a search of the team directory counts as a team-memory search;
  - descriptions are coerced to text and collapsed to one line.
- **Deviations.**
  - The token-end rule is wider than the five characters listed, and covers
    SendGrid's trailing `.`.
  - A second name for a directory lists its files once, under the real name.
- **Probes.**
  - `rewrite-memory-teamMemSafety.json`: 80 probes.
  - `teamMemSecretGuard.json`: kept its 2 surface probes. Its 3 stale probes were
    pruned, since the new spec pins the same behaviour.
- **Residue, reviewed.** 20 lines of Claude Code remain, and all are contract:
  - `memoryScan.ts`, 9: the `MemoryHeader` fields, the two limits (200 files,
    30 frontmatter lines) and the signature and abort check of `scanMemoryFiles`;
  - `teamMemoryOps.ts`, 7: the count fields of the summary parameter;
  - `teamMemSecretGuard.ts`, 2: the signature and the `feature('TEAMMEM')`
    guard, whose shape the build fixes;
  - `readMemoryHeader.ts`, 2: a signature.
