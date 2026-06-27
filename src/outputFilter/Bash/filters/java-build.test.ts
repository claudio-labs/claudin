// Phase 13 — java-extras family (spring-boot) + the gradle/mvn overlap fix.
import { describe, expect, test } from "bun:test";
import { runFilterBody, routesTo } from "./__testutils__/harness.js";
import { SPRING_OK, SPRING_ERR } from "./__testutils__/phase13Samples.js";

describe("phase 13 — spring-boot", () => {
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

describe("phase 13 — gradle/mvn warning survival", () => {
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

describe("phase 13 — gradle/mvn clean collapse", () => {
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
