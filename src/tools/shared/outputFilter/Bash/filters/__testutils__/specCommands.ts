// One representative command per registered FilterSpec, keyed by spec `name`.
//
// Two things need a command for every spec, and neither can invent one:
//
//  1. The compound-command matrices. Real traffic is overwhelmingly `cd X && cmd`,
//     `cmd | tail -N` and `a && b` — shapes no single-command fixture exercises.
//     Generating those from THIS table (rather than hand-listing them) is what
//     makes the coverage impossible to forget: spec 105 fails the exhaustiveness
//     test the moment it is registered without an entry here.
//  2. `FIXTURE_MAP` in `scripts/bench/tokens/measure-bash-filter-roi.test.ts`,
//     which resolves filter names against the registry and silently degraded two
//     fixtures to "skipped" for pointing at names that no spec has ever had
//     (`curl-v` — the spec is called `curl`; `playwright-test` — it is
//     `playwright`). The no-orphans test here is what catches that class.
//
// Each command must MATCH its spec's `matchCommand` and NOT its
// `matchCommandReject`, and — the part that actually bites — must still resolve
// to that spec once the whole registry has had a look at it. That is asserted in
// `specCommands.test.ts`; when it fails, fix the COMMAND, never the assertion.
//
// Prefer what a developer would really type. A command tuned to satisfy a regex
// documents the regex; a realistic one documents the traffic.
//
// NOT a `.test` file — it exports data, it registers no tests.

/**
 * Spec name → a command that routes to it. Ordered to mirror `builtInFilters`
 * in `filters/index.ts`, so the two lists can be diffed by eye.
 */
export const SPEC_COMMANDS: Record<string, string> = {
  // Package managers
  'bundle-install': 'bundle install',

  // Test runners
  pytest: 'pytest tests/',
  rspec: 'rspec spec/',
  'go-test': 'go test ./...',
  'bun-test': 'bun test',
  playwright: 'npx playwright test',
  jest: 'npx jest',
  vitest: 'npx vitest run',
  mocha: 'npx mocha',

  // TypeScript compiler
  tsc: 'npx tsc --noEmit',

  // System inspection
  'ps-aux': 'ps aux',
  top: 'top -bn1',

  // Linters
  rubocop: 'rubocop',
  'ruff-check': 'ruff check .',

  // File listing / code search
  'ls-la': 'ls -la',
  'grep-rg': 'grep -rn TODO src/',

  // Git — rewrite specs. `git log -5` would be REJECTED: `-[1-9]` is in
  // GIT_LOG_REJECT, since a count flag means the model already trimmed it.
  'git-log': 'git log',
  'git-status': 'git status',

  // GitHub CLI
  'gh-pr-list': 'gh pr list',
  'gh-issue-list': 'gh issue list',
  'gh-run-list': 'gh run list',

  // Git — pipeline-only specs
  'git-blame': 'git blame src/tools/Tool.ts',
  'git-pull': 'git pull',
  'git-add': 'git add .',
  'git-commit': 'git commit -m "wip"',
  'git-push': 'git push',

  // Git — diff/show
  'git-diff': 'git diff',
  'git-show': 'git show HEAD',

  // Containers
  'docker-ps': 'docker ps',
  'docker-images': 'docker images',
  'docker-logs': 'docker logs myapp',

  // Network. The verbose spec is named `curl`, not `curl-v`.
  curl: 'curl -v https://example.com',
  dig: 'dig example.com',
  'curl-plain': 'curl https://example.com',
  wget: 'wget https://example.com/file.tar.gz',

  // System utilities
  journalctl: 'journalctl -u nginx',
  ping: 'ping -c 4 example.com',
  rsync: 'rsync -av src/ dest/',
  tree: 'tree src',
  ssh: 'ssh user@host uptime',
  df: 'df -h',
  du: 'du -sh src',
  dmesg: 'dmesg',
  stat: 'stat package.json',
  jq: 'jq . package.json',
  find: 'find src -name "*.ts"',

  // JVM build tools
  gradle: 'gradle build',
  mvn: 'mvn package',

  // Infrastructure as code
  terraform: 'terraform plan',

  // Cargo (Rust)
  'cargo-test': 'cargo test',
  'cargo-clippy': 'cargo clippy',
  'cargo-check': 'cargo check',
  'cargo-build': 'cargo build --release',
  'cargo-run': 'cargo run',
  'cargo-fmt': 'cargo fmt',

  // JS package managers + tooling
  'npm-install': 'npm install',
  'npm-run': 'npm run build',
  'pnpm-install': 'pnpm install',
  'pnpm-run': 'pnpm run build',
  'yarn-install': 'yarn install',
  eslint: 'eslint src/',
  prettier: 'prettier --write src/',
  'prisma-generate': 'npx prisma generate',
  'prisma-migrate': 'npx prisma migrate dev',

  // Universal linters
  shellcheck: 'shellcheck bin/claudin',
  yamllint: 'yamllint .github/workflows/ci.yml',
  markdownlint: 'markdownlint README.md',
  hadolint: 'hadolint Dockerfile',
  'pre-commit': 'pre-commit run --all-files',

  // Git extras + alternative VCS
  'git-fetch': 'git fetch origin',
  'git-branch': 'git branch -a',
  'git-stash': 'git stash list',
  'git-worktree': 'git worktree list',
  'glab-list': 'glab mr list',
  gt: 'gt log',
  jj: 'jj status',

  // Go toolchain
  'go-build': 'go build ./...',
  'go-vet': 'go vet ./...',
  'golangci-lint': 'golangci-lint run',

  // Python extras
  mypy: 'mypy src/',
  'pip-install': 'pip install requests',
  'ruff-format': 'ruff format src/',
  uv: 'uv sync',
  poetry: 'poetry install',
  basedpyright: 'basedpyright src/',
  ty: 'ty check src/',

  // C/C++/native
  gcc: 'gcc -O2 -o app main.c',
  make: 'make build',
  'pio-run': 'pio run',

  // .NET
  'dotnet-build': 'dotnet build',
  'dotnet-test': 'dotnet test',
  'dotnet-format': 'dotnet format',

  // PHP / Ruby / Elixir
  composer: 'composer install',
  rake: 'rake test',
  'mix-compile': 'mix compile',
  'mix-format': 'mix format',

  // Swift / Apple
  'swift-build': 'swift build',
  xcodebuild: 'xcodebuild -scheme App build',

  // JS/TS extras
  'next-build': 'next build',
  biome: 'biome check src/',
  oxlint: 'oxlint src/',
  turbo: 'turbo run build',
  nx: 'nx build myapp',

  // Java extras. gradle/mvn reject the overlap, so this reaches spring-boot
  // without depending on registry order.
  'spring-boot': 'mvn spring-boot:run',
}
