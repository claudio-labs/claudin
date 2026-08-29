// What every execution-wrapper prefix routes to, as a table.
//
// The registry anchors every `matchCommand` on a bare verb, so a tool invoked
// through a wrapper (`bundle exec rubocop`) or by path
// (`./node_modules/.bin/eslint`) reaches no spec unless `consumeExecutionPrefix`
// consumed the prefix first. That is one mechanism serving every ecosystem, so
// it is pinned once here rather than per filter file — and the negative rows
// carry as much weight as the positive ones: each names a shape we deliberately
// refuse to strip, and a regex that grows to swallow one of them is the failure
// this table exists to catch.
//
// Measured motivation (`floor.ts` census over the 60-day corpus): `atomic, no
// filter registered` is 6.8% of Bash characters — the bucket a missing prefix
// lands in.

import { describe, expect, test } from "bun:test";
import { findFilterForCommand } from "src/tools/shared/outputFilter/Bash/registry.js";
import { parseBashCommand } from "src/tools/shared/outputFilter/Bash/pipeline.js";

const routesTo = (command: string): string | null =>
  findFilterForCommand(command)?.name ?? null;

/** [command, expected spec name or null, why this row exists] */
type Row = readonly [string, string | null, string];

const WRAPPERS: readonly Row[] = [
  ["nohup make build", "make", "detaches only, output unchanged"],
  ["setsid pytest tests/", "pytest", "new session, same output"],
  ["doas make build", "make", "sudo's OpenBSD sibling"],
  ["caffeinate go test ./...", "go-test", "macOS sleep inhibitor"],
  ["exec make build", "make", "replaces the shell, same output"],
  ["env -i make build", "make", "cleared environment, same tool"],
  ["env -u NODE_ENV pytest tests/", "pytest", "-u takes a value"],
  ["stdbuf -oL pytest tests/", "pytest", "buffering knob only"],
  ["taskset -c 0-3 make build", "make", "cpu affinity mask"],
];

const RUNNERS: readonly Row[] = [
  // rubocop and rspec spell `bundle exec` inside their own matchCommand, so
  // those two pass with the prefix removed as well; `rake` is the row that
  // proves the generic strip, having no such arm.
  ["bundle exec rubocop", "rubocop", "already had a bundle-exec arm of its own"],
  ["bundle exec rake db:migrate", "rake", "rake had no bundle-exec arm of its own"],
  ["rbenv exec rspec spec/", "rspec", "version-manager exec"],
  ["pyenv exec pytest tests/", "pytest", "version-manager exec"],
  ["asdf exec pytest tests/", "pytest", "version-manager exec"],
  ["rye run pytest tests/", "pytest", "poetry-family runner"],
  ["pdm run -p . pytest tests/", "pytest", "-p takes the project dir"],
  ["conda run -n dev pytest tests/", "pytest", "-n takes the env name"],
  ["micromamba run -n dev ruff check .", "ruff-check", "conda-compatible"],
  ["uvx ruff check .", "ruff-check", "uv's tool runner"],
  ["uvx --from ruff ruff check .", "ruff-check", "--from takes a spec"],
  ["pipx run --spec ruff ruff check .", "ruff-check", "--spec takes a package"],
  ["npm exec -- eslint .", "eslint", "npx's long form, with separator"],
  ["yarn exec eslint .", "eslint", "Berry's exec"],
  ["mise exec node@20 -- vitest run", "vitest", "anchored on the mandatory --"],
  ["dotnet tool run dotnet-format", null, "prefix consumed; no spec for the tool"],
];

const FREE_TOKEN: readonly Row[] = [
  ["nvm exec 20 npx jest", "jest", "version token, then a second prefix"],
  ["nvm exec --silent v18.19.0 pytest tests/", "pytest", "v-prefixed version"],
  ["volta run jest", "jest", "no pin given"],
  ["volta run --node 20 jest", "jest", "--node takes a version"],
  ["fnm exec --using=20 vitest run", "vitest", "--using= form"],
  ["flock /tmp/build.lock make build", "make", "lock file is a path"],
  ["direnv exec . pytest tests/", "pytest", "directory operand"],
];

const CONTAINER_EXEC: readonly Row[] = [
  ["docker exec -it web pytest tests/", "pytest", "the inner tool owns the format"],
  ["docker exec -u root -w /app web ruff check .", "ruff-check", "value-taking flags"],
  ["docker compose exec -T api pytest tests/", "pytest", "compose form"],
  ["podman exec db pytest tests/", "pytest", "podman is a drop-in"],
  ["kubectl exec -n prod pod-1 -- go test ./...", "go-test", "requires the --"],
];

const PATH_PREFIXED: readonly Row[] = [
  ["./node_modules/.bin/eslint .", "eslint", "the JS case that started this"],
  ["vendor/bin/rubocop", "rubocop", "relative, no leading dot"],
  ["/usr/bin/make build", "make", "absolute path"],
  ["./gradlew build", "gradle", "already matched by hand; still does"],
  ["../scripts/pytest tests/", "pytest", "parent-relative"],
  ["sudo /usr/local/bin/make install", "make", "path behind another prefix"],
];

// Shapes we refuse to strip, each for a stated reason. A prefix regex that
// grows to consume one of these breaks a row here rather than in production.
const NOT_STRIPPED: readonly Row[] = [
  ["watch docker ps", null, "runs the command N times; body is N runs interleaved"],
  ["strace -f make build", null, "interleaves syscalls with the tool's output"],
  ["xargs -n1 pytest", null, "one run per input batch"],
  ["ssh build-host make all", "ssh", "ssh has its OWN spec; it is never a wrapper"],
  ['sh -c "pytest tests/"', null, "inner command is quoted"],
  ['flock -c "make build"', null, "-c is not a lock path, so nothing is consumed"],
  ["tox -e py311", null, "argument names an environment, not a tool"],
  ["nox -s lint", null, "same class as tox"],
  ["bazel run //src:app", null, "argument is a build target"],
  ["corepack pnpm install", null, "argument is a package manager"],
  ["bun run dev", "bun-run", "script name is not a tool; bun's own spec answers"],
  ["npm run lint", "npm-run", "same, npm's own spec"],
];

const SPEC_FIXES: readonly Row[] = [
  ["python3 -m pytest tests/", "pytest", "python3 was missing from PYTEST_MATCH"],
  ["python -m pytest tests/", "pytest", "the form that already worked"],
  ["yarn", "yarn-install", "bare yarn is still install"],
  ["yarn install", "yarn-install", "explicit install"],
  ["yarn add lodash", "yarn-install", "add stays"],
  // `yarn jest` passes with the overlap too — jest is registered earlier, which
  // is exactly the accident that hid the bug. The row that actually guards the
  // fix is the next one: no other spec claims `yarn build`.
  ["yarn jest", "jest", "unclaimed by yarn-install, but order also covers it"],
  ["yarn build", null, "THE guard: a script name reaches no spec, like npm run"],
  ["yarn lint", null, "same, without relying on any other spec"],
  ["clang -Wall main.c", "gcc", "same diagnostic format as gcc"],
  ["clang++ -std=c++20 a.cpp", "gcc", "same"],
  ["podman ps", "docker-ps", "drop-in CLI"],
  ["podman logs web", "docker-logs", "drop-in CLI"],
  ["podman-compose up -d", "docker-compose", "drop-in CLI"],
];

const TABLE: readonly (readonly [string, readonly Row[]])[] = [
  ["bare wrappers", WRAPPERS],
  ["runner prefixes", RUNNERS],
  ["free-token runners", FREE_TOKEN],
  ["container exec", CONTAINER_EXEC],
  ["path-prefixed binaries", PATH_PREFIXED],
  ["shapes deliberately not stripped", NOT_STRIPPED],
  ["spec fixes shipped with this round", SPEC_FIXES],
];

describe("prefix routing", () => {
  for (const [group, rows] of TABLE) {
    describe(group, () => {
      for (const [command, expected, why] of rows) {
        test(`${command} → ${expected ?? "no spec"} (${why})`, () => {
          expect(routesTo(command)).toBe(expected);
        });
      }
    });
  }

  test("a prefix survives into the compound router", () => {
    // `cd X && <tool>` is the most common real shape; the prefix has to be
    // stripped per SEGMENT (registry.ts canonicalizes each one).
    expect(routesTo("cd /app && bundle exec rspec spec/")).toBe("rspec");
    expect(routesTo("cd /app && ./node_modules/.bin/eslint .")).toBe("eslint");
  });

  test("an unrecognised flag shape consumes nothing (fail-open)", () => {
    // Not "matches something else" — matches NOTHING. A prefix parse that goes
    // wrong must degrade to the generic floor, never to another spec.
    expect(routesTo("docker exec --unknown-flag=1 web pytest tests/")).toBeNull();
    expect(parseBashCommand("docker exec --unknown-flag=1 web pytest").verb).toBe(
      "docker",
    );
    expect(routesTo("conda run --unknown dev pytest tests/")).toBeNull();
  });

  test("a path strip leaves argument paths alone", () => {
    // Only the verb's directory is consumed; the arguments still carry theirs,
    // which is what `matchCommandReject` patterns read.
    const ctx = parseBashCommand("./node_modules/.bin/eslint src/a.ts --fix");
    expect(ctx.verb).toBe("eslint");
    expect(ctx.args).toEqual(["src/a.ts", "--fix"]);
  });

  test("bare `env` reporting its own environment is not a wrapper", () => {
    // `env` is both a wrapper and a command. Recorded traffic has the second
    // form (`env | grep -i api_key`), and consuming the word there would leave
    // the pipe as the verb.
    expect(parseBashCommand("env | grep -i api_key").verb).toBe("env");
    expect(parseBashCommand("env -i PATH=/usr/bin make build").verb).toBe("make");
  });
});
