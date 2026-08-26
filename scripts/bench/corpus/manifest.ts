// ---------------------------------------------------------------------------
// manifest — pinned multi-language corpus for the outline/symbol A/B bench
// ---------------------------------------------------------------------------
//
// This repo is TypeScript. The outline scanner is not: `scanSymbols` carries a
// C-like engine shared by TS/JS, Java, C#, C, Rust, Kotlin, Swift, Scala, PHP,
// Dart, Groovy, GraphQL and Terraform, plus dedicated scanners for Python,
// Ruby, Lua, SQL and the markup/config family. A change to the shared engine
// therefore cannot be validated against `src/` alone — there is not one Java,
// C# or Go file in the tree.
//
// So the bench corpus is FETCHED and PINNED: one source tarball per language at
// a fixed tag, cached under ~/.cache/claudin-bench-corpus/. A pinned tag is
// what makes a run reproducible across machines and across the before/after
// pair the A/B compares — an unpinned `main` would silently re-sample the
// corpus between the two halves of the measurement.
//
// Nothing here is redistributed: the tarballs land in the user's cache
// directory and are never committed or bundled.
// ---------------------------------------------------------------------------

import type { OutlineLang } from '../../../src/tools/shared/codeOutline/scanSymbols.js'

/** A source downloaded from GitHub at a pinned tag. */
export type RemoteSource = {
  lang: OutlineLang
  owner: string
  repo: string
  /** Git tag. Verified to resolve on codeload before being written here. */
  tag: string
  /**
   * Paths inside the tarball to scan, relative to the repo root. Keeps the
   * sample on library code instead of tests, examples and vendored trees.
   */
  subdirs: string[]
  /** Extensions to collect, without the dot. */
  extensions: string[]
}

/** Source already on disk — no download, no network. */
export type LocalSource = {
  lang: OutlineLang
  /** Directories relative to the repo root. */
  dirs: string[]
  extensions: string[]
}

/**
 * Languages the scanner change actually touches (the declaration-shape gate is
 * switched on for their detectors). `loadCorpus` throws when one of these is
 * missing rather than quietly measuring four cells instead of five — a gate
 * that silently drops its subject is worse than no gate.
 */
export const GATE_LANGS: readonly OutlineLang[] = [
  'typescript',
  'javascript',
  'java',
  'csharp',
  'c',
]

export const REMOTE_SOURCES: readonly RemoteSource[] = [
  {
    lang: 'javascript',
    owner: 'expressjs',
    repo: 'express',
    tag: '4.21.2',
    subdirs: ['lib', 'test'],
    extensions: ['js'],
  },
  // A second JS source: express/lib alone is 11 files, too thin for a median
  // per size bucket. axios/lib adds ~40 modern-idiom files (classes, arrow
  // members, promise chains) that express's 2010-era style does not cover.
  {
    lang: 'javascript',
    owner: 'axios',
    repo: 'axios',
    tag: 'v1.7.9',
    subdirs: ['lib', 'test/unit'],
    extensions: ['js'],
  },
  {
    lang: 'java',
    owner: 'google',
    repo: 'gson',
    tag: 'gson-parent-2.11.0',
    subdirs: ['gson/src/main'],
    extensions: ['java'],
  },
  {
    lang: 'csharp',
    owner: 'JamesNK',
    repo: 'Newtonsoft.Json',
    tag: '13.0.3',
    subdirs: ['Src/Newtonsoft.Json'],
    extensions: ['cs'],
  },
  {
    lang: 'c',
    owner: 'curl',
    repo: 'curl',
    tag: 'curl-8_11_1',
    subdirs: ['lib', 'src'],
    extensions: ['c', 'h'],
  },
  {
    lang: 'go',
    owner: 'gin-gonic',
    repo: 'gin',
    tag: 'v1.10.0',
    subdirs: ['.'],
    extensions: ['go'],
  },
  {
    lang: 'rust',
    owner: 'serde-rs',
    repo: 'serde',
    tag: 'v1.0.215',
    subdirs: ['serde/src', 'serde_derive/src'],
    extensions: ['rs'],
  },
  {
    lang: 'kotlin',
    owner: 'Kotlin',
    repo: 'kotlinx.coroutines',
    tag: '1.9.0',
    subdirs: ['kotlinx-coroutines-core'],
    extensions: ['kt'],
  },
  {
    lang: 'swift',
    owner: 'apple',
    repo: 'swift-argument-parser',
    tag: '1.5.0',
    subdirs: ['Sources'],
    extensions: ['swift'],
  },
  {
    lang: 'php',
    owner: 'guzzle',
    repo: 'guzzle',
    tag: '7.9.2',
    subdirs: ['src'],
    extensions: ['php'],
  },
  {
    lang: 'ruby',
    owner: 'sinatra',
    repo: 'sinatra',
    tag: 'v4.1.1',
    subdirs: ['lib', 'rack-protection/lib'],
    extensions: ['rb'],
  },
  {
    lang: 'python',
    owner: 'psf',
    repo: 'requests',
    tag: 'v2.32.3',
    subdirs: ['src'],
    extensions: ['py'],
  },
]

export const LOCAL_SOURCES: readonly LocalSource[] = [
  // The subject of the whole exercise: this repo is the TS corpus.
  { lang: 'typescript', dirs: ['src'], extensions: ['ts', 'tsx'] },
  {
    lang: 'python',
    dirs: ['docs/archive/python-smart-router'],
    extensions: ['py'],
  },
  // The only C/C++ on disk before the fetch — kept so a no-network run still
  // has something in the `c` cell.
  { lang: 'c', dirs: ['node_modules/sharp/src'], extensions: ['c', 'h', 'cc'] },
]

/** Cache key / directory name for a remote source. */
export function sourceDirName(src: RemoteSource): string {
  return `${src.lang}-${src.repo}-${src.tag}`.replace(/[^\w.-]/g, '_')
}

export function tarballUrl(src: RemoteSource): string {
  return `https://codeload.github.com/${src.owner}/${src.repo}/tar.gz/refs/tags/${src.tag}`
}
