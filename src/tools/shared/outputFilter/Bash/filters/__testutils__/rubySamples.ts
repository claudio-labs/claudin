// Real captured command output for the ruby filters (rake).
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

// source: minitest-via-rake console output (the colored runner shown when
// `rake test` drives minitest; ESC[32m green dots + blank-line runs). The
// filter strips ANSI and collapses the blank runs; the summary is signal.
export const RAKE_OK = `Running 12 tests in a single process (parallelization threshold is 50)
Run options: --seed 41955

# Running:

\x1b[32m............\x1b[0m


Finished in 0.123456s, 97.2 runs/s, 162.0 assertions/s.

12 runs, 20 assertions, 0 failures, 0 errors, 0 skips
`;

// source: treehouse community "rake aborted! db:migrate" + rails/rails#56448 —
// the verbatim `rake aborted!` failure footer (exception + backtrace +
// `Tasks: TOP => …` + the --trace hint).
export const RAKE_FAIL = `rake aborted!
ActiveRecord::PendingMigrationError: Migrations are pending. To resolve this issue, run: bin/rails db:migrate RAILS_ENV=development
/app/vendor/bundle/ruby/3.2.0/gems/activerecord-7.1.0/lib/active_record/migration.rb:611:in \`check_pending!'
Tasks: TOP => db:migrate
(See full trace by running task with --trace)
`;
