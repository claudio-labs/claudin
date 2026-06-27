// Phase 13 — php family (composer).
import { describe, expect, test } from "bun:test";
import { runFilterBody, routesTo } from "./__testutils__/harness.js";
import {
  COMPOSER_NOTHING,
  COMPOSER_INSTALL,
  COMPOSER_ERR,
} from "./__testutils__/phase13Samples.js";

describe("phase 13 — composer", () => {
  test("no-op run collapses to sentinel", () => {
    expect(
      runFilterBody("composer", "composer install", COMPOSER_NOTHING).trim(),
    ).toBe("✓ composer: nothing to install or update");
  });

  test("install strips Downloading/Installing, keeps lock + autoload", () => {
    const body = runFilterBody("composer", "composer install", COMPOSER_INSTALL).trim();
    expect(body).toBe("Writing lock file\nGenerating autoload files");
    expect(body).not.toContain("Downloading");
    expect(body).not.toContain("Installing");
  });

  test("resolution error passes through, no sentinel", () => {
    const body = runFilterBody("composer", "composer update", COMPOSER_ERR);
    expect(body).not.toContain("✓ composer");
    expect(body).toContain("could not be resolved");
    expect(body).toContain("Problem 1");
    expect(body).toContain("requires php >=8.2");
  });

  test("abandoned-package warning on a no-op run is NOT collapsed away", () => {
    // "Nothing to install…" would collapse, but an abandoned-package warning is
    // signal the model must see, so the sentinel must not fire.
    const raw =
      "Loading composer repositories with package information\nUpdating dependencies\nPackage swiftmailer/swiftmailer is abandoned, you should avoid using it. Use symfony/mailer instead.\nNothing to install, update or remove\nGenerating autoload files\n";
    const body = runFilterBody("composer", "composer update", raw);
    expect(body).not.toContain("✓ composer");
    expect(body).toContain("is abandoned");
  });

  test("regression: a ≥2 blank-line run never leaves a ` (×N)` artifact body", () => {
    // composer has no onEmpty: collapseRuns turning the blank run into ` (×2)`
    // would leave that as the entire body. The root collapseIdenticalRuns fix
    // collapses the blank run to a single blank instead.
    const raw =
      "Loading composer repositories with package information\n\n\nUpdating dependencies\n";
    const body = runFilterBody("composer", "composer install", raw);
    expect(body).not.toContain("(×");
  });

  test("routes install/update/require, not other subcommands", () => {
    expect(routesTo("composer install")).toBe("composer");
    expect(routesTo("composer update --no-dev")).toBe("composer");
    expect(routesTo("composer require monolog/monolog")).toBe("composer");
    expect(routesTo("composer dump-autoload")).not.toBe("composer");
  });
});
