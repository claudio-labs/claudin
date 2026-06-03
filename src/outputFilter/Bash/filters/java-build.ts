// Java build tool filters: gradle/gradlew, mvn/mvnw.
//
// gradle: Cold builds emit a Daemon banner, dependency-resolution chatter,
// and then one `> Task :module:taskName [STATUS]` line per task.  Tasks that
// ran successfully show no status suffix; UP-TO-DATE / FROM-CACHE / SKIPPED /
// NO-SOURCE are all noise.  On a clean success we collapse to a one-line
// sentinel.  We never filter when the user passes verbose flags (--info,
// --debug, --stacktrace, --scan) because they explicitly asked for detail.
//
// mvn: Every lifecycle line carries a `[INFO]` prefix, which makes the noise
// ratio extreme on a cold build with downloads.  We strip all the predictable
// boilerplate (`[INFO]` blank lines, separator bars, plugin headers,
// Downloading/Downloaded lines) but keep `[WARNING]` and `[ERROR]` intact
// as they are always signal.
//
// Regex are declared at module level — see .claudin/rules/typescript-patterns.md #3.

import type { FilterSpec } from '../types.js'

// ==========================================================================
// gradle / gradlew
// ==========================================================================

const GRADLE_DAEMON_BANNER = /^(?:Starting a Gradle Daemon|Daemon will be stopped|Welcome to Gradle)/
const GRADLE_CONFIGURE = /^> Configur(?:ing|e) project /
const GRADLE_RESOLVING = /^> Resolving dependencies/
const GRADLE_TRANSFORM = /^> Transform /
const GRADLE_DOWNLOADING = /^Download(?:ing)?\s+https?:/
const GRADLE_PROGRESS = /^\s*<[-=]+>\s+\d+%/
// Tasks with a terminal status suffix are pure noise; tasks without one executed
// and are signal.  Patterns below match only the suffixed forms.
const GRADLE_UP_TO_DATE = /^> Task \S+\s+UP-TO-DATE\s*$/
const GRADLE_NO_SOURCE = /^> Task \S+\s+NO-SOURCE\s*$/
const GRADLE_FROM_CACHE = /^> Task \S+\s+FROM-CACHE\s*$/
const GRADLE_SKIPPED = /^> Task \S+\s+SKIPPED\s*$/
const GRADLE_BLANK = /^\s*$/

const GRADLE_OK = /^BUILD SUCCESSFUL in /m
// FAILED can appear on a task line OR on the BUILD FAILED summary.
const GRADLE_HAS_PROBLEM = /\bFAILED\b|tests? completed.*\bfailed\b/i

const GRADLE_MATCH = /^(gradle|gradlew|\.\/gradlew?)(?:\b|\.bat)/
// Pass through when the user explicitly requested verbose output, a build
// scan URL (--scan generates a URL we want the model to see), or continuous
// watch mode (output changes over time — filtering would be confusing).
const GRADLE_REJECT = /(?:^|\s)(?:-q\b|--quiet|--info|--debug|--stacktrace|--scan|--continuous|-t\b)\b/

export const gradle: FilterSpec = {
  name: 'gradle',
  matchCommand: GRADLE_MATCH,
  matchCommandReject: GRADLE_REJECT,
  stripAnsi: true,
  stripLinesMatching: [
    GRADLE_DAEMON_BANNER,
    GRADLE_CONFIGURE,
    GRADLE_RESOLVING,
    GRADLE_TRANSFORM,
    GRADLE_DOWNLOADING,
    GRADLE_PROGRESS,
    GRADLE_UP_TO_DATE,
    GRADLE_NO_SOURCE,
    GRADLE_FROM_CACHE,
    GRADLE_SKIPPED,
    GRADLE_BLANK,
  ],
  matchOutput: [
    {
      pattern: GRADLE_OK,
      unless: GRADLE_HAS_PROBLEM,
      message: '✓ gradle: BUILD SUCCESSFUL',
    },
  ],
  maxLines: 50,
  truncateLineAt: 200,
}

// ==========================================================================
// mvn / mvnw
// ==========================================================================

// Separator lines: `[INFO] ---...---` and `[INFO] ---< com.example:app >---`
const MVN_STRIP_SEPARATOR = /^\[INFO\]\s*-{3,}/
// Scanning / project banner lines
const MVN_STRIP_SCANNING = /^\[INFO\]\s+Scanning for projects/
const MVN_STRIP_BUILDING = /^\[INFO\]\s+Building\s/
// Artifact download chatter (central or any custom repo name)
const MVN_STRIP_DOWNLOADING = /^\[INFO\]\s+Downloading from\b/
const MVN_STRIP_DOWNLOADED = /^\[INFO\]\s+Downloaded from\b/
const MVN_STRIP_PROGRESS = /^\[INFO\]\s+Progress \(/
// Blank [INFO] lines (extremely common — separators between phases)
const MVN_STRIP_BLANK_INFO = /^\[INFO\]\s*$/
// Plugin execution headers follow the format `--- artifactId:version:goal ---`,
// regardless of which plugin it is.  Matching the `--- word:word:word` structure
// catches all plugins: maven-compiler, kotlin-maven-plugin, quarkus-maven-plugin,
// spring-boot-maven-plugin, exec-maven-plugin, etc.
const MVN_STRIP_PLUGIN_HEADER = /^\[INFO\]\s+--- \S+:\S+:\S+/
// Incremental build / resource copy / compile notifications (pure noise)
const MVN_STRIP_CHANGES = /^\[INFO\]\s+Changes detected/
const MVN_STRIP_COPYING = /^\[INFO\]\s+Copying \d+ resource/
const MVN_STRIP_COMPILING = /^\[INFO\]\s+Compiling \d+ source files/
const MVN_STRIP_BUILDING_JAR = /^\[INFO\]\s+Building jar:/
const MVN_STRIP_SKIP_NONEXIST = /^\[INFO\]\s+skip non existing/
const MVN_STRIP_NO_SOURCES = /^\[INFO\]\s+No sources to compile/
const MVN_STRIP_BLANK = /^\s*$/

const MVN_OK = /^\[INFO\]\s+BUILD SUCCESS/m
// [ERROR] lines or BUILD FAILURE summary indicate a bad build — suppress the
// sentinel so the model sees raw output.  We intentionally do NOT match
// "Failures:" here because Surefire also emits "Failures: 0" on successful
// runs (e.g. `Tests run: 100, Failures: 0`), which would prevent the sentinel
// from firing.  All actual test-failure lines already carry the [ERROR] prefix.
const MVN_HAS_PROBLEM = /\[ERROR\]|\bBUILD FAILURE\b/

const MVN_MATCH = /^(mvn|mvnw|\.\/mvnw?)(?:\b|\.cmd)/
// -q = quiet (user wants minimal output — don't filter on top of that)
// -X = debug (full verbose output)
// -e = show stack trace on errors (user is debugging)
const MVN_REJECT = /(?:^|\s)(?:-q|--quiet|-X\b|-e\b)\b/

export const mvn: FilterSpec = {
  name: 'mvn',
  matchCommand: MVN_MATCH,
  matchCommandReject: MVN_REJECT,
  stripAnsi: true,
  stripLinesMatching: [
    MVN_STRIP_SEPARATOR,
    MVN_STRIP_SCANNING,
    MVN_STRIP_BUILDING,
    MVN_STRIP_DOWNLOADING,
    MVN_STRIP_DOWNLOADED,
    MVN_STRIP_PROGRESS,
    MVN_STRIP_BLANK_INFO,
    MVN_STRIP_PLUGIN_HEADER,
    MVN_STRIP_CHANGES,
    MVN_STRIP_COPYING,
    MVN_STRIP_COMPILING,
    MVN_STRIP_BUILDING_JAR,
    MVN_STRIP_SKIP_NONEXIST,
    MVN_STRIP_NO_SOURCES,
    MVN_STRIP_BLANK,
  ],
  matchOutput: [
    {
      pattern: MVN_OK,
      unless: MVN_HAS_PROBLEM,
      message: '✓ mvn: BUILD SUCCESS',
    },
  ],
  maxLines: 60,
  truncateLineAt: 500,
}
