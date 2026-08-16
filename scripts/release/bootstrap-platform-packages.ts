// One-time bootstrap for the per-platform npm packages.
//
// npm's trusted publishing (OIDC) CANNOT do a package's FIRST publish — the
// npmjs.com UI requires the package to exist before you can enable a Trusted
// Publisher. So each of the 8 brand-new @claudiolabs/claudin-<platform> names
// has to be seeded once, manually, with `npm login`. This script publishes a
// tiny 0.0.0 placeholder for each so the names exist; after that you enable
// Trusted Publishing (OIDC → release-binaries.yml) per package and the pipeline
// publishes the real versions over the placeholder.
//
// The wrapper @claudiolabs/claudin already exists, so it is NOT bootstrapped
// here — it only needs its Trusted Publisher repointed at release-binaries.yml.
//
// Usage (from a machine logged into npm as a claudiolabs org member):
//   npm login                                 # interactive, needs your 2FA
//   bun run scripts/release/bootstrap-platform-packages.ts
//
// Idempotent: a name already on npm is skipped, so re-running is safe.

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PREFIX = '@claudiolabs/claudin'

// os/cpu/libc gating mirrors scripts/release/assemble-packages.ts::PLATFORMS so the
// placeholder's shape matches the real per-platform package.
const PLATFORMS: Record<
  string,
  { os: string; cpu: string; libc?: 'glibc' | 'musl' }
> = {
  'darwin-x64': { os: 'darwin', cpu: 'x64' },
  'darwin-arm64': { os: 'darwin', cpu: 'arm64' },
  'linux-x64': { os: 'linux', cpu: 'x64', libc: 'glibc' },
  'linux-arm64': { os: 'linux', cpu: 'arm64', libc: 'glibc' },
  'linux-x64-musl': { os: 'linux', cpu: 'x64', libc: 'musl' },
  'linux-arm64-musl': { os: 'linux', cpu: 'arm64', libc: 'musl' },
  'win32-x64': { os: 'win32', cpu: 'x64' },
  'win32-arm64': { os: 'win32', cpu: 'arm64' },
}

const outRoot = join(process.cwd(), 'dist', 'bootstrap')
rmSync(outRoot, { recursive: true, force: true })
mkdirSync(outRoot, { recursive: true })

let published = 0
let skipped = 0

for (const [platform, meta] of Object.entries(PLATFORMS)) {
  const name = `${PREFIX}-${platform}`

  // Already on npm? Never re-seed — the pipeline owns real versions.
  try {
    execFileSync('npm', ['view', `${name}@0.0.0`, 'version'], {
      stdio: 'ignore',
    })
    console.log(`• ${name} already exists — skipping`)
    skipped++
    continue
  } catch {
    // 404 → free to create.
  }

  const dir = join(outRoot, `claudin-${platform}`)
  mkdirSync(dir, { recursive: true })

  const pkg: Record<string, unknown> = {
    name,
    version: '0.0.0',
    description:
      `Native binary of Claudin for ${platform}. Placeholder for the first ` +
      `publish — real binaries are published by CI (release-binaries.yml). ` +
      `Do not install directly; @claudiolabs/claudin pulls the matching one ` +
      `automatically via optionalDependencies.`,
    license: 'MIT',
    repository: {
      type: 'git',
      url: 'git+https://github.com/claudio-labs/claudin.git',
    },
    homepage: 'https://github.com/claudio-labs/claudin#readme',
    os: [meta.os],
    cpu: [meta.cpu],
    ...(meta.libc ? { libc: [meta.libc] } : {}),
    publishConfig: { access: 'public' },
  }

  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  writeFileSync(
    join(dir, 'README.md'),
    `# ${name}\n\nPlaceholder \`0.0.0\`. The real ${platform} binary is published ` +
      `by Claudin's release CI. Install \`@claudiolabs/claudin\` instead — it ` +
      `resolves this package automatically for your platform.\n`,
  )

  // 2FA auth-and-writes needs an OTP per publish. Pass it via NPM_OTP so this
  // runs non-interactively; a single TOTP is usually accepted for a short burst.
  const otp = process.env.NPM_OTP
  const otpArgs = otp ? ['--otp', otp] : []

  console.log(`↑ publishing ${name}@0.0.0 …`)
  execFileSync('npm', ['publish', '--access', 'public', ...otpArgs], {
    cwd: dir,
    stdio: 'inherit', // lets npm prompt for your 2FA OTP if NPM_OTP is unset
  })
  published++
}

console.log(`\nDone — ${published} published, ${skipped} skipped.`)
console.log(
  'Next: enable Trusted Publishing (OIDC → release-binaries.yml) on each new\n' +
    'package at npmjs.com/package/<name>/access, then run the release workflow.',
)
