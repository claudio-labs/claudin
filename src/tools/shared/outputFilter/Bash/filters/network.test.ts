// network family — curl (verbose and plain), dig and wget.
import { describe, expect, test } from "bun:test";
import {
  loadSample,
  runFilterBody,
  assertReduction,
  findFilterForCommand,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/harness.js";

// ---------------------------------------------------------------------------
// Phase 6.1.5 — network specs
// ---------------------------------------------------------------------------

describe("phase 6.1.5 — curlV", () => {
  test("ROI: curl-v sample ≥50% reduction", () => {
    assertReduction("curl", "curl -v https://httpbin.org/get", "curl-v", 50);
  });

  test("match: curl -v https://example.com", () => {
    expect(findFilterForCommand("curl -v https://example.com")?.name).toBe("curl");
  });

  test("phase 9: curl https://example.com (no -v) is claimed by curl-plain, not curlV", () => {
    // Before phase 9, plain curl had no filter. The new curl-plain spec
    // (network.ts) covers it now — verify curl-plain wins, not curlV.
    expect(findFilterForCommand("curl https://example.com")?.name).toBe(
      "curl-plain",
    );
  });

  test("match: curl --verbose https://example.com", () => {
    expect(findFilterForCommand("curl --verbose https://example.com")?.name).toBe("curl");
  });

  test("reject: curl -s https://api.example.com", () => {
    expect(findFilterForCommand("curl -s https://api.example.com")).toBeNull();
  });

  test("reject: curl --silent https://api.example.com", () => {
    expect(findFilterForCommand("curl --silent https://api.example.com")).toBeNull();
  });

  test("reject: curl -I https://example.com", () => {
    expect(findFilterForCommand("curl -I https://example.com")).toBeNull();
  });

  test("reject: curl --head https://example.com", () => {
    expect(findFilterForCommand("curl --head https://example.com")).toBeNull();
  });

  test("strips TLS handshake lines", () => {
    const raw = "* TLSv1.3 (OUT), TLS handshake, Client hello (1):\n* TLSv1.2 (IN), TLS handshake, Certificate (11):\n* SSL certificate verify ok.\n> GET / HTTP/2\n< HTTP/2 200\n";
    const body = runFilterBody("curl", "curl -v https://example.com", raw);
    expect(body).not.toContain("TLSv1.3");
    expect(body).not.toContain("TLSv1.2");
    expect(body).toContain("> GET / HTTP/2");
    expect(body).toContain("< HTTP/2 200");
  });

  test("strips byte-count markers", () => {
    const raw = "} [1566 bytes data]\n{ [5 bytes data]\n> GET / HTTP/2\n";
    const body = runFilterBody("curl", "curl -v https://example.com", raw);
    expect(body).not.toContain("bytes data");
    expect(body).toContain("> GET / HTTP/2");
  });

  test("strips DNS/connection noise", () => {
    const raw = "* Host httpbin.org:443 was resolved.\n* IPv4: 44.199.179.5\n* Trying 44.199.179.5:443...\n* ALPN: curl offers h2,http/1.1\n* Connection #0 to host left intact\n< HTTP/2 200\n";
    const body = runFilterBody("curl", "curl -v https://httpbin.org/get", raw);
    expect(body).not.toContain("was resolved");
    expect(body).not.toContain("IPv4:");
    expect(body).not.toContain("Trying ");
    expect(body).not.toContain("ALPN:");
    expect(body).not.toContain("Connection #0");
    expect(body).toContain("< HTTP/2 200");
  });
});

describe("phase 6.1.5 — dig", () => {
  test("ROI: dig sample ≥40% reduction", () => {
    assertReduction("dig", "dig httpbin.org", "dig", 40);
  });

  test("match: dig example.com", () => {
    expect(findFilterForCommand("dig example.com")?.name).toBe("dig");
  });

  test("match: dig @8.8.8.8 example.com", () => {
    expect(findFilterForCommand("dig @8.8.8.8 example.com")?.name).toBe("dig");
  });

  test("reject: dig +short example.com", () => {
    expect(findFilterForCommand("dig +short example.com")).toBeNull();
  });

  test("reject: dig +nocomments example.com", () => {
    expect(findFilterForCommand("dig +nocomments example.com")).toBeNull();
  });

  test("strips semicolon comment lines", () => {
    const raw = "; <<>> DiG 9.20.22 <<>> example.com\n;; global options: +cmd\n;; Got answer:\nexample.com. 60 IN A 93.184.216.34\n";
    const body = runFilterBody("dig", "dig example.com", raw);
    expect(body).not.toContain("; <<>>");
    expect(body).not.toContain(";; global options");
    expect(body).toContain("example.com.");
  });
});

describe("phase 9 — curlPlain", () => {
  test("ROI: curl-plain sample reduces ≥ 40% (progress meter stripped)", () => {
    assertReduction("curl-plain", "curl http://example.com", "curl-plain", 40);
  });

  test("safety: response body is preserved", () => {
    const raw = loadSample("curl-plain");
    const body = runFilterBody("curl-plain", "curl http://example.com", raw);
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("Example Domain");
  });

  test("safety: progress meter headers are stripped", () => {
    const raw = loadSample("curl-plain");
    const body = runFilterBody("curl-plain", "curl http://example.com", raw);
    expect(body).not.toMatch(/% Total\s+% Received/);
    expect(body).not.toMatch(/Dload\s+Upload/);
  });

  test("match: curl ✓; curl -v claimed by curlV not curlPlain", () => {
    expect(findFilterForCommand("curl http://example.com")?.name).toBe(
      "curl-plain",
    );
    expect(findFilterForCommand("curl -v http://example.com")?.name).toBe(
      "curl",
    );
  });

  test("reject: -s / -I / -o pass through (no body or no progress)", () => {
    expect(findFilterForCommand("curl -s http://example.com")).toBeNull();
    expect(findFilterForCommand("curl --silent http://example.com")).toBeNull();
    expect(findFilterForCommand("curl -I http://example.com")).toBeNull();
    expect(findFilterForCommand("curl -o out.html http://example.com")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase 10 — wget + find
// ---------------------------------------------------------------------------

describe("phase 10 — wget", () => {
  test("ROI: wget sample reduces ≥ 70% (progress dots stripped)", () => {
    assertReduction("wget", "wget https://example.com/file.tar.gz", "wget", 70);
  });

  test("safety: 'saved' summary survives the filter", () => {
    const raw = loadSample("wget");
    const body = runFilterBody(
      "wget",
      "wget https://example.com/file.tar.gz",
      raw,
    );
    expect(body).toMatch(/saved \[\d+\/\d+\]/);
    // Final timestamped completion line carries throughput
    expect(body).toMatch(/MB\/s/);
  });

  test("safety: progress / chatter lines are stripped", () => {
    const raw = loadSample("wget");
    const body = runFilterBody(
      "wget",
      "wget https://example.com/file.tar.gz",
      raw,
    );
    expect(body).not.toMatch(/^Resolving /m);
    expect(body).not.toMatch(/^Connecting to /m);
    expect(body).not.toMatch(/^HTTP request sent,/m);
    expect(body).not.toMatch(/^Length: /m);
    expect(body).not.toMatch(/^Saving to:/m);
    expect(body).not.toMatch(/^Loaded CA certificate/m);
    // No surviving progress-dot rows
    expect(body).not.toMatch(/^\s*\d+K\s+\.{2,}/m);
  });

  test("safety: error lines are preserved (not stripped as progress)", () => {
    const raw = [
      "--2026-05-12 09:14:02--  https://example.com/missing.tar.gz",
      "Resolving example.com (example.com)... 1.2.3.4",
      "Connecting to example.com (example.com)|1.2.3.4|:443... connected.",
      "HTTP request sent, awaiting response... 404 Not Found",
      "2026-05-12 09:14:02 ERROR 404: Not Found.",
      "",
    ].join("\n");
    const body = runFilterBody(
      "wget",
      "wget https://example.com/missing.tar.gz",
      raw,
    );
    expect(body).toContain("ERROR 404: Not Found");
  });

  test("match: wget ✓; wgetx ✗", () => {
    expect(findFilterForCommand("wget https://example.com/x")?.name).toBe(
      "wget",
    );
    expect(findFilterForCommand("wgetx --version")?.name).not.toBe("wget");
  });

  test("reject: -q / --quiet / -O - pass through", () => {
    expect(findFilterForCommand("wget -q https://example.com/x")).toBeNull();
    expect(
      findFilterForCommand("wget --quiet https://example.com/x"),
    ).toBeNull();
    expect(findFilterForCommand("wget -O - https://example.com/x")).toBeNull();
    expect(
      findFilterForCommand("wget --output-document=- https://example.com/x"),
    ).toBeNull();
  });

  // Installer-one-liner shorthand: `wget -qO- URL | sh`. The `-q` is glued
  // to `-O-` so a plain `\b` after `-q` doesn't fire. The reject regex
  // matches `-q?O\s*-` explicitly to cover both `-O-` and `-qO-` forms.
  test("reject: -qO- / -qO - glued forms pass through", () => {
    expect(findFilterForCommand("wget -qO- https://example.com/x")).toBeNull();
    expect(findFilterForCommand("wget -qO - https://example.com/x")).toBeNull();
  });

  // P1 information-loss fix: the `HTTP request sent, awaiting response... NNN`
  // line is the only place wget prints the response status code for non-fatal
  // outcomes. We strip it only for success (200/206); 3xx/4xx/5xx must survive.
  test("safety: non-success HTTP status (3xx/4xx/5xx) survives", () => {
    const raw = [
      "--2026-05-12 09:14:02--  https://example.com/redirect",
      "Resolving example.com (example.com)... 1.2.3.4",
      "Connecting to example.com (example.com)|1.2.3.4|:443... connected.",
      "HTTP request sent, awaiting response... 301 Moved Permanently",
      "Location: https://example.com/new [following]",
      "--2026-05-12 09:14:02--  https://example.com/new",
      "HTTP request sent, awaiting response... 404 Not Found",
      "2026-05-12 09:14:02 ERROR 404: Not Found.",
    ].join("\n");
    const body = runFilterBody("wget", "wget https://example.com/redirect", raw);
    expect(body).toContain("301 Moved Permanently");
    expect(body).toContain("404 Not Found");
    expect(body).toContain("Location: https://example.com/new");
  });

  test("safety: HTTP 200 OK noise IS stripped (still compresses success path)", () => {
    const raw = loadSample("wget");
    const body = runFilterBody(
      "wget",
      "wget https://example.com/file.tar.gz",
      raw,
    );
    expect(body).not.toMatch(/HTTP request sent, awaiting response\.\.\. 200 OK/);
  });

  // --progress=bar is a single-line bar that `\r`-overwrites itself. The
  // CR-collapse pass leaves only the final frame, which the bar-strip
  // pattern then removes. The opening banner and the final saved-line
  // must survive.
  test("safety: --progress=bar CR-overwrites collapse to summary", () => {
    const raw = [
      "--2026-05-12 09:14:02--  https://example.com/file.bin",
      "Resolving example.com (example.com)... 1.2.3.4",
      "Connecting to example.com (example.com)|1.2.3.4|:443... connected.",
      "HTTP request sent, awaiting response... 200 OK",
      "Length: 1048576 (1.0M) [application/octet-stream]",
      "Saving to: 'file.bin'",
      "",
      // Three bar frames; only the final one survives the CR collapse.
      "     0K [>                    ]      0%  0.00 =0s\r" +
        "   500K [==========>          ]     50%  1.00M=0.5s\r" +
        "  1024K [====================>] 100%  2.00M=0.5s",
      "",
      "2026-05-12 09:14:03 (2.00 MB/s) - 'file.bin' saved [1048576/1048576]",
    ].join("\n");
    const body = runFilterBody("wget", "wget --progress=bar https://example.com/file.bin", raw);
    // Banner and saved-line survive
    expect(body).toContain("https://example.com/file.bin");
    expect(body).toMatch(/saved \[1048576\/1048576\]/);
    // No surviving bar frames (CR-collapsed, then bar-stripped)
    expect(body).not.toContain("[>");
    expect(body).not.toContain("==========>");
    expect(body).not.toContain("====================>");
  });

  // -S / --server-response prints indented HTTP response headers. These are
  // information-rich (status, content-type, redirect target, caching) and
  // must survive — the strip patterns only target wget's own chatter.
  test("safety: -S response headers survive", () => {
    const raw = [
      "--2026-05-12 09:14:02--  https://example.com/api",
      "Resolving example.com (example.com)... 1.2.3.4",
      "Connecting to example.com (example.com)|1.2.3.4|:443... connected.",
      "HTTP request sent, awaiting response... ",
      "  HTTP/1.1 200 OK",
      "  Content-Type: application/json",
      "  Content-Length: 42",
      "  Cache-Control: no-cache",
      "Length: 42 [application/json]",
      "Saving to: 'api'",
    ].join("\n");
    const body = runFilterBody("wget", "wget -S https://example.com/api", raw);
    expect(body).toContain("HTTP/1.1 200 OK");
    expect(body).toContain("Content-Type: application/json");
    expect(body).toContain("Cache-Control: no-cache");
  });

  // Common redirect chain: 301 → 200. The 301 hop carries the Location we
  // care about; the final 200 is OK to strip (it's just success chatter).
  test("safety: 301 → 200 redirect chain preserves the 301 hop", () => {
    const raw = [
      "--2026-05-12 09:14:02--  https://example.com/old",
      "Resolving example.com (example.com)... 1.2.3.4",
      "HTTP request sent, awaiting response... 301 Moved Permanently",
      "Location: https://example.com/new [following]",
      "--2026-05-12 09:14:02--  https://example.com/new",
      "HTTP request sent, awaiting response... 200 OK",
      "Length: 100 [text/plain]",
      "Saving to: 'new'",
      "",
      "2026-05-12 09:14:03 (10 MB/s) - 'new' saved [100/100]",
    ].join("\n");
    const body = runFilterBody("wget", "wget https://example.com/old", raw);
    expect(body).toContain("301 Moved Permanently");
    expect(body).toContain("Location: https://example.com/new");
    expect(body).toMatch(/saved \[100\/100\]/);
  });

  // -nv / --no-verbose: one summary line per file, no dot progress, no
  // headers. Should pass through essentially unchanged.
  test("safety: -nv summary line passes through", () => {
    const raw = "2026-05-12 09:14:03 URL:https://example.com/x [100/100] -> \"x\" [1]";
    const body = runFilterBody("wget", "wget -nv https://example.com/x", raw);
    expect(body).toContain("URL:https://example.com/x");
    expect(body).toContain("[100/100]");
  });

  // Defense: real filename with literal dots in path must not be eaten by
  // the progress-dot pattern (anchored at `^\s*\d+[KMG]?\s+\.{2,}`).
  test("defense: filename with dots in body is preserved (P0)", () => {
    const raw = [
      "--2026-05-12 09:14:02--  https://example.com/foo.tar.gz",
      "Resolving example.com (example.com)... 1.2.3.4",
      "Saving to: 'foo.tar.gz'",
      "../some/path/with/many.dots.in.it.txt",
      "2026-05-12 09:14:03 (10 MB/s) - 'foo.tar.gz' saved [100/100]",
    ].join("\n");
    const body = runFilterBody(
      "wget",
      "wget https://example.com/foo.tar.gz",
      raw,
    );
    expect(body).toContain("../some/path/with/many.dots.in.it.txt");
    expect(body).toMatch(/saved \[100\/100\]/);
  });
});
