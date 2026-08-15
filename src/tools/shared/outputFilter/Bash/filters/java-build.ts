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

import type { FilterSpec } from 'src/tools/shared/outputFilter/Bash/types.js'

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
// FAILED can appear on a task line OR on the BUILD FAILED summary. Warnings and
// deprecation notices also suppress the sentinel: a BUILD SUCCESSFUL (exit 0)
// can still carry `warning:` / "Deprecated Gradle features were used" lines that
// collapsing to the one-line sentinel would silently drop. `deprecat` is anchored
// to its real inflections so an unrelated identifier (e.g. a `:deprecator:` module
// path on a clean build) can't spuriously suppress the collapse.
const GRADLE_HAS_PROBLEM =
  /\bFAILED\b|tests? completed.*\bfailed\b|\bwarning\b|deprecat(?:e|ed|es|ion|ing)/i

const GRADLE_MATCH = /^(gradle|gradlew|\.\/gradlew?)(?:\b|\.bat)/
// Pass through when the user explicitly requested verbose output, a build
// scan URL (--scan generates a URL we want the model to see), or continuous
// watch mode (output changes over time — filtering would be confusing).
// `bootRun` is claimed by the spring-boot spec (Phase 13) — reject it here so
// the two filters never both match `gradle …bootRun`.
const GRADLE_REJECT = /(?:^|\s)(?:-q\b|--quiet|--info|--debug|--stacktrace|--scan|--continuous|-t\b)\b|\bbootRun\b/

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
// [ERROR]/[WARNING] lines or a BUILD FAILURE summary suppress the sentinel so
// the model sees raw output.  The sentinel REPLACES the whole body, so without
// the [WARNING] guard a successful build would silently drop the very [WARNING]
// lines this filter otherwise keeps (see header comment).  We intentionally do
// NOT match "Failures:" here because Surefire also emits "Failures: 0" on
// successful runs (e.g. `Tests run: 100, Failures: 0`), which would prevent the
// sentinel from firing.  All actual test-failure lines already carry [ERROR].
const MVN_HAS_PROBLEM = /\[ERROR\]|\[WARNING\]|\bBUILD FAILURE\b/

const MVN_MATCH = /^(mvn|mvnw|\.\/mvnw?)(?:\b|\.cmd)/
// -q = quiet (user wants minimal output — don't filter on top of that)
// -X = debug (full verbose output)
// -e = show stack trace on errors (user is debugging)
// `spring-boot:run` is claimed by the spring-boot spec (Phase 13).
const MVN_REJECT = /(?:^|\s)(?:-q|--quiet|-X\b|-e\b)\b|\bspring-boot:run\b/

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

// ==========================================================================
// Phase 13 — Spring Boot (mvn spring-boot:run / gradle bootRun).
// ==========================================================================
//
// Startup logs are mostly boot ceremony (banner + per-bean INFO). We keep only
// the lines that matter: the "Started <app> in Ns" / "Tomcat started" summary,
// and any WARN/ERROR/Exception/BUILD/test line. `java -jar *.jar` is
// intentionally NOT matched (it would claim any jar run); only the build-tool
// run goals are. The `java -jar` form from rtk is dropped on purpose.
//
// keepLinesMatching is a whitelist — every kept regex below is a "signal" row.

const SPRING_BOOT_MATCH = /^(?:mvn\s+spring-boot:run\b|(?:\.\/)?gradlew?\s.*\bbootRun\b)/
const SPRING_KEEP_STARTED = /Started\s.*\sin\s/
const SPRING_KEEP_TOMCAT = /Tomcat started on port/
const SPRING_KEEP_LISTENING = /listening on port/
const SPRING_KEEP_ERROR = /\bERROR\b/
const SPRING_KEEP_WARN = /\bWARN\b/
const SPRING_KEEP_EXCEPTION = /Exception/
const SPRING_KEEP_CAUSED_BY = /Caused by:/
const SPRING_KEEP_RUN_FAILED = /Application run failed/
const SPRING_KEEP_BUILD = /\bBUILD\b/
const SPRING_KEEP_TESTS = /Tests run:/
const SPRING_KEEP_FAILURE = /FAILURE/

export const springBoot: FilterSpec = {
  name: 'spring-boot',
  matchCommand: SPRING_BOOT_MATCH,
  stripAnsi: true,
  keepLinesMatching: [
    SPRING_KEEP_STARTED,
    SPRING_KEEP_TOMCAT,
    SPRING_KEEP_LISTENING,
    SPRING_KEEP_ERROR,
    SPRING_KEEP_WARN,
    SPRING_KEEP_EXCEPTION,
    SPRING_KEEP_CAUSED_BY,
    SPRING_KEEP_RUN_FAILED,
    SPRING_KEEP_BUILD,
    SPRING_KEEP_TESTS,
    SPRING_KEEP_FAILURE,
  ],
  maxLines: 30,
}
