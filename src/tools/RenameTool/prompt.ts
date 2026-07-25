export const RENAME_TOOL_NAME = 'Rename'

export const DESCRIPTION = `Renames an identifier across the whole project in one call, without reading the files into context.

Use this instead of hand-writing N Edit/Patch hunks whenever the same name has to change in more than a couple of places.

How it finds sites:
- ripgrep narrows the tree, then each candidate file is matched on a whole-word boundary, so \`cfgX\` and \`my_cfg\` are never touched when renaming \`cfg\`.
- Occurrences inside strings and comments are dropped, using the same per-language analysis that powers Read's outline. A reference inside an interpolated expression counts as code and IS renamed; where the analysis cannot tell, the occurrence is reported as skipped, never renamed silently.
- A file marked \`~\` got NO such analysis (unsupported language, or too large to parse), so every occurrence in it is renamed — comments and strings included. Preview first when \`~\` appears; an apply names those files in its result.
- This is textual, not semantic: a same-named symbol from an unrelated module WILL be listed. When the scope is at all risky, preview first.

Modes:
- \`mode:"apply"\` (default) renames every site in one atomic batch — if any file fails, all of them are rolled back.
- \`mode:"preview"\` writes nothing and returns the sites grouped by file and by enclosing symbol, in the same \`start-end signature\` form as Read's outline (so you can follow up with Read(file_path, symbol=…)), plus a \`sitesToken\`.

To skip specific sites: run \`mode:"preview"\`, then apply with \`exclude:["s03","s07"]\` and the \`sitesToken\` from that preview. The token is refused if any site moved in between — re-preview and pick again.

Scope it with \`scope\` (ripgrep globs, e.g. "src/**/*.ts") when the name is common.`
