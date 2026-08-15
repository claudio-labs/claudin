// Phase 13 — cc family (gcc/g++, make, pio run). Real captured output lives in
// __testutils__/phase13Samples.ts; helpers in __testutils__/harness.ts.
import { describe, expect, test } from "bun:test";
import { runFilterBody, reductionPct, routesTo } from "src/tools/shared/outputFilter/Bash/filters/__testutils__/harness.js";
import {
  GCC_ERR,
  GCC_LINK_ERR,
  MAKE_OK,
  MAKE_NOTHING,
  MAKE_ERR,
  PIO_ERR,
  PIO_OK,
  PIO_SIZE,
} from "src/tools/shared/outputFilter/Bash/filters/__testutils__/phase13Samples.js";

describe("phase 13 — gcc", () => {
  test("strips include chain + tallies, keeps diagnostics and carets", () => {
    const body = runFilterBody("gcc", "gcc -O2 main.c", GCC_ERR);
    expect(body).not.toContain("In file included from");
    expect(body).not.toContain("from main.c:1:");
    expect(body).not.toContain("warnings generated");
    expect(body).not.toContain("error generated");
    expect(body).toContain("error: use of undeclared identifier 'foo'");
    expect(body).toContain("warning: unused variable 'x'");
    expect(body).toContain("foo();");
    expect(reductionPct(GCC_ERR, body)).toBeGreaterThan(20);
  });

  test("linker error passes through raw", () => {
    const body = runFilterBody("gcc", "gcc main.o -o app", GCC_LINK_ERR);
    expect(body).toContain("undefined reference to 'missing_func'");
    expect(body).toContain("collect2: error: ld returned 1 exit status");
  });

  test("routes gcc / g++ / versioned compilers", () => {
    expect(routesTo("gcc -O2 main.c")).toBe("gcc");
    expect(routesTo("g++ -std=c++20 main.cpp")).toBe("gcc");
    expect(routesTo("gcc-13 main.c")).toBe("gcc");
    expect(routesTo("g++-14 a.cpp")).toBe("gcc");
  });

  test("negative: dependency-gen and unrelated commands do not route to gcc", () => {
    expect(routesTo("gcc -MM main.c")).not.toBe("gcc"); // -M/-MM = makefile deps, keep raw
    expect(routesTo("grep foo bar")).not.toBe("gcc");
    expect(routesTo("gccfoo --help")).not.toBe("gcc"); // word boundary
  });
});

describe("phase 13 — make", () => {
  test("strips Entering/Leaving directory, keeps the recipe echo", () => {
    const body = runFilterBody("make", "make", MAKE_OK).trim();
    expect(body).toBe("gcc -O2 foo.c");
    expect(body).not.toContain("Entering directory");
    expect(body).not.toContain("Leaving directory");
  });

  test("all-noise build collapses to onEmpty sentinel", () => {
    expect(runFilterBody("make", "make", MAKE_NOTHING).trim()).toBe("make: ok");
  });

  test("regression: a ≥2 blank-line run between stripped markers still hits onEmpty (no ` (×N)` artifact)", () => {
    // collapseRuns turns the blank run into ` (×2)`; before the root
    // collapseIdenticalRuns fix that line survived the marker strip and defeated
    // the onEmpty sentinel, leaving a bare ` (×2)` body.
    const raw =
      "make[1]: Entering directory '/home/user'\n\n\nmake[1]: Leaving directory '/home/user'\n";
    const body = runFilterBody("make", "make", raw).trim();
    expect(body).not.toContain("(×");
    expect(body).toBe("make: ok");
  });

  test("*** Error summary lines are never stripped", () => {
    const body = runFilterBody("make", "make -j4", MAKE_ERR);
    expect(body).not.toContain("Entering directory");
    expect(body).toContain("main.c:10:5: error: 'foo' undeclared");
    expect(body).toContain("*** [Makefile:7: main.o] Error 1");
    expect(body).toContain("*** [Makefile:3: all] Error 2");
  });

  test("routes make, not lookalikes", () => {
    expect(routesTo("make -j4")).toBe("make");
    expect(routesTo("make all")).toBe("make");
    expect(routesTo("makensis installer.nsi")).not.toBe("make"); // word boundary
  });
});

describe("phase 13 — pio run", () => {
  test("strips build ceremony, keeps the compiler error", () => {
    const body = runFilterBody("pio-run", "pio run", PIO_ERR).trim();
    expect(body).toBe("src/platform/main.cpp:10:3: error: 'LED_BUILTINN' was not declared");
    expect(body).not.toContain("Compiling");
    expect(body).not.toContain("Linking");
  });

  test("clean build collapses to onEmpty sentinel", () => {
    expect(runFilterBody("pio-run", "pio run -e esp32dev", PIO_OK).trim()).toBe(
      "pio run: ok",
    );
  });

  test("RAM/Flash usage table is preserved (signal, not ceremony)", () => {
    const body = runFilterBody("pio-run", "pio run", PIO_SIZE);
    expect(body).toContain("RAM:   [=         ]   8.5%");
    expect(body).toContain("Flash: [===       ]  25.7%");
    expect(body).not.toContain("Compiling");
    expect(body).not.toContain("Linking");
  });

  test("routes pio run", () => {
    expect(routesTo("pio run")).toBe("pio-run");
    expect(routesTo("pio run -t upload")).toBe("pio-run");
    expect(routesTo("pio device list")).not.toBe("pio-run");
  });
});
