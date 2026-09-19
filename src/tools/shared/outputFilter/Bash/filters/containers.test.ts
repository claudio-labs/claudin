// Containers family — docker compose, and the deliberate absence of docker exec.
//
// `docker ps` / `docker images` / `docker logs` predate this file and are still
// covered only by their fixtures in the ROI bench. Backfilling them is worth
// doing and is deliberately not done here.
import { describe, expect, test } from "bun:test";
import {
  runFilterBody,
  runCompoundBody,
  reductionPct,
  assertReduction,
  routesTo,
  findFilterForCommand,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/harness.js";
import {
  COMPOSE_UP,
  COMPOSE_FAIL,
  COMPOSE_ALL_NOISE,
  COMPOSE_LOGS,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/containerSamples.js";

const UP = "docker compose -f docker-compose.dev.yml up -d --build legendarr";

describe("docker compose", () => {
  test("strips step bookkeeping, keeps the step headers and the result", () => {
    const body = runFilterBody("docker-compose", UP, COMPOSE_UP);

    // The three noise shapes the spec names.
    expect(body).not.toContain("DONE 0.0s");
    expect(body).not.toContain("CACHED");
    expect(body).not.toContain("transferring dockerfile");
    expect(body).not.toContain("#14 2.785");

    // The step header stays — it is what a failing step's output hangs off.
    expect(body).toContain("#14 [builder 7/9] RUN");
    // …and so does the RUN step's own output, with only the prefix gone.
    expect(body).toContain("Installed 3 packages");

    // The answer to "did it build and start".
    expect(body).toContain("naming to docker.io/library/legendarr-legendarr");
    expect(body).toContain("Image legendarr-legendarr Built");
    expect(body).toContain("Container legendarr-legendarr-1 Started");

    expect(reductionPct(COMPOSE_UP, body)).toBeGreaterThan(25);
  });

  test("intermediate lifecycle states go, terminal ones stay", () => {
    const body = runFilterBody("docker-compose", UP, COMPOSE_UP);
    // Only states the RAW capture actually contains — asserting the absence of
    // a line that was never there passes whether or not the strip works. The
    // container carries Creating/Created/Starting; `Building` is on the IMAGE
    // line, which is why it is checked separately below.
    for (const gone of ["Creating", "Starting"]) {
      expect(COMPOSE_UP).toContain(`legendarr-legendarr-1 ${gone}`);
      expect(body).not.toContain(`legendarr-legendarr-1 ${gone}`);
    }
    expect(COMPOSE_UP).toContain("Image legendarr-legendarr Building");
    expect(body).not.toContain("Image legendarr-legendarr Building");
    expect(body).toContain("Container legendarr-sonarr-1 Running");
  });

  test("`Created` survives — it is terminal for `create` and `up --no-start`", () => {
    // Stripping it collapsed the whole body of a `docker compose create` to the
    // onEmpty sentinel, losing the only line that named the container.
    const raw = " Container app-db-1 Creating\n Container app-db-1 Created\n";
    const body = runFilterBody("docker-compose", "docker compose create", raw);
    expect(body).toContain("Container app-db-1 Created");
    expect(body).not.toContain("Creating");
  });

  test("pull/layer digest progress is stripped", () => {
    // `DOCKER_COMPOSE_SHA_PROGRESS` has no line in the committed capture, so
    // without this it is an unexercised regex.
    const raw =
      "#5 [internal] load metadata\n#5 sha256:abc123 1.2MB / 4.5MB\n#5 extracting sha256:abc123\n#5 resolve docker.io/library/python:3.12\n#5 DONE 1.2s\nok\n";
    const body = runFilterBody("docker-compose", "docker compose pull", raw);
    expect(body).toContain("#5 [internal] load metadata");
    expect(body).not.toContain("sha256:abc123");
    expect(body).not.toContain("resolve docker.io");
  });

  test("64-char digests are truncated to 12, not dropped", () => {
    const body = runFilterBody("docker-compose", UP, COMPOSE_UP);
    expect(body).toContain("sha256:474d31d7971d…");
    expect(body).not.toContain(
      "474d31d7971d8bec499c64d0552e8eaddc55c9c4b7354fd88438ad258a03e666",
    );
  });

  test("a failed build is NOT collapsed — ERROR is not a footer", () => {
    const body = runFilterBody("docker-compose", UP, COMPOSE_FAIL);
    expect(body).not.toContain("docker compose: ok");
    expect(body).toContain("#14 ERROR: process");
    expect(body).toContain("error: Failed to parse");
    expect(body).toContain("failed to solve:");
    // The elapsed prefix is stripped even on the failing lines.
    expect(body).not.toContain("#14 0.512");
  });

  test("all-noise body reaches onEmpty with no ` (×N)` artifact", () => {
    // A blank run sits between the stripped lines. Before the root
    // collapseIdenticalRuns fix a run of blanks survived the strip as ` (×2)`
    // and defeated the sentinel; both this spec and `bun-run` use collapseRuns,
    // so both need the guard.
    const body = runFilterBody("docker-compose", "docker compose up -d", COMPOSE_ALL_NOISE).trim();
    expect(body).not.toContain("(×");
    expect(body).toBe("docker compose: ok");
  });

  test("compose logs: timestamp goes, service prefix stays", () => {
    const body = runFilterBody("docker-compose", "docker compose logs", COMPOSE_LOGS);
    expect(body).toContain("legendarr-1  | INFO  starting web worker");
    // The postgres form keeps HH:MM:SS, as `docker logs` does.
    expect(body).toContain("db-1         | 10:00:01 LOG:");
    expect(body).not.toContain("2026-08-01T10:00:00");
    expect(body).not.toContain("[27]");
  });

  test("compose logs --no-log-prefix: the bare timestamp form is handled too", () => {
    // Without the service prefix the `docker logs` anchors are what must fire.
    // No committed capture has this shape, so these two `replace` entries would
    // otherwise be unexercised.
    const raw =
      "2026-08-01T10:00:00.123456789Z INFO starting\n2026-08-01 10:00:01.004 UTC [27] LOG:  ready\n";
    const body = runFilterBody(
      "docker-compose",
      "docker compose logs --no-log-prefix api",
      raw,
    );
    expect(body).toContain("INFO starting");
    expect(body).toContain("10:00:01 LOG:");
    expect(body).not.toContain("2026-08-01");
  });

  test("routes both spellings, and does not steal the sibling docker specs", () => {
    expect(routesTo("docker compose up")).toBe("docker-compose");
    expect(routesTo(UP)).toBe("docker-compose");
    // The legacy hyphenated binary is still what many compose files document.
    expect(routesTo("docker-compose up -d")).toBe("docker-compose");
    expect(routesTo("docker ps")).toBe("docker-ps");
    expect(routesTo("docker images")).toBe("docker-images");
    expect(routesTo("docker logs api")).toBe("docker-logs");
  });

  test("negative: machine-readable and streaming forms opt out", () => {
    expect(routesTo("docker compose ps --format json")).not.toBe("docker-compose");
    expect(routesTo("docker compose ls --quiet")).not.toBe("docker-compose");
    expect(routesTo("docker compose logs --follow")).not.toBe("docker-compose");
    // `-f` is `--file` here, NOT `--follow` — the recorded traffic uses it and
    // must keep routing.
    expect(routesTo("docker compose -f compose.dev.yml up")).toBe("docker-compose");
  });

  test("only the lifecycle subcommands are claimed", () => {
    for (const sub of ["up", "down", "build", "restart", "pull", "logs", "create"]) {
      expect(routesTo(`docker compose ${sub}`)).toBe("docker-compose");
    }
    // These print arbitrary inner output, YAML or a table. The strip rules would
    // eat a blank line or a `Created` row out of the middle of them, so they must
    // fall to the floor instead.
    for (const sub of ["exec app sh", "run app pytest", "config", "ps", "top", "port app 80"]) {
      expect(routesTo(`docker compose ${sub}`)).not.toBe("docker-compose");
    }
  });

  test("a flag VALUE is never mistaken for the subcommand", () => {
    // `-f docker-compose.run.yml up` must resolve the subcommand as `up`, not
    // find `run` inside the filename.
    expect(routesTo("docker compose -f docker-compose.run.yml up -d")).toBe("docker-compose");
    expect(routesTo("docker compose -f a.yml -f b.yml up")).toBe("docker-compose");
    expect(routesTo("docker compose --profile dev up")).toBe("docker-compose");
    expect(routesTo("docker compose -p myproj down")).toBe("docker-compose");
  });
});

describe("docker exec is deliberately NOT claimed", () => {
  // A spec for it was written and removed: it could only set `stripAnsi` and
  // `collapseRuns`, which IS the generic floor, while its own `maxLines` would
  // cut unconditionally — the floor's body-shape vetoes do not run for a matched
  // spec. These pin the absence so the spec does not come back by accident.

  test("no spec claims `docker exec`", () => {
    expect(routesTo("docker exec api ls /app")).toBeUndefined();
    expect(routesTo("docker exec -it db psql -U postgres")).toBeUndefined();
  });

  test("a JSON body read through `docker exec` is not cut", () => {
    const json = `{\n${Array.from({ length: 400 }, (_, i) => `  "k${i}": ${i},`).join("\n")}\n  "last": 1\n}\n`;
    const body = runCompoundBody("docker exec api cat /app/package.json", json);
    expect(body.split("\n").length).toBeGreaterThan(400);
    expect(body).toContain('"last": 1');
  });

  test("a diagnostic dump read through `docker exec` is not cut", () => {
    const diags = Array.from(
      { length: 300 },
      (_, i) => `src/f${i}.ts:${i}:1 - error TS2322: Type 'a' is not assignable.`,
    ).join("\n");
    const body = runCompoundBody("docker exec api npx tsc", diags);
    expect(body.split("\n").length).toBeGreaterThan(290);
    expect(body).toContain("src/f299.ts");
  });
});

describe("docker compose — through the production plan, not a hand-built one", () => {
  // `runFilterBody` names the spec it wants, which is what a per-family test
  // should do — but it means every assertion above runs against a plan that was
  // constructed by the test. These resolve the plan from the command string the
  // way `BashTool` does, so a spec that is written correctly and registered
  // wrongly still fails here.

  test("`cd … && docker compose up` — the shape the corpus actually recorded", () => {
    const body = runCompoundBody(`cd /srv/app && ${UP}`, COMPOSE_UP);
    expect(body).not.toContain("DONE 0.0s");
    expect(body).toContain("Image legendarr-legendarr Built");
  });

  test("`timeout 600 docker compose up` reaches the compose spec", () => {
    const body = runCompoundBody(`timeout 600 ${UP}`, COMPOSE_UP);
    expect(body).not.toContain("DONE 0.0s");
    expect(body).toContain("Container legendarr-legendarr-1 Started");
  });
});

// ---------------------------------------------------------------------------
// Phase 6.1.5 — container specs
// ---------------------------------------------------------------------------

describe("phase 6.1.5 — dockerPs", () => {
  test("ROI: docker-ps sample ≥20% reduction", () => {
    assertReduction("docker-ps", "docker ps -a", "docker-ps", 20);
  });

  test("match: docker ps", () => {
    expect(findFilterForCommand("docker ps")?.name).toBe("docker-ps");
  });

  test("match: docker ps -a", () => {
    expect(findFilterForCommand("docker ps -a")?.name).toBe("docker-ps");
  });

  test("reject: docker ps --format", () => {
    expect(findFilterForCommand("docker ps --format '{{.Names}}'")).toBeNull();
  });

  test("reject: docker ps -q", () => {
    expect(findFilterForCommand("docker ps -q")).toBeNull();
  });

  test("reject: docker ps --quiet", () => {
    expect(findFilterForCommand("docker ps --quiet")).toBeNull();
  });

  test("reject: docker ps --no-trunc", () => {
    expect(findFilterForCommand("docker ps --no-trunc")).toBeNull();
  });

  test("strips CONTAINER ID column from data rows", () => {
    const raw = "CONTAINER ID   IMAGE             STATUS\na3f8c9d2e1b7   postgres:16       Up 2 hours\n";
    const body = runFilterBody("docker-ps", "docker ps -a", raw);
    expect(body).not.toMatch(/^[0-9a-f]{12}\s/m);
    expect(body).toContain("postgres:16");
  });

  test("onEmpty: no containers returns message", () => {
    const raw = "CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS    PORTS     NAMES\n";
    const body = runFilterBody("docker-ps", "docker ps", raw);
    expect(body).toContain("No matching containers.");
  });
});

describe("phase 6.1.5 — dockerImages", () => {
  test("ROI: docker-images sample ≥30% reduction", () => {
    assertReduction("docker-images", "docker images", "docker-images", 30);
  });

  test("match: docker images", () => {
    expect(findFilterForCommand("docker images")?.name).toBe("docker-images");
  });

  test("reject: docker images --format", () => {
    expect(findFilterForCommand("docker images --format '{{.Repository}}'")).toBeNull();
  });

  test("reject: docker images -q", () => {
    expect(findFilterForCommand("docker images -q")).toBeNull();
  });

  test("strips WARNING line", () => {
    const raw = "WARNING: This output is designed for human readability. For machine-readable output, please use --format.\nIMAGE   ID   DISK USAGE\npostgres:16   108b27c919e6   276MB\n";
    const body = runFilterBody("docker-images", "docker images", raw);
    expect(body).not.toContain("WARNING:");
    expect(body).toContain("postgres:16");
  });

  test("strips 12-char hex ID column", () => {
    const raw = "IMAGE   ID             DISK USAGE\npostgres:16   108b27c919e6   276MB\n";
    const body = runFilterBody("docker-images", "docker images", raw);
    expect(body).not.toMatch(/\b[0-9a-f]{12}\b/);
  });
});

describe("phase 6.1.5 — dockerLogs", () => {
  test("ROI: docker-logs sample ≥15% reduction", () => {
    assertReduction("docker-logs", "docker logs postgres", "docker-logs", 15);
  });

  test("match: docker logs myapp", () => {
    expect(findFilterForCommand("docker logs myapp")?.name).toBe("docker-logs");
  });

  test("match: docker logs --tail 50 myapp", () => {
    expect(findFilterForCommand("docker logs --tail 50 myapp")?.name).toBe("docker-logs");
  });

  test("reject: docker logs -f myapp", () => {
    expect(findFilterForCommand("docker logs -f myapp")).toBeNull();
  });

  test("reject: docker logs --follow myapp", () => {
    expect(findFilterForCommand("docker logs --follow myapp")).toBeNull();
  });

  test("reject: docker logs --timestamps=false myapp", () => {
    expect(findFilterForCommand("docker logs --timestamps=false myapp")).toBeNull();
  });

  test("strips postgres-style timestamp prefix to HH:MM:SS", () => {
    const raw = "2026-05-05 14:35:40.337 UTC [27] LOG:  checkpoint complete\n2026-05-05 14:35:40.405 UTC [1] LOG:  database shut down\n";
    const body = runFilterBody("docker-logs", "docker logs postgres", raw);
    expect(body).toContain("14:35:40 LOG:");
    expect(body).not.toContain("2026-05-05");
    expect(body).not.toContain("[27]");
  });

  test("strips Docker ISO timestamp prefix", () => {
    const raw = "2026-05-05T14:35:40.337Z INFO Starting server\n2026-05-05T14:35:41.001Z INFO Ready\n";
    const body = runFilterBody("docker-logs", "docker logs myapp", raw);
    expect(body).toContain("INFO Starting server");
    expect(body).not.toContain("2026-05-05T");
  });
});
