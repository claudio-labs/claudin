export const APPLY_PATCH_TOOL_NAME = 'apply_patch'

// IMPORTANT — cache safety: this description is serialized into the `tools`
// block, which is the head of the cached request prefix and carries no
// cache_control marker of its own. toolToAPISchema (src/services/api/api.ts) freezes
// it per session, so it MUST be a static module-level constant — never
// interpolate dates, cwd, model id, git state, or per-turn flags. Any byte
// change here invalidates the whole downstream prompt cache.
// See docs/tech/cache/clip-frontier-breakpoint.md + src/services/tools/toolSchemaCache.ts.
export const DESCRIPTION = `Apply a patch to one or more files in a single, atomic call. Use this to create, modify, delete, or rename several files at once.

The patch is a stripped-down, file-oriented diff format (the Codex "apply_patch" envelope). The whole patch goes in the single \`patchText\` parameter. Paths may be relative to the working directory or absolute.

The envelope is:

*** Begin Patch
[ one or more file sections ]
*** End Patch

Each file section starts with exactly one header:

*** Add File: <path>     Create a new file. Every following line is a "+" line holding the initial contents. Fails if the file already exists.
*** Delete File: <path>  Remove an existing file. Nothing follows the header.
*** Update File: <path>  Patch an existing file in place. May be followed by an optional "*** Move to: <new path>" line to rename the file as part of the update.

Inside an Update section, changes are grouped into hunks. Each hunk begins with a "@@" line, followed by the change lines:
  - a leading space (" ") marks an unchanged context line, present to anchor the hunk
  - a leading "-" marks a removed line
  - a leading "+" marks an added line
A hunk may end with "*** End of File" to anchor it to the end of the file.

The "@@" line is a one-line search cursor, not a unified-diff header:
  - a bare "@@" is valid, and is the right default whenever the hunk's own context lines already locate it uniquely
  - to point somewhere, copy ONE line from the file verbatim and whole — "@@ export function greet(name: string): string {", not a fragment like "@@ function greet(" — it is matched against an entire line
  - the hunk body starts at the line AFTER it, so do not restate the anchored line as the hunk's first context line
  - the cursor only moves forward: each "@@" must sit at or after the previous hunk's, so do not repeat one function signature across several hunks — give each its own nearby anchor, or a bare "@@"

Example:

*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-    print("Hi")
+    print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch

Rules:
- Batch related edits into ONE call. When a change touches several files, put every file section in a single patch instead of making one apply_patch call per file — it is atomic and cheaper. Only split into separate calls when a later edit genuinely depends on the result of an earlier one.
- Typical flow for a multi-file change: map the targets with Grep/Glob, Read every one of them in ONE message (parallel Read calls), then send ONE patch. Reading them one at a time is what turns a single patch into N patches.
- The patch is all-or-nothing, so before you send it: Read every file you Update or Delete, give each file exactly ONE section, and anchor each hunk on lines you copied from the file (not remembered) — a single unread file, duplicate section, or mismatched context rejects the entire batch. When a call is rejected it lists every problem it found at once; fix them all before resubmitting rather than one at a time.
- You MUST read a file (with the Read tool) before you Update or Delete it, and the read must COVER what you change: a hunk anchored on lines outside the range you read is refused, and a Delete needs the whole file. A range read is fine when it contains the hunk; otherwise read the whole file (view='full'). Add does not require a prior read.
- Include enough context/"@@" anchors that each hunk matches a unique location.
- The patch is atomic: if any hunk fails to apply, no files are written.
- For new lines, always prefix them with "+", including when creating a file.
- To edit Jupyter notebooks (.ipynb), use the NotebookEdit tool instead.`
