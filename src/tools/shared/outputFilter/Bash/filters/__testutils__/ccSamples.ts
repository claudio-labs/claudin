// Real captured command output for the cc filters (gcc/g++, make, pio run).
//
// NOT synthetic. Each const is verbatim output of the named tool, with a
// `// source:` pointer so the origin is auditable:
//   - rtk  → ../rtk/src/filters/<cmd>.toml `[[tests.X]]` (real captures the
//            rtk project shipped) or ../rtk/src/cmds/<lang>/<cmd>.rs.
//   - web  → CI logs / GitHub issues / docs (URL in the comment).
//
// Convention per command: an `*_OK` (success / up-to-date — exercises the
// short-circuit) and an `*_ERR` (failure / diagnostics — proves the
// `unless: HAS_ERROR` guard preserves the failure).
//
// NOT a `.test` file — pure data.

// source: ../rtk/src/filters/gcc.toml [[tests.gcc]] "strips include chain…"
export const GCC_ERR = `In file included from /usr/include/stdio.h:42:
                 from main.c:1:
main.c:10:5: error: use of undeclared identifier 'foo'
    foo();
    ^
main.c:15:12: warning: unused variable 'x' [-Wunused-variable]
    int x = 42;
        ^
2 warnings generated.
1 error generated.
`;

// source: ../rtk/src/filters/gcc.toml [[tests.gcc]] "linker error kept"
export const GCC_LINK_ERR = `/usr/bin/ld: /tmp/main.o: undefined reference to 'missing_func'
collect2: error: ld returned 1 exit status
`;

// source: ../rtk/src/filters/make.toml [[tests.make]] "strips entering/leaving"
export const MAKE_OK = `make[1]: Entering directory '/home/user'
gcc -O2 foo.c
make[1]: Leaving directory '/home/user'
`;

// source: ../rtk/src/filters/make.toml [[tests.make]] "on_empty when all stripped"
export const MAKE_NOTHING = `make[1]: Entering directory '/home/user'
make[1]: Leaving directory '/home/user'
make: Nothing to be done for 'all'.
`;

// source: ../rtk/src/filters/pio-run.toml [[tests.pio-run]] "strips build noise…"
export const PIO_ERR = `Verbose mode can be enabled via \`-v, --verbose\` option
CONFIGURATION: https://docs.platformio.org/page/boards/espressif32/esp32dev.html
LDF: Library Dependency Finder -> https://bit.ly/configure-pio-ldf
Compiling .pio/build/esp32dev/src/platform/main.cpp.o
Building .pio/build/esp32dev/firmware.elf
Linking .pio/build/esp32dev/firmware.elf
Checking size .pio/build/esp32dev/firmware.elf
src/platform/main.cpp:10:3: error: 'LED_BUILTINN' was not declared
`;

// source: ../rtk/src/filters/pio-run.toml [[tests.pio-run]] "on_empty clean build"
export const PIO_OK = `Verbose mode can be enabled via \`-v, --verbose\` option
Compiling .pio/build/esp32dev/src/platform/main.cpp.o
Linking .pio/build/esp32dev/firmware.elf
`;

// source: GNU make canonical recursive-failure format (gnu.org make manual,
// "Errors in Recipes" / "-w directory tracking"). The `*** [..] Error N` lines
// are the make failure summary and MUST survive the directory-marker strip.
export const MAKE_ERR = `make[1]: Entering directory '/home/user/proj'
gcc -O2 -c main.c
main.c:10:5: error: 'foo' undeclared (first use in this function)
make[1]: *** [Makefile:7: main.o] Error 1
make[1]: Leaving directory '/home/user/proj'
make: *** [Makefile:3: all] Error 2
`;

// source: PlatformIO docs build output (docs.platformio.org "build" — the
// memory-usage report printed after a successful link). The RAM/Flash table
// is signal and must NOT be stripped as build ceremony.
export const PIO_SIZE = `Compiling .pio/build/esp32dev/src/platform/main.cpp.o
Linking .pio/build/esp32dev/firmware.elf
Checking size .pio/build/esp32dev/firmware.elf
Advanced Memory Usage is available via "PlatformIO Home > Project Inspect"
RAM:   [=         ]   8.5% (used 27796 bytes from 327680 bytes)
Flash: [===       ]  25.7% (used 336861 bytes from 1310720 bytes)
`;
