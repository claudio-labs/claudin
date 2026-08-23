// Phase 14 — containers family (docker compose / docker exec).
//
// `docker ps` / `docker images` / `docker logs` predate this file and are still
// covered only by their fixtures in the ROI bench. Backfilling them is worth
// doing and is deliberately not done here.
import { describe, expect, test } from "bun:test";
import {
  runFilterBody,
  runCompoundBody,
  reductionPct,
  routesTo,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/harness.js";
import {
  COMPOSE_UP,
  COMPOSE_FAIL,
  COMPOSE_ALL_NOISE,
  COMPOSE_LOGS,
  EXEC_INNER,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/phase14Samples.js";

const UP = "docker compose -f docker-compose.dev.yml up -d --build legendarr";

describe("phase 14 — docker compose", () => {
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
    for (const gone of ["Creating", "Created", "Starting", "Building"]) {
      expect(body).not.toContain(`legendarr-legendarr-1 ${gone}`);
    }
    expect(body).toContain("Container legendarr-sonarr-1 Running");
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
});

describe("phase 14 — docker exec", () => {
  test("the inner command's output is passed through untouched", () => {
    // It deliberately looks like docker output. None of the sibling specs'
    // patterns may fire, because this spec has no `replace` at all.
    const body = runFilterBody("docker-exec", "docker exec api ls -la /app", EXEC_INNER);
    expect(body.trim()).toBe(EXEC_INNER.trim());
  });

  test("ANSI from a TTY session is stripped", () => {
    const body = runFilterBody(
      "docker-exec",
      "docker exec -it api sh",
      "\u001b[32mok\u001b[0m\n",
    );
    expect(body.trim()).toBe("ok");
  });

  test("routes exec, including the TTY flags", () => {
    expect(routesTo("docker exec api ls /app")).toBe("docker-exec");
    expect(routesTo("docker exec -it db psql -U postgres")).toBe("docker-exec");
    expect(routesTo("docker execute")).not.toBe("docker-exec");
  });
});

describe("phase 14 — through the production plan, not a hand-built one", () => {
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
