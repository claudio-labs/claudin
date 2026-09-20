// system family — process/disk/network introspection and the shell's own
// utilities: ps aux, top, journalctl, ping, rsync, tree, ssh, df, du, dmesg,
// stat, jq and find.
import { describe, expect, test } from "bun:test";
import {
  loadSample,
  runFilterBody,
  assertReduction,
  findFilterForCommand,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/harness.js";

describe("phase 6.1.2 — psAux", () => {
  test("ROI: ps-aux sample reduces ≥ 88%", () => {
    assertReduction("ps-aux", "ps aux", "ps-aux", 88);
  });

  test("safety: user processes are preserved", () => {
    const raw = loadSample("ps-aux");
    const body = runFilterBody("ps-aux", "ps aux", raw);
    // The header is always the first line of `ps aux` output.
    expect(body.split("\n")[0]).toMatch(/USER\s+PID/);
  });

  test("match: ps aux ✓; ps -ef ✓ (both common)", () => {
    expect(findFilterForCommand("ps aux")?.name).toBe("ps-aux");
    expect(findFilterForCommand("ps -ef")?.name).toBe("ps-aux");
  });
});

describe("phase 6.1.2 — top", () => {
  test("ROI: top-bn1 sample reduces ≥ 47%", () => {
    assertReduction("top", "top -bn1", "top-bn1", 47);
  });

  test("safety: top's multi-line header is preserved", () => {
    const raw = loadSample("top-bn1");
    const body = runFilterBody("top", "top -bn1", raw);
    // `top` always prints `top - HH:MM:SS up ...` as line 1.
    expect(body.split("\n")[0]).toMatch(/^top\s+-\s+\d/);
  });

  test("match: top -bn1 ✓; plain 'top' ✗ (interactive)", () => {
    expect(findFilterForCommand("top -bn1")?.name).toBe("top");
    expect(findFilterForCommand("top")?.name).not.toBe("top");
  });
});

// ---------------------------------------------------------------------------
// Phase 6.1.5 — system extend: journalctl
// ---------------------------------------------------------------------------

describe("phase 6.1.5 — journalctl", () => {
  test("ROI: journalctl sample ≥10% reduction", () => {
    assertReduction("journalctl", "journalctl -u systemd-logind", "journalctl", 10);
  });

  test("match: journalctl -u systemd-logind", () => {
    expect(findFilterForCommand("journalctl -u systemd-logind")?.name).toBe("journalctl");
  });

  test("match: sudo journalctl -n 50", () => {
    expect(findFilterForCommand("sudo journalctl -n 50")?.name).toBe("journalctl");
  });

  test("reject: journalctl --output=json", () => {
    expect(findFilterForCommand("journalctl --output=json")).toBeNull();
  });

  test("reject: journalctl -o json", () => {
    expect(findFilterForCommand("journalctl -o json")).toBeNull();
  });

  test("reject: journalctl --output=cat", () => {
    expect(findFilterForCommand("journalctl --output=cat")).toBeNull();
  });

  test("reject: journalctl -f (follow)", () => {
    expect(findFilterForCommand("journalctl -f")).toBeNull();
  });

  test("reject: journalctl --follow", () => {
    expect(findFilterForCommand("journalctl --follow")).toBeNull();
  });

  test("reject: journalctl --machine=host1 (hostname is informative)", () => {
    expect(findFilterForCommand("journalctl --machine=host1")).toBeNull();
  });

  test("strips hostname from log lines", () => {
    const raw = "May 05 12:18:04 dev-arch systemd-logind[726]: Watching system buttons\nMay 05 12:22:44 dev-arch systemd-logind[726]: System is rebooting.\n";
    const body = runFilterBody("journalctl", "journalctl -u systemd-logind", raw);
    expect(body).not.toContain("dev-arch");
    expect(body).toContain("May 05 12:18:04");
    expect(body).toContain("systemd-logind[726]: Watching");
  });

  test("strips boot markers", () => {
    const raw = "May 05 12:22:49 dev-arch systemd[1]: Stopped service.\n-- Boot ed3041156fb04270ae0d53e7892c949b --\nMay 05 12:23:37 dev-arch systemd[1]: Starting service.\n";
    const body = runFilterBody("journalctl", "journalctl -u systemd", raw);
    expect(body).not.toContain("-- Boot ed3041");
    expect(body).toContain("Stopped service.");
    expect(body).toContain("Starting service.");
  });

  test("strips no-entries marker", () => {
    const raw = "-- No entries --\n";
    const body = runFilterBody("journalctl", "journalctl -u unknown-service", raw);
    expect(body).not.toContain("-- No entries --");
  });
});

// ---------------------------------------------------------------------------
// Phase 9 — system utilities (ping/rsync/tree/ssh/df/du/dmesg/stat/jq + curl-plain)
// ---------------------------------------------------------------------------

describe("phase 9 — ping", () => {
  test("ROI: ping-google sample reduces ≥ 55%", () => {
    assertReduction("ping", "ping -c 20 8.8.8.8", "ping-google", 55);
  });

  test("safety: --- statistics --- and rtt are preserved", () => {
    const raw = loadSample("ping-google");
    const body = runFilterBody("ping", "ping -c 20 8.8.8.8", raw);
    expect(body).toContain("--- 8.8.8.8 ping statistics ---");
    expect(body).toMatch(/^rtt min\/avg\/max/m);
  });

  test("match: ping ✓; ping6 ✓; pinger ✗", () => {
    expect(findFilterForCommand("ping example.com")?.name).toBe("ping");
    expect(findFilterForCommand("ping6 ::1")?.name).toBe("ping");
    expect(findFilterForCommand("pinger foo")?.name).not.toBe("ping");
  });

  // Corner-case audit P0: `ping -f` (flood) and other modes can emit lines
  // far exceeding terminal width. Verify truncateLineAt clamps them.
  test("defense: pathologically long lines are truncated (P0)", () => {
    const longLine = "x".repeat(5000);
    const raw = `PING host\n${longLine}\n--- statistics ---\n`;
    const body = runFilterBody("ping", "ping -f host", raw);
    expect(body).toContain("…");
    expect(body.split("\n").every((l) => l.length <= 4097)).toBe(true);
  });
});

describe("phase 9 — rsync", () => {
  test("ROI: rsync-incremental sample reduces ≥ 70%", () => {
    assertReduction("rsync", "rsync -av src/ dst/", "rsync-incremental", 70);
  });

  test("safety: summary lines are preserved", () => {
    const raw = loadSample("rsync-incremental");
    const body = runFilterBody("rsync", "rsync -av src/ dst/", raw);
    expect(body).toMatch(/sent .* received .* bytes/);
    expect(body).toContain("total size is");
    expect(body).toContain("speedup is");
  });

  test("safety: error lines are preserved (not stripped as filename)", () => {
    const raw = [
      "sending incremental file list",
      "file-1.txt",
      "rsync: failed to set permissions on \"/dst/locked\": Permission denied (13)",
      "rsync error: some files could not be transferred (code 23) at main.c:1234",
      "",
      "sent 100 bytes  received 50 bytes  300.00 bytes/sec",
      "total size is 1024  speedup is 6.83",
    ].join("\n");
    const body = runFilterBody("rsync", "rsync -av src/ dst/", raw);
    expect(body).toContain("rsync: failed to set permissions");
    expect(body).toContain("rsync error:");
  });

  test("match: rsync ✓; rsyncd ✗", () => {
    expect(findFilterForCommand("rsync -av a/ b/")?.name).toBe("rsync");
    expect(findFilterForCommand("rsyncd --daemon")?.name).not.toBe("rsync");
  });

  // Corner-case audit P1: `rsync --info=progress2` emits a single-line
  // progress meter that `\r`-overwrites itself, identical to curl's progress
  // bar. The CR-collapse pass reduces it to the final summary line.
  test("defense: --info=progress2 CR-overwrites collapse (P1)", () => {
    const raw = [
      "sending incremental file list",
      // 5 progress frames separated by \r — only the last should survive
      "       1.00K   0%    0.00kB/s    0:00:01\r" +
        "      50.00K  50%   500.00kB/s    0:00:00\r" +
        "     100.00K 100%   1.00MB/s    0:00:00 (xfr#1, to-chk=0/1)",
      "",
      "sent 100,012 bytes  received 35 bytes  200,094.00 bytes/sec",
      "total size is 100,000  speedup is 1.00",
    ].join("\n");
    const body = runFilterBody("rsync", "rsync --info=progress2 a b", raw);
    // Intermediate progress frames are gone (only the post-`\r` final frame survives).
    expect(body).not.toContain("1.00K   0%");
    expect(body).not.toContain("50.00K  50%");
    expect(body).toContain("100.00K 100%");
    expect(body).toContain("speedup is 1.00");
  });
});

describe("phase 9 — tree", () => {
  test("ROI: tree-deep sample reduces ≥ 30%", () => {
    assertReduction("tree", "tree", "tree-deep", 30);
  });

  test("reject: tree -J passes through (structured output not corrupted)", () => {
    expect(findFilterForCommand("tree -J")).toBeNull();
    expect(findFilterForCommand("tree --json")).toBeNull();
    expect(findFilterForCommand("tree -X")).toBeNull();
    expect(findFilterForCommand("tree --xml")).toBeNull();
  });

  test("match: tree-sitter is not claimed", () => {
    // `tree-sitter` is a real dev binary — must not match our `tree` spec.
    expect(findFilterForCommand("tree-sitter parse foo.ts")?.name).not.toBe(
      "tree",
    );
  });

  test("match: tree ✓; tree -L 2 ✓", () => {
    expect(findFilterForCommand("tree")?.name).toBe("tree");
    expect(findFilterForCommand("tree -L 2 src")?.name).toBe("tree");
  });

  // Corner-case audit P0: a flat directory with one extremely long entry
  // (e.g. a 5 KB single-line file name) should be clamped, not passed
  // through verbatim.
  test("defense: pathologically long entry is truncated (P0)", () => {
    const longName = "x".repeat(5000);
    const raw = `.\n├── ${longName}\n└── normal.txt\n`;
    const body = runFilterBody("tree", "tree", raw);
    expect(body).toContain("…");
    expect(body.split("\n").every((l) => l.length <= 4097)).toBe(true);
    expect(body).toContain("normal.txt");
  });
});

describe("phase 9 — ssh", () => {
  test("ROI: ssh-vvv sample reduces ≥ 70% (debug lines stripped)", () => {
    assertReduction("ssh", "ssh -vvv example.com echo ok", "ssh-vvv", 70);
  });

  test("safety: non-debug lines (banner, output) are preserved", () => {
    const raw = loadSample("ssh-vvv");
    const body = runFilterBody("ssh", "ssh -vvv example.com echo ok", raw);
    expect(body).toContain("OpenSSH_10.3p1");
    // The remote command's actual output ("ok") must not be stripped.
    expect(body).toMatch(/\bok\b/);
  });

  test("match: ssh-add / ssh-keygen are not claimed", () => {
    expect(findFilterForCommand("ssh-add -l")?.name).not.toBe("ssh");
    expect(findFilterForCommand("ssh-keygen -t ed25519")?.name).not.toBe("ssh");
  });
});

describe("phase 9 — df", () => {
  test("ROI: df-h sample reduces ≥ 40%", () => {
    assertReduction("df", "df -h", "df-h", 40);
  });

  test("safety: header + real-disk rows are preserved", () => {
    const raw = loadSample("df-h");
    const body = runFilterBody("df", "df -h", raw);
    expect(body.split("\n")[0]).toMatch(/^Filesystem\s+.*Mounted on/);
    expect(body).toContain("/dev/sdb4");
    expect(body).toContain("/dev/sdb3");
  });

  test("safety: tmpfs / fuse / squashfs rows are stripped", () => {
    const raw = loadSample("df-h");
    const body = runFilterBody("df", "df -h", raw);
    expect(body).not.toMatch(/^tmpfs/m);
    expect(body).not.toMatch(/^devtmpfs/m);
    expect(body).not.toMatch(/^squashfs/m);
    expect(body).not.toMatch(/^fuse\./m);
  });

  // Audit-2026-05 finding A3 — overlay rows carry real docker disk-usage
  // signal and MUST be preserved (regression test).
  test("safety: overlay rows are preserved (docker disk-usage signal)", () => {
    const raw = loadSample("df-h");
    const body = runFilterBody("df", "df -h", raw);
    expect(body).toMatch(/^overlay/m);
    expect(body).toContain("/var/lib/docker/overlay2");
  });

  test("reject: df -a / df --all pass through (user wants tmpfs)", () => {
    expect(findFilterForCommand("df -a")).toBeNull();
    expect(findFilterForCommand("df --all -h")).toBeNull();
  });
});

describe("phase 9 — du", () => {
  test("safety: top-level + shallow subdir totals are preserved", () => {
    const raw = loadSample("du-noisy");
    const body = runFilterBody("du", "du -h", raw);
    expect(body).toContain("./src");
    expect(body).toContain("./node_modules");
    // Final "total" line (just "." with size) must survive.
    expect(body).toMatch(/^\S+\s+\.$/m);
  });

  test("safety: nested node_modules/.../node_modules/ subdirs are stripped", () => {
    const raw = loadSample("du-noisy");
    const body = runFilterBody("du", "du -h", raw);
    expect(body).not.toContain("/lodash/node_modules/isarray");
    expect(body).not.toContain("/react/node_modules/scheduler");
  });

  test("safety: .git/refs and .git/objects subdirs are stripped", () => {
    const raw = loadSample("du-noisy");
    const body = runFilterBody("du", "du -h", raw);
    expect(body).not.toContain(".git/refs/heads");
    expect(body).not.toContain(".git/objects/00");
  });

  test("match: du ✓; du -h ✓; du-meta ✗", () => {
    expect(findFilterForCommand("du -h")?.name).toBe("du");
    expect(findFilterForCommand("du -sh src")?.name).toBe("du");
    expect(findFilterForCommand("du-meta")?.name).not.toBe("du");
  });
});

describe("phase 9 — dmesg", () => {
  test("ROI: dmesg-long sample reduces ≥ 25% (tail of 60 lines)", () => {
    assertReduction("dmesg", "dmesg", "dmesg-long", 25);
  });

  test("safety: most-recent lines are kept (the ones with high timestamps)", () => {
    const raw = loadSample("dmesg-long");
    const body = runFilterBody("dmesg", "dmesg", raw);
    expect(body).toContain("nf_conntrack: table full");
    expect(body).toContain("New session 1");
  });

  // Audit-2026-05 finding A4 — `dmesg` is used to debug boot/hardware
  // enumeration; the first kernel lines (BIOS-e820, PCI, ACPI) carry the
  // signal and must survive even when the buffer is huge.
  test("safety: boot-time lines are kept (head=10) — A4 regression", () => {
    const raw = loadSample("dmesg-long");
    const body = runFilterBody("dmesg", "dmesg", raw);
    expect(body).toContain("Linux version 6.18");
    expect(body).toContain("BIOS-e820");
  });

  test("match: dmesg ✓; dmesg -T ✓", () => {
    expect(findFilterForCommand("dmesg")?.name).toBe("dmesg");
    expect(findFilterForCommand("dmesg -T")?.name).toBe("dmesg");
  });

  // Corner-case audit P0: `dmesg --color=always` injects CSI codes even
  // when output isn't a TTY. Filter must strip them so they don't bloat
  // the budget or confuse downstream readers.
  test("defense: ANSI color codes from --color=always are stripped (P0)", () => {
    const raw =
      "\x1b[33m[    0.000000]\x1b[0m Linux version 6.18\n" +
      "\x1b[31m[   12.345678] error: something\x1b[0m\n";
    const body = runFilterBody("dmesg", "dmesg --color=always", raw);
    expect(body).not.toContain("\x1b[");
    expect(body).toContain("Linux version 6.18");
    expect(body).toContain("error: something");
  });
});

describe("phase 9 — stat", () => {
  test("safety: short stat output passes through under cap", () => {
    const raw = loadSample("stat-file");
    const body = runFilterBody("stat", "stat package.json", raw);
    // Under maxLines=40 — body should be ~identical.
    expect(body).toContain("File:");
    expect(body).toContain("Inode:");
  });

  test("match: stat ✓; statfs (gnu utility) ✗", () => {
    expect(findFilterForCommand("stat foo")?.name).toBe("stat");
    // No exact other binary collides today, but anchor still must hold.
    expect(findFilterForCommand("stat-other")?.name).not.toBe("stat");
  });
});

describe("phase 9 — jq", () => {
  test("safety: jq-pretty-deep sample is preserved verbatim", () => {
    const raw = loadSample("jq-pretty-deep");
    const body = runFilterBody("jq", "jq '.'", raw);
    expect(body).toContain('"name": "claudin"');
    expect(body).toContain('"nested"');
  });

  // Audit-2026-05 finding A1 — `jq` output is structured data. Truncating
  // mid-object yields invalid JSON the LLM cannot parse. Verify the filter
  // never injects an omit marker even on large pretty-printed JSON.
  test("safety: large pretty-printed JSON is not truncated (A1 regression)", () => {
    // Synthesize a >200-line pretty JSON object — much larger than the old
    // maxLines=100 cap.
    const keys: string[] = [];
    for (let i = 0; i < 200; i++) keys.push(`  "key_${i}": ${i}`);
    const raw = `{\n${keys.join(",\n")}\n}`;
    const body = runFilterBody("jq", "jq '.'", raw);
    // No omit marker — JSON structure remains parseable.
    expect(body).not.toMatch(/lines omitted/);
    expect(body).toContain('"key_0": 0');
    expect(body).toContain('"key_199": 199');
    // Final closing brace survives.
    expect(body.trimEnd().endsWith("}")).toBe(true);
    // Result is valid JSON.
    expect(() => JSON.parse(body)).not.toThrow();
  });

  test("reject: jq -r passes through (structured output to downstream)", () => {
    expect(findFilterForCommand("jq -r .name")).toBeNull();
    expect(findFilterForCommand("jq --raw-output .name")).toBeNull();
    expect(findFilterForCommand("jq -c .")).toBeNull();
    expect(findFilterForCommand("jq --compact-output .")).toBeNull();
    expect(findFilterForCommand("jq -j .name")).toBeNull();
    expect(findFilterForCommand("jq --join-output .name")).toBeNull();
    expect(findFilterForCommand("jq --tab .")).toBeNull();
  });

  test("match: jq ✓; jq '.foo' ✓", () => {
    expect(findFilterForCommand("jq '.'")?.name).toBe("jq");
    expect(findFilterForCommand("jq .foo")?.name).toBe("jq");
  });

  // Corner-case audit P0 C1: the original A1 fix removed *all* caps to avoid
  // mid-object truncation, but that left jq unbounded — a 50k-line JSON
  // would either flood the LLM context or be tail-truncated by the global
  // pipeline cap (also invalid JSON, just less obviously). The
  // 500-line cap with explicit head/tail marker is the documented
  // compromise: outputs over the cap emit a clear "lines omitted" marker
  // that the LLM can recognize as truncated.
  test("safety: huge JSON over 500 lines is bounded with omit marker (P0 C1)", () => {
    const keys: string[] = [];
    for (let i = 0; i < 800; i++) keys.push(`  "key_${i}": ${i}`);
    const raw = `{\n${keys.join(",\n")}\n}`;
    const body = runFilterBody("jq", "jq '.'", raw);
    expect(body).toMatch(/lines omitted/);
    expect(body).toContain('"key_0": 0');
    expect(body).toContain('"key_799": 799');
    // First 200 + marker + last 300 ≈ 501 lines.
    expect(body.split("\n").length).toBeLessThan(550);
  });
});

describe("phase 10 — find", () => {
  test("ROI: find-large sample reduces ≥ 40% (cap kicks in)", () => {
    assertReduction("find", "find . -type f", "find-large", 40);
  });

  test("safety: head and tail entries both survive truncation", () => {
    const raw = loadSample("find-large");
    const body = runFilterBody("find", "find . -type f", raw);
    const firstLine = raw.split("\n")[0]!;
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const lastLine = lines[lines.length - 1]!;
    expect(body).toContain(firstLine);
    expect(body).toContain(lastLine);
  });

  test("safety: small find output passes through unchanged", () => {
    const raw = "./a.ts\n./b.ts\n./c.ts";
    const body = runFilterBody("find", "find . -name '*.ts'", raw);
    // Strict equality catches over-eager stripping; whitespace/EOL normalization
    // by the framework is acceptable so we compare trimmed.
    expect(body.trim()).toBe(raw.trim());
  });

  // Permission-denied stderr lines are commonly merged into stdout; they
  // identify dirs the search couldn't enter and must reach the model.
  test("safety: 'Permission denied' lines survive head/tail cap", () => {
    const denied = "find: '/root/.cache': Permission denied";
    const filler = Array.from({ length: 200 }, (_, i) => `./pkg/file${i}.ts`).join("\n");
    const raw = `${denied}\n${filler}`;
    const body = runFilterBody("find", "find / -type f", raw);
    expect(body).toContain(denied);
  });

  // Zero-match case: find prints nothing. Filter must not crash and the
  // empty output must pass through (trimmed/empty equivalent).
  test("safety: empty output passes through cleanly", () => {
    const body = runFilterBody("find", "find . -name 'no-such-file'", "");
    expect(body.trim()).toBe("");
  });

  test("match: find ✓; findutils ✗", () => {
    expect(findFilterForCommand("find . -type f")?.name).toBe("find");
    expect(findFilterForCommand("findutils --version")?.name).not.toBe("find");
  });

  test("reject: -printf / -print0 / -exec / -ls pass through (format-changing)", () => {
    expect(findFilterForCommand("find . -printf '%p\\n'")).toBeNull();
    expect(findFilterForCommand("find . -print0")).toBeNull();
    expect(findFilterForCommand("find . -type f -exec wc -l {} +")).toBeNull();
    expect(findFilterForCommand("find . -execdir cat {} \\;")).toBeNull();
    expect(findFilterForCommand("find . -ls")).toBeNull();
    expect(findFilterForCommand("find . -fprint out.txt")).toBeNull();
  });

  // Defense P0: a single 5 KB filename should be clamped, not pass through
  // verbatim (clobbers terminal width assumptions downstream).
  test("defense: pathologically long path is truncated (P0)", () => {
    const longPath = "./" + "x".repeat(5000) + ".txt";
    const raw = `${longPath}\n./normal.txt\n`;
    const body = runFilterBody("find", "find .", raw);
    expect(body).toContain("…");
    expect(body.split("\n").every((l) => l.length <= 4097)).toBe(true);
    expect(body).toContain("./normal.txt");
  });
});
