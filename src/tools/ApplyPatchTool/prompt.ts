export const APPLY_PATCH_TOOL_NAME = 'apply_patch'

// IMPORTANT — cache safety: this description is serialized into the `tools`
// block, which is the head of the cached request prefix and carries no
// cache_control marker of its own. toolToAPISchema (src/utils/api.ts) freezes
// it per session, so it MUST be a static module-level constant — never
// interpolate dates, cwd, model id, git state, or per-turn flags. Any byte
// change here invalidates the whole downstream prompt cache.
// See docs/tech/cache/clip-frontier-breakpoint.md + src/utils/toolSchemaCache.ts.
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

Inside an Update section, changes are grouped into hunks. Each hunk begins with a "@@" line that names enough surrounding context (e.g. a function signature) to locate it, followed by the change lines:
  - a leading space (" ") marks an unchanged context line, present to anchor the hunk
  - a leading "-" marks a removed line
  - a leading "+" marks an added line
A hunk may end with "*** End of File" to anchor it to the end of the file.

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
- You MUST read a file (with the Read tool) before you Update or Delete it. Add does not require a prior read.
- Include enough context/"@@" anchors that each hunk matches a unique location.
- The patch is atomic: if any hunk fails to apply, no files are written.
- For new lines, always prefix them with "+", including when creating a file.
- To edit Jupyter notebooks (.ipynb), use the NotebookEdit tool instead.`
