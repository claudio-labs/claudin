import { describe, expect, test } from "bun:test";
import { commandLineBound } from "src/tools/shared/outputFilter/Bash/lineBound.js";

// Commands the floor cap cut in the real corpus of 2026-09-14..25 (team memory
// `cut-results-request-cost-2026-09-25`), verbatim but for absolute paths made
// relative and one directory renamed off the upstream codename. Each was
// followed, in its thread, by a Read of the file it printed or by the same read
// again.
const RECORDED: readonly (readonly [string, number])[] = [
  ["sed -n 1,80p scripts/migrations/break-probe.ts", 80],
  ["sed -n 95,135p src/platform/main/lifecycle.ts; sed -n 279,310p src/platform/settings/settings.ts", 41 + 32],
  ["sed -n '210,290p;525,545p;625,660p;735,760p' src/permissions/permissions.ts", 81 + 21 + 36 + 26],
  [
    `sed -n '1,20p;296,320p' /tmp/pr198.md; echo "=====TAIL====="; sed -n '360,420p' /tmp/pr198.md`,
    20 + 25 + 1 + 61,
  ],
  ["git show 2d6b8d7e^:src/permissions/yoloClassifier/classifierConfig.ts | sed -n '40,130p'", 91],
  ["sed -n 1,200p src/agent/tools/toolInputPlaceholders.ts | grep -v '^\\s*//' | head -120", 120],
  [
    'grep -n "export function matchingRuleForInput" -A 60 src/permissions/filePermissions/rulePatterns.ts | head -90',
    90,
  ],
  [
    'head -60 docs/tech/upstream-census/gate-audit.md; echo ...; grep -c "FUNCIONA\\|QUEBRA\\|INERTE" docs/tech/upstream-census/gate-audit.md',
    60 + 1 + 1,
  ],
  ["cd .claudin/worktrees/audit; sed -n 130,145p src/tools/AgentTool/AgentTool.tsx", 16],
  [`awk 'NR>=246330 && NR<=246480 {print NR": "substr($0,1,300)}' /tmp/cc-strings.txt`, 151],
  ["cat src/shared/semver.ts | head -80", 80],
  ["git show main:src/permissions/permissionSetup.ts | sed -n '240,345p'", 106],
  [
    "d=~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/dashmap-6.2.1; sed -n '60,80p;720,745p;1030,1060p;1148,1165p' $d/src/lib.rs",
    21 + 26 + 31 + 18,
  ],
  [
    'cd src/__tests__ && for f in bugfixes.test.ts providerCounts.test.ts security-hardening.test.ts barrelSurface.test.ts lazyToolImports.test.ts lazyToolModuleLoad.test.ts; do echo "=== $f"; sed -n \'1,22p\' "$f"; echo; done',
    6 * (1 + 22 + 1),
  ],
  ["sed -n '1,60p' src/stubs/test-preload.ts | cut -c1-160", 60],
];

describe("commandLineBound — the reads the cap cut in the corpus", () => {
  for (const [command, lines] of RECORDED) {
    test(command, () => {
      expect(commandLineBound(command)).toBe(lines);
    });
  }
});

describe("commandLineBound — each bounded shape", () => {
  test.each([
    // sed: ranges, single lines, repeated -e, run-together flags, one stream across files
    ["sed -n 12p a.ts", 1],
    ["sed -n -e 1,5p -e 10,12p a.ts", 5 + 3],
    ["sed -ne '5,9p' a.ts", 5],
    ["sed -nE '1,4p' a.ts", 4],
    ["sed -n 1,30p a.ts b.ts", 30],
    ["sed -n 40,12p a.ts", 1],
    ["sed -n -s 1,10p a.ts b.ts", 20],
    // head / tail
    ["head -40 a.ts", 40],
    ["head -n 40 a.ts", 40],
    ["head -n40 a.ts", 40],
    ["tail -n 25 build.log", 25],
    ["tail -25 build.log", 25],
    ["head -n 20 a.ts b.ts", 2 * (20 + 2)],
    // awk NR programs
    ["awk 'NR>=20&&NR<=35' src/a.ts", 16],
    ["awk 'NR>5 && NR<10' a.ts", 4],
    ["awk 'NR==10,NR==20' a.ts", 11],
    ["awk 'NR<=30' a.ts", 30],
    ["awk 'NR<30 {print}' a.ts", 29],
    // a pipeline into a bound, fed by a file print, a search or a range print
    ["nl -ba src/a.ts | sed -n '10,90p'", 81],
    ["rg -n foo src | head -50", 50],
    ["grep -rn foo src | grep -v test | head -40", 40],
    ["git show HEAD~2:src/a.ts | head -n 70", 70],
    // glue around a read
    ["wc -l a.ts b.ts; head -30 a.ts", 3 + 30],
    ["cd src && sed -n 1,10p a.ts", 10],
    ["printf '=== a ===\\n'; sed -n 1,10p a.ts", 2 + 10],
    ["sed -n 1,5p a.ts 2>/dev/null", 5],
    ["sed -n 1,5p a.ts || sed -n 1,5p b.ts", 10],
    ["sed -n 1,5p a.ts\nsed -n 1,5p b.ts", 10],
    // what may follow the bound: lines dropped or reshaped, never added
    ["sed -n 1,5p a.ts | cat", 5],
    ["head -2 a.ts | cut -c1-80", 2],
    ["sed -n 1,200p a.ts | grep -v '^//' | head -120 | sort | uniq", 120],
    // head and tail with no count print ten
    ["head src/a.ts", 10],
    ["grep -rln foo src | head", 10],
    // a directory the shell fills in, and a loop over literal words
    ["P=/tmp/pr251; sed -n 480,490p $P/docs/security.md", 11],
    ["head -30 $DIR/a.ts", 30],
    ["sed -n 1,5p a.ts 2>/dev/null || true", 5],
    ["for f in a.ts b.ts; do head -5 $f; done", 10],
    ['for f in a.ts b.ts; do echo "== $f"; for n in 1 2 3; do sed -n 1,2p "$f"; done; done', 2 * (1 + 3 * 2)],
  ] as const)("%s → %d", (command, lines) => {
    expect(commandLineBound(command)).toBe(lines);
  });
});

describe("commandLineBound — no bound, so the cap keeps its say", () => {
  test.each([
    // a whole file, a loop, a listing: what the cap exists for
    ["cat src/a.ts"],
    ['for f in src/*.ts; do echo "=== $f"; cat $f; done'],
    ["git ls-files && cat README.md package.json"],
    ["ls src | head -50"],
    ["grep -rn foo src"],
    // head/tail that do not bound lines
    ["tail -n +15 a.ts"],
    ["head -n -5 a.ts"],
    ["head -c 1500 a.ts"],
    ["tail -f build.log"],
    ["head -80 src/*.ts"],
    ["head -n 20 $FILES"],
    // sed that prints by pattern, to the end, everything, or edits
    ["sed -n '/export/p' a.ts"],
    ["sed -n '10,$p' a.ts"],
    ["sed -n '/start/,/end/p' a.ts"],
    ["sed -n '1,20p;/TODO/p' a.ts"],
    ["sed 1,80p a.ts"],
    ["sed -i 's/a/b/' a.ts"],
    ["sed -n -s 1,10p src/*.ts"],
    ["sed -n 1,80p"],
    // awk beyond an NR range and a print
    ["awk '{print}' a.ts"],
    ["awk 'NR==20,NR==10' a.ts"],
    [`awk 'NR>=1 && NR<=5 {system("rm x")}' a.ts`],
    [`awk 'NR>=1 && NR<=5 {print > "out"}' a.ts`],
    [`awk 'NR<=5 {print; n++}' a.ts`],
    [`awk 'NR<=5 {print system("rm x")}' a.ts`],
    // any other producer into a bound: the corpus shows no excess there
    ["bun test | head -100"],
    ["gh run view 1 --log-failed | sed -n '12570,12680p'"],
    ["find src -name '*.ts' | sort | sed -n '16,90p'"],
    ["git show HEAD | head -80"],
    // one unbounded pipeline sinks the whole command
    ['head -60 doc.md; grep -o "X" doc.md | sort | uniq -c'],
    ["cat a.ts | head -5 b.ts"],
    // after the bound, only what cannot add lines
    ["sed -n 1,5p a.ts | grep -o x"],
    ["sed -n 1,5p a.ts | grep x b.ts"],
    ["sed -n 1,5p a.ts | sed 's/a/b/'"],
    ["grep -rn foo src | head -5 | xargs cat"],
    // a loop whose passes cannot be counted, or whose output goes elsewhere
    ["for f in src/*.ts; do sed -n 1,5p $f; done"],
    ["for f in $FILES; do sed -n 1,5p $f; done"],
    ["for f in a.ts b.ts; do sed -n 1,5p $f; done | head -3"],
    ["cat a.ts | for f in b.ts; do sed -n 1,5p $f; done"],
    ["for f in a.ts b.ts; do cat $f; done"],
    ["sed -n 1,5p a.ts; for f in b.ts; do sed -n 1,5p $f"],
    ["sed -n 1,5p a.ts | cat b.ts"],
    // a search in the glue: only `grep -c` prints a line per file
    ["grep -i foo a.ts; sed -n 1,5p a.ts"],
    ["grep -rc foo src; sed -n 1,5p a.ts"],
    // where the output goes, or what the shell would run first
    ["sed -n 1,80p a.ts > out.txt"],
    ["grep -n foo a.ts 2>&1 | head -40"],
    ['sed -n "$(cat range)p" a.ts'],
    ["sed -n 1,5p a.ts; echo `date`"],
    ["(sed -n 1,5p a.ts)"],
    ["cd $HOME && sed -n 1,5p a.ts"],
    // no read at all
    ["echo hello"],
    ["cd src"],
    ["wc -l a.ts b.ts"],
  ] as const)("%s", (command) => {
    expect(commandLineBound(command)).toBeNull();
  });
});
