// java-build family — spring-boot, plus the gradle/mvn overlap fix.
import { describe, expect, test } from "bun:test";
import {
  loadSample,
  runFilterBody,
  assertReduction,
  routesTo,
  findFilterForCommand,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/harness.js";
import { SPRING_OK, SPRING_ERR } from "src/tools/shared/outputFilter/Bash/filters/__testutils__/javaBuildSamples.js";

describe("spring-boot", () => {
  test("startup keeps Tomcat/Started summary, drops banner + per-bean INFO", () => {
    const body = runFilterBody("spring-boot", "mvn spring-boot:run", SPRING_OK).trim();
    expect(body).toBe(
      "2024-01-01 INFO Tomcat started on port 8080\n2024-01-01 INFO Started MyApp in 3.2 seconds",
    );
    expect(body).not.toContain("Initializing Spring");
    expect(body).not.toContain("Spring Boot ::");
  });

  test("failure keeps ERROR + Caused by, drops the rest", () => {
    const body = runFilterBody("spring-boot", "gradle bootRun", SPRING_ERR).trim();
    expect(body).toBe(
      "2024-01-01 ERROR Application run failed\nCaused by: java.lang.NullPointerException",
    );
    expect(body).not.toContain("Initializing Spring");
  });

  test("routes mvn spring-boot:run / gradle bootRun, not java -jar", () => {
    expect(routesTo("mvn spring-boot:run")).toBe("spring-boot");
    expect(routesTo("gradle bootRun")).toBe("spring-boot");
    expect(routesTo("./gradlew bootRun")).toBe("spring-boot");
    expect(routesTo("gradlew :app:bootRun")).toBe("spring-boot");
    // java -jar dropped on purpose (would false-positive on any jar run)
    expect(routesTo("java -jar build/libs/app.jar")).not.toBe("spring-boot");
  });

  test("overlap: plain gradle/mvn builds still route to their own filter", () => {
    expect(routesTo("gradle build")).toBe("gradle");
    expect(routesTo("./gradlew assemble")).toBe("gradle");
    expect(routesTo("mvn package")).toBe("mvn");
    // …but the run goals defer to spring-boot, not gradle/mvn
    expect(routesTo("gradle bootRun")).not.toBe("gradle");
    expect(routesTo("mvn spring-boot:run")).not.toBe("mvn");
  });
});

describe("gradle/mvn warning survival", () => {
  test("gradle: a BUILD SUCCESSFUL with a deprecation warning is NOT collapsed", () => {
    const raw =
      "> Task :compileJava\nDeprecated Gradle features were used in this build, making it incompatible with Gradle 9.0.\n\nBUILD SUCCESSFUL in 4s\n3 actionable tasks: 3 executed\n";
    const body = runFilterBody("gradle", "gradle build", raw);
    expect(body).not.toContain("✓ gradle: BUILD SUCCESSFUL");
    expect(body).toContain("Deprecated Gradle features were used");
  });

  test("mvn: a BUILD SUCCESS with a [WARNING] is NOT collapsed (the line survives)", () => {
    const raw =
      "[INFO] Scanning for projects...\n[INFO] Building app 1.0\n[WARNING] Some problems were encountered while building the effective model\n[INFO] BUILD SUCCESS\n[INFO] Total time:  2.345 s\n";
    const body = runFilterBody("mvn", "mvn package", raw);
    expect(body).not.toContain("✓ mvn: BUILD SUCCESS");
    expect(body).toContain("[WARNING] Some problems were encountered");
  });

  test("gradle: a plain compiler `warning:` (no deprecation) is NOT collapsed", () => {
    // Exercises the `\\bwarning\\b` alternation of GRADLE_HAS_PROBLEM specifically
    // — the deprecation test above only covers the `deprecat` alternation.
    const raw =
      "> Task :compileJava\nwarning: [options] bootstrap class path not set in conjunction with -source 8\n\nBUILD SUCCESSFUL in 4s\n2 actionable tasks: 2 executed\n";
    const body = runFilterBody("gradle", "gradle build", raw);
    expect(body).not.toContain("✓ gradle: BUILD SUCCESSFUL");
    expect(body).toContain("bootstrap class path not set");
  });
});

describe("gradle/mvn clean collapse", () => {
  test("gradle: a clean BUILD SUCCESSFUL collapses to the sentinel", () => {
    // No warning / deprecation / FAILED anywhere → the guard must NOT fire and
    // the sentinel must collapse the body. Guards against a future widening of
    // GRADLE_HAS_PROBLEM that would silently kill the collapse.
    const raw =
      "> Task :compileJava\n> Task :classes\n> Task :jar\n> Task :assemble\n\nBUILD SUCCESSFUL in 4s\n3 actionable tasks: 3 executed\n";
    expect(runFilterBody("gradle", "gradle build", raw).trim()).toBe(
      "✓ gradle: BUILD SUCCESSFUL",
    );
  });

  test("mvn: a clean BUILD SUCCESS collapses to the sentinel", () => {
    const raw =
      "[INFO] Scanning for projects...\n[INFO] Building app 1.0\n[INFO] Compiling 5 source files\n[INFO] BUILD SUCCESS\n[INFO] Total time:  2.345 s\n[INFO] Finished at: 2024-01-01\n";
    expect(runFilterBody("mvn", "mvn package", raw).trim()).toBe(
      "✓ mvn: BUILD SUCCESS",
    );
  });

  test("gradle: a `deprecat`-substring identifier (deprecator) still collapses", () => {
    // Anchors the GRADLE_HAS_PROBLEM `deprecat` alternation: an unrelated module
    // named `deprecator` is not a deprecation notice, so the clean build must
    // still collapse. Fails under the old unanchored `deprecat`.
    const raw =
      "> Task :deprecator:compileJava\n> Task :classes\n\nBUILD SUCCESSFUL in 3s\n2 actionable tasks: 2 executed\n";
    expect(runFilterBody("gradle", "gradle build", raw).trim()).toBe(
      "✓ gradle: BUILD SUCCESSFUL",
    );
  });
});

// ==========================================================================
// Phase 11 — Java build tools (gradle, mvn)
// ==========================================================================

describe("phase 11 — gradle", () => {
  // ROI -------------------------------------------------------------------
  test("ROI: gradle-build-incremental reduces ≥ 90%", () => {
    assertReduction("gradle", "gradle build", "gradle-build-incremental", 90);
  });

  test("ROI: gradle-build-cold reduces ≥ 70%", () => {
    assertReduction("gradle", "./gradlew build", "gradle-build-cold", 70);
  });

  test("ROI: gradle-clean-build (multi-project) reduces ≥ 70%", () => {
    assertReduction("gradle", "gradle clean build", "gradle-clean-build", 70);
  });

  // strict success sentinel ----------------------------------------------
  test("sentinel: gradle build success collapses to ✓ gradle (strict)", () => {
    const raw = loadSample("gradle-build-incremental");
    const body = runFilterBody("gradle", "gradle build", raw);
    expect(body.trim()).toBe("✓ gradle: BUILD SUCCESSFUL");
  });

  test("sentinel: gradle clean build success collapses to ✓ gradle (strict)", () => {
    const raw = loadSample("gradle-clean-build");
    const body = runFilterBody("gradle", "gradle clean build", raw);
    expect(body.trim()).toBe("✓ gradle: BUILD SUCCESSFUL"); // body é EXATAMENTE o sentinel
  });

  // safety ----------------------------------------------------------------
  test("safety: test failure preserves stack trace and FAILED (P0)", () => {
    const raw = loadSample("gradle-test-failure");
    const body = runFilterBody("gradle", "gradle test", raw);
    expect(body).toContain("FAILED");
    expect(body).toContain("AssertionError");
    expect(body).toContain("BUILD FAILED");
    expect(body).not.toMatch(/^✓ gradle/);
    // anti-noise: configure-project chatter must be stripped.
    expect(body).not.toContain("> Configure project");
    expect(body).not.toMatch(/^✓ gradle/m);
  });

  test("safety: compile error preserves what went wrong block (P0)", () => {
    const raw = loadSample("gradle-compile-error");
    const body = runFilterBody("gradle", "./gradlew build", raw);
    expect(body).toContain("Could not resolve");
    expect(body).toContain("BUILD FAILED");
    // anti-noise: daemon/configure/resolving chatter must be stripped.
    expect(body).not.toContain("Starting a Gradle Daemon");
    expect(body).not.toContain("> Configure project");
    expect(body).not.toContain("> Resolving dependencies");
    expect(body).not.toMatch(/^✓ gradle/m);
  });

  test("safety: task without status suffix is not stripped (P0)", () => {
    // `> Task :app:compileJava` (no suffix) = task executed = must not be stripped.
    // `> Task :app:processResources UP-TO-DATE` = pure noise = must be stripped.
    // We use a FAILED build so the sentinel does not fire and we can inspect
    // which individual lines survive the strip rules.
    const raw = [
      "> Task :app:compileJava",
      "> Task :app:processResources UP-TO-DATE",
      "FAILURE: Build failed with an exception.",
      "BUILD FAILED in 3s",
    ].join("\n");
    const body = runFilterBody("gradle", "gradle build", raw);
    expect(body).toContain("> Task :app:compileJava");
    expect(body).not.toContain("> Task :app:processResources");
  });

  test("safety: actionable tasks summary line is preserved or sentinel fires (P1)", () => {
    // When the build succeeds, the sentinel collapses everything — the
    // "actionable tasks" line is only visible when the sentinel does NOT fire.
    // Either outcome is valid here; the test verifies the filter does not crash.
    const raw = loadSample("gradle-build-cold");
    const body = runFilterBody("gradle", "./gradlew build", raw);
    expect(body).toMatch(/\d+ actionable tasks|✓ gradle/);
  });

  test("safety: test report URL is preserved (P1)", () => {
    const raw = [
      "> Task :app:test FAILED",
      "FAILURE: Build failed with an exception.",
      "* What went wrong:",
      "There were failing tests. See the report at: file:///path/to/report/index.html",
      "BUILD FAILED in 12s",
    ].join("\n");
    const body = runFilterBody("gradle", "gradle test", raw);
    expect(body).toContain("file:///path/to/report/index.html");
  });

  // match/reject ----------------------------------------------------------
  test("match: gradle ✓; gradlew ✓; ./gradlew ✓; ./gradlew.bat ✓", () => {
    expect(findFilterForCommand("gradle build")?.name).toBe("gradle");
    expect(findFilterForCommand("gradlew build")?.name).toBe("gradle");
    expect(findFilterForCommand("./gradlew build")?.name).toBe("gradle");
    expect(findFilterForCommand("./gradlew.bat build")?.name).toBe("gradle");
  });

  test("reject: --info passthrough (user requested detail)", () => {
    expect(findFilterForCommand("gradle build --info")).toBeNull();
    expect(findFilterForCommand("./gradlew test --info")).toBeNull();
  });

  test("reject: --debug passthrough", () => {
    expect(findFilterForCommand("gradle build --debug")).toBeNull();
  });

  test("reject: --stacktrace passthrough", () => {
    expect(findFilterForCommand("gradle test --stacktrace")).toBeNull();
  });

  test("reject: --scan passthrough (generates build-scan URL)", () => {
    expect(findFilterForCommand("gradle build --scan")).toBeNull();
  });

  test("reject: -q passthrough", () => {
    expect(findFilterForCommand("gradle build -q")).toBeNull();
  });

  test("reject: -t (--continuous shorthand) passthrough", () => {
    expect(findFilterForCommand("gradle build -t")).toBeNull();
    expect(findFilterForCommand("gradle build --continuous")).toBeNull();
  });

  // defense ---------------------------------------------------------------
  test("defense: compiler warnings are not stripped when build fails (P0)", () => {
    // On a FAILED build the sentinel does not fire, so compiler warnings that
    // precede the error are preserved.  On a SUCCESS build the sentinel collapses
    // everything — warnings are intentionally omitted (build passed).
    const raw = [
      "> Task :app:compileJava FAILED",
      "warning: [deprecation] OldApi in com.example has been deprecated",
      "1 warning",
      "FAILURE: Build failed with an exception.",
      "BUILD FAILED in 4s",
    ].join("\n");
    const body = runFilterBody("gradle", "gradle build", raw);
    expect(body).toContain("warning: [deprecation]");
    expect(body).toContain("BUILD FAILED");
  });

  test("defense: blank lines are all removed (P1)", () => {
    const raw =
      "\n\n> Task :app:compileJava UP-TO-DATE\n\n\nBUILD SUCCESSFUL in 2s\n\n";
    const body = runFilterBody("gradle", "gradle build", raw);
    expect(body).not.toMatch(/^\s*$/m);
  });
});

describe("phase 11 — mvn", () => {
  // ROI -------------------------------------------------------------------
  test("ROI: mvn-build-success cold reduces ≥ 85%", () => {
    assertReduction("mvn", "mvn package", "mvn-build-success", 85);
  });

  test("ROI: mvn-test-success (100 tests) reduces ≥ 85%", () => {
    assertReduction("mvn", "mvn test", "mvn-test-success", 85);
  });

  test("ROI: mvn-clean-install (multi-module) reduces ≥ 85%", () => {
    assertReduction("mvn", "mvn clean install", "mvn-clean-install", 85);
  });

  // strict success sentinel ----------------------------------------------
  test("sentinel: mvn clean install success collapses to ✓ mvn (strict)", () => {
    const raw = loadSample("mvn-clean-install");
    const body = runFilterBody("mvn", "mvn clean install", raw);
    expect(body.trim()).toBe("✓ mvn: BUILD SUCCESS");
  });

  test("sentinel: mvn package success collapses to ✓ mvn (strict)", () => {
    const raw = loadSample("mvn-build-success");
    const body = runFilterBody("mvn", "mvn package", raw);
    expect(body.trim()).toBe("✓ mvn: BUILD SUCCESS");
  });

  // safety ----------------------------------------------------------------
  test("safety: compile error preserves [ERROR] with path and line (P0)", () => {
    const raw = loadSample("mvn-compile-error");
    const body = runFilterBody("mvn", "mvn package", raw);
    expect(body).toContain("[ERROR]");
    expect(body).toContain("cannot find symbol");
    expect(body).toContain("BUILD FAILURE");
    expect(body).not.toMatch(/^✓ mvn/);
    // anti-noise: success-build chatter must be stripped on failure too.
    expect(body).not.toContain("Scanning for projects");
    expect(body).not.toContain("--- maven-compiler-plugin");
    expect(body).not.toContain("Copying 1 resource");
    expect(body).not.toContain("Changes detected");
    expect(body).not.toContain("Compiling 5 source files");
    expect(body).not.toMatch(/^✓ mvn/m);
  });

  test("safety: test failure preserves Surefire summary (P0)", () => {
    const raw = loadSample("mvn-test-failure");
    const body = runFilterBody("mvn", "mvn test", raw);
    expect(body).toContain("Failures:");
    expect(body).toContain("BUILD FAILURE");
    expect(body).not.toMatch(/^✓ mvn/);
    // anti-noise: plumbing lines must not survive.
    expect(body).not.toContain("Scanning for projects");
    expect(body).not.toContain("--- maven-surefire-plugin");
    expect(body).not.toMatch(/^✓ mvn/m);
  });

  test("safety: [WARNING] is not stripped when build fails (P0)", () => {
    // [WARNING] is not in any strip list and survives the strip phase.
    // On BUILD FAILURE the sentinel does not fire, so warnings remain visible.
    // On BUILD SUCCESS the sentinel collapses everything — this is acceptable
    // because a warning on a passing build does not block the work.
    const raw = [
      "[INFO] Scanning for projects...",
      "[INFO]",
      "[WARNING] Using platform encoding (UTF-8 actually) to copy filtered resources",
      "[ERROR] Some dependency could not be resolved",
      "[INFO] BUILD FAILURE",
      "[INFO] Total time: 1.5 s",
    ].join("\n");
    const body = runFilterBody("mvn", "mvn package", raw);
    expect(body).toContain("[WARNING] Using platform encoding");
  });

  test("safety: success collapses to sentinel or preserves Total time (P1)", () => {
    const raw = loadSample("mvn-build-success");
    const body = runFilterBody("mvn", "mvn package", raw);
    expect(body.trim()).toMatch(/✓ mvn: BUILD SUCCESS|Total time/);
  });

  test("safety: Tests run summary per class survives on failure (P1)", () => {
    const raw = loadSample("mvn-test-failure");
    const body = runFilterBody("mvn", "mvn test", raw);
    expect(body).toMatch(/Tests run: \d+, Failures: \d+/);
  });

  test("safety: multi-module BUILD SUCCESS collapses to sentinel (P1)", () => {
    const raw = [
      "[INFO] --- maven-compiler-plugin:3.11.0:compile (default-compile) @ core ---",
      "[INFO]",
      "[INFO] --- maven-compiler-plugin:3.11.0:compile (default-compile) @ api ---",
      "[INFO]",
      "[INFO] ------------------------------------------------------------------------",
      "[INFO] BUILD SUCCESS",
      "[INFO] ------------------------------------------------------------------------",
      "[INFO] Total time:  8.0 s",
    ].join("\n");
    const body = runFilterBody("mvn", "mvn install", raw);
    expect(body.trim()).toContain("✓ mvn: BUILD SUCCESS");
  });

  // match/reject ----------------------------------------------------------
  test("match: mvn ✓; mvnw ✓; ./mvnw ✓", () => {
    expect(findFilterForCommand("mvn package")?.name).toBe("mvn");
    expect(findFilterForCommand("mvnw package")?.name).toBe("mvn");
    expect(findFilterForCommand("./mvnw package")?.name).toBe("mvn");
  });

  test("match: common goals are all covered", () => {
    const goals = [
      "compile",
      "package",
      "clean",
      "install",
      "test",
      "verify",
      "deploy",
      "validate",
    ];
    for (const goal of goals) {
      expect(findFilterForCommand(`mvn ${goal}`)?.name).toBe("mvn");
    }
  });

  test("reject: -q passthrough", () => {
    expect(findFilterForCommand("mvn -q package")).toBeNull();
  });

  test("reject: -X passthrough (debug verbose)", () => {
    expect(findFilterForCommand("mvn -X package")).toBeNull();
  });

  test("reject: -e passthrough (error stack trace)", () => {
    expect(findFilterForCommand("mvn -e package")).toBeNull();
  });

  // defense ---------------------------------------------------------------
  test("defense: empty [INFO] lines do not leak after stripping (P0)", () => {
    const raw = "[INFO]\n[INFO] BUILD SUCCESS\n[INFO]\n";
    const body = runFilterBody("mvn", "mvn package", raw);
    expect(body).not.toContain("[INFO]\n");
  });

  test("defense: non-maven-* plugin headers are also stripped (P0)", () => {
    // Kotlin, Quarkus, Spring Boot, and exec plugins all use the same
    // `--- artifactId:version:goal ---` format but don't start with "maven-".
    const raw = [
      "[INFO] --- kotlin-maven-plugin:1.9.21:compile (compile) @ myapp ---",
      "[INFO] --- quarkus-maven-plugin:3.0.0:build (default) @ myapp ---",
      "[INFO] --- spring-boot-maven-plugin:3.2.0:repackage (repackage) @ myapp ---",
      "[INFO] --- exec-maven-plugin:3.1.0:exec (default) @ myapp ---",
      "[ERROR] Something went wrong",
      "[INFO] BUILD FAILURE",
    ].join("\n");
    const body = runFilterBody("mvn", "mvn package", raw);
    expect(body).not.toContain("kotlin-maven-plugin");
    expect(body).not.toContain("quarkus-maven-plugin");
    expect(body).not.toContain("spring-boot-maven-plugin");
    expect(body).not.toContain("exec-maven-plugin");
    expect(body).toContain("[ERROR] Something went wrong");
  });

  test("defense: Downloading from custom repo is also stripped (P1)", () => {
    const raw = [
      "[INFO] Downloading from company-nexus: https://nexus.company.com/repo/com/example/lib/1.0/lib.pom",
      "[INFO] Downloaded from company-nexus: https://nexus.company.com/repo/com/example/lib/1.0/lib.pom (4.1 kB at 200 kB/s)",
      "[INFO] BUILD SUCCESS",
    ].join("\n");
    const body = runFilterBody("mvn", "mvn package", raw);
    expect(body).not.toContain("nexus.company.com");
    expect(body.trim()).toContain("✓ mvn: BUILD SUCCESS");
  });

  test("defense: Surefire captured stdout survives on failure (P0)", () => {
    const raw = [
      "[INFO] --- maven-surefire-plugin:3.2.5:test (default-test) @ myapp ---",
      "[INFO]",
      "[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0 <<< FAILURE!",
      "[ERROR] com.example.MyTest.testFoo -- AssertionError: expected 1 but was 2",
      "[INFO]",
      "[INFO] BUILD FAILURE",
    ].join("\n");
    const body = runFilterBody("mvn", "mvn test", raw);
    expect(body).toContain("[ERROR] Tests run");
    expect(body).toContain("AssertionError: expected 1 but was 2");
  });
});
