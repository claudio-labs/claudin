/**
 * One-shot ROI measurement for the Bash output filter.
 *
 * Runs as a Bun test so the existing module-resolution context applies
 * (the bare-bun runner can't resolve some `src/...` imports that pull
 * in analytics). The "test" always passes — it exists to print a table
 * of byte/line reduction per fixture, then a grand total.
 *
 * Usage:
 *   bun test scripts/measure-bash-filter-roi.test.ts
 */
import { test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import {
  applyBashFilterToStdout,
  planBashFilter,
} from "src/outputFilter/Bash/index.js";
import { builtInFilters } from "src/outputFilter/Bash/filters/index.js";
import type { FilterSpec } from "src/outputFilter/Bash/types.js";

const SAMPLES_DIR = resolve(
  import.meta.dir,
  "..",
  "src/outputFilter/Bash/__fixtures__/samples",
);

const FIXTURE_MAP: Record<string, [string, string]> = {
  "bundle-install": ["bundle-install", "bundle install"],
  "pytest-real": ["pytest", "pytest"],
  "pytest-clean": ["pytest", "pytest"],
  rspec: ["rspec", "bundle exec rspec"],
  "go-test": ["go-test", "go test -v ./..."],
  "jest-clean": ["jest", "jest"],
  "vitest-clean": ["vitest", "vitest"],
  "bun-test": ["bun-test", "bun test"],
  "bun-test-clean": ["bun-test", "bun test"],
  "mocha-clean": ["mocha", "mocha"],
  "playwright-clean": ["playwright-test", "playwright test"],
  "tsc-errors": ["tsc", "tsc --noEmit"],
  "ps-aux": ["ps-aux", "ps aux"],
  "top-bn1": ["top", "top -b -n 1"],
  rubocop: ["rubocop", "rubocop"],
  ruff: ["ruff-check", "ruff check ."],
  "ruff-clean": ["ruff-check", "ruff check ."],
  "ls-la": ["ls-la", "ls -la"],
  rg: ["grep-rg", "rg foo"],
  "rg-relative": ["grep-rg", "rg foo"],
  grep: ["grep-rg", "grep -r foo ."],
  "git-log-default": ["git-log", "git log"],
  "git-status": ["git-status", "git status"],
  "git-blame": ["git-blame", "git blame README.md"],
  "git-pull-synthetic": ["git-pull", "git pull"],
  "git-diff": ["git-diff", "git diff"],
  "git-show-full": ["git-show", "git show HEAD"],
  "gh-pr-list": ["gh-pr-list", "gh pr list"],
  "gh-issue-list": ["gh-issue-list", "gh issue list"],
  "gh-run-list": ["gh-run-list", "gh run list"],
  "cargo-build": ["cargo-build", "cargo build"],
  "cargo-check": ["cargo-check", "cargo check"],
  "cargo-test-norun": ["cargo-test", "cargo test --no-run"],
  "cargo-clippy": ["cargo-clippy", "cargo clippy"],
  "docker-ps": ["docker-ps", "docker ps"],
  "docker-images": ["docker-images", "docker images"],
  "docker-logs": ["docker-logs", "docker logs my-container"],
  "curl-v": ["curl-v", "curl -v https://example.com"],
  "curl-plain": ["curl-plain", "curl https://example.com"],
  dig: ["dig", "dig example.com"],
  journalctl: ["journalctl", "journalctl -xe"],
  "ping-google": ["ping", "ping -c 50 google.com"],
  "rsync-incremental": ["rsync", "rsync -avP src/ dst/"],
  "tree-deep": ["tree", "tree ."],
  "ssh-vvv": ["ssh", "ssh -vvv host"],
  "df-h": ["df", "df -h"],
  df: ["df", "df"],
  "du-noisy": ["du", "du -sh /var/log"],
  du: ["du", "du -sh ."],
  "dmesg-long": ["dmesg", "dmesg"],
  "dmesg-tail": ["dmesg", "dmesg"],
  "stat-file": ["stat", "stat README.md"],
  "jq-pretty": ["jq", "jq . input.json"],
  "jq-pretty-deep": ["jq", "jq . input.json"],
  wget: ["wget", "wget https://example.com/big.tar.gz"],
  "find-large": ["find", "find . -type f"],
  find: ["find", "find . -type f"],
};

function getFilter(name: string): FilterSpec | undefined {
  return builtInFilters.find((s) => s.name === name);
}

test("Bash filter ROI report", () => {
  type Row = {
    fixture: string;
    filter: string;
    inBytes: number;
    outBytes: number;
    bytePct: number;
    inLines: number;
    outLines: number;
    linePct: number;
  };
  const rows: Row[] = [];
  const skipped: string[] = [];

  const fixtures = readdirSync(SAMPLES_DIR)
    .filter((f) => f.endsWith(".txt"))
    .map((f) => basename(f, ".txt"))
    .sort();

  for (const fx of fixtures) {
    const mapping = FIXTURE_MAP[fx];
    if (!mapping) {
      skipped.push(fx);
      continue;
    }
    const [filterName, command] = mapping;
    const filter = getFilter(filterName);
    if (!filter) {
      skipped.push(`${fx} (no filter '${filterName}')`);
      continue;
    }
    const raw = readFileSync(resolve(SAMPLES_DIR, `${fx}.txt`), "utf8");
    // Use the real plan so rewrite-bearing filters (gh-*, git-log, git-status)
    // see their effective command. The filter we pre-loaded is only used as a
    // sanity check to confirm registration; planBashFilter resolves it again.
    void filter;
    const plan = planBashFilter(command);
    const wrapped = applyBashFilterToStdout(raw, false, plan);
    // Strip the <bash-output-filtered …>BODY</bash-output-filtered> marker
    // so the % reduction reflects body shrinkage, not wrapper overhead.
    const m = wrapped.match(
      /^<bash-output-filtered\s[^>]*>([\s\S]*)<\/bash-output-filtered>$/,
    );
    const out = m ? m[1]! : wrapped;
    const inBytes = Buffer.byteLength(raw, "utf8");
    const outBytes = Buffer.byteLength(out, "utf8");
    const inLines = raw.split("\n").length;
    const outLines = out.split("\n").length;
    rows.push({
      fixture: fx,
      filter: filterName,
      inBytes,
      outBytes,
      bytePct: inBytes === 0 ? 0 : (1 - outBytes / inBytes) * 100,
      inLines,
      outLines,
      linePct: inLines === 0 ? 0 : (1 - outLines / inLines) * 100,
    });
  }

  rows.sort((a, b) => b.bytePct - a.bytePct);

  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  const padR = (s: string | number, n: number) => String(s).padStart(n);

  const header =
    pad("fixture", 26) +
    pad("filter", 18) +
    padR("in B", 8) +
    padR("out B", 8) +
    padR("byte%", 8) +
    padR("in L", 7) +
    padR("out L", 7) +
    padR("line%", 8);
  console.log("\n" + header);
  console.log("-".repeat(90));

  for (const r of rows) {
    console.log(
      pad(r.fixture, 26) +
        pad(r.filter, 18) +
        padR(r.inBytes, 8) +
        padR(r.outBytes, 8) +
        padR(r.bytePct.toFixed(1) + "%", 8) +
        padR(r.inLines, 7) +
        padR(r.outLines, 7) +
        padR(r.linePct.toFixed(1) + "%", 8),
    );
  }

  const totalIn = rows.reduce((s, r) => s + r.inBytes, 0);
  const totalOut = rows.reduce((s, r) => s + r.outBytes, 0);
  const totalPct = totalIn === 0 ? 0 : (1 - totalOut / totalIn) * 100;
  console.log("-".repeat(90));
  console.log(
    `${rows.length} fixtures · total ${totalIn} B → ${totalOut} B · ${totalPct.toFixed(1)}% saved`,
  );
  if (skipped.length > 0) {
    console.log(`Skipped (no mapping): ${skipped.join(", ")}`);
  }
});
