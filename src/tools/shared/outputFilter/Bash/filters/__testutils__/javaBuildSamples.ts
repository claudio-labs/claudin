// Real captured command output for the java-build filters (spring-boot).
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

// source: ../rtk/src/filters/spring-boot.toml [[tests.spring-boot]] "startup"
export const SPRING_OK = `  .   ____          _
 /\\\\ / ___'_ __ _ _(_)_ __
  :: Spring Boot ::  (v3.2.0)
2024-01-01 INFO Initializing Spring
2024-01-01 INFO Bean 'dataSource' created
2024-01-01 INFO Tomcat started on port 8080
2024-01-01 INFO Started MyApp in 3.2 seconds
`;

// source: ../rtk/src/filters/spring-boot.toml [[tests.spring-boot]] "errors"
export const SPRING_ERR = `  :: Spring Boot ::  (v3.2.0)
2024-01-01 INFO Initializing Spring
2024-01-01 ERROR Application run failed
Caused by: java.lang.NullPointerException
`;
