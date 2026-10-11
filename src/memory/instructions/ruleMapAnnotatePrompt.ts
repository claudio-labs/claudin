/**
 * What a model is told when it fills in the navigation map's `← TODO`s — once,
 * so `/init` (Phase 4.5) and `/map annotate` cannot drift into two versions of
 * the one instruction that carries the risk: a map that misdirects is worse
 * than no map.
 */

export const RULE_MAP_ANNOTATE_INSTRUCTIONS = `What the file cannot derive is what each directory is *for*. That is your job
here, and it is the only part of it that is.

- **A generated map** carries \`<!-- claudin:module-map -->\` and reads \`← TODO\`
  on every entry nobody has explained. Replace each \`TODO\` with a short phrase
  naming the directory's job — six or seven words, the kind of thing that saves
  a search ("the HTTP handlers", "provider abstraction; start here for auth").
  Its tree and its \`(N)\` counts are redrawn on the next run, and the \`←\` text
  is keyed to the directory's full path and survives. Write only after the
  \`←\`: a line of your own inside the tree, or text beside an entry's count,
  stops the tree from being redrawn until it is moved.
- **A hand-written map** has no marker and no \`TODO\`s. Only its numbers are
  ever touched automatically — the tree is never restructured, because where a
  directory belongs in a curated tree is judgment. So here you may propose
  structural fixes too (a directory that no longer exists, one that is missing),
  but **propose them as a diff and let the user apply it**.

One rule outranks coverage in both cases.
**Only annotate what you actually read.**
A guess is worse than a \`TODO\` — the map decides where the next agent greps, so
an entry describing the wrong thing sends every future session to the wrong
directory, and no checker can catch that. Leave the rest alone.`

/** The `/map annotate` prompt: the map was synced a moment ago, so it exists. */
export function buildRuleMapAnnotatePrompt(mapPath: string): string {
  return `# Annotate the navigation map

\`${mapPath}\` was just synced from the tracked file list. Read it first.

${RULE_MAP_ANNOTATE_INSTRUCTIONS}

Finish with one line per directory you annotated, and say which entries you
left as \`TODO\` because you did not read them.`
}
