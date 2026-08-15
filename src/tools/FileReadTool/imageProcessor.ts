import type { Buffer } from 'buffer'
import { existsSync, readFileSync, realpathSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { isInBundledMode } from 'src/services/install/bundledMode.js'
import { logError } from 'src/shared/log.js'

export type SharpInstance = {
  metadata(): Promise<{ width: number; height: number; format: string }>
  resize(
    width: number,
    height: number,
    options?: { fit?: string; withoutEnlargement?: boolean },
  ): SharpInstance
  jpeg(options?: { quality?: number }): SharpInstance
  png(options?: {
    compressionLevel?: number
    palette?: boolean
    colors?: number
  }): SharpInstance
  webp(options?: { quality?: number }): SharpInstance
  toBuffer(): Promise<Buffer>
}

export type SharpFunction = (input: Buffer) => SharpInstance

type SharpCreatorOptions = {
  create: {
    width: number
    height: number
    channels: 3 | 4
    background: { r: number; g: number; b: number }
  }
}

type SharpCreator = (options: SharpCreatorOptions) => SharpInstance

let imageProcessorModule: { default: SharpFunction } | null = null
let imageCreatorModule: { default: SharpCreator } | null = null

// undefined = not yet probed, null = probed and absent.
let vendoredSharp: SharpFunction | null | undefined

/**
 * Resolve the sharp runtime vendored beside a compiled standalone binary.
 *
 * The Bun-compiled binary keeps `sharp` external (scripts/build.ts) but has no
 * node_modules next to it, so the bare `import('sharp')` fails. The release
 * packages ship a self-contained sharp install at vendor/sharp/node_modules/
 * (scripts/vendor-sharp.ts), mirrored beside the executable at install time
 * (install.cjs). Probe it via dirname(process.execPath) — realpath-resolved
 * first, because the npm global bin is a symlink into node_modules and its
 * dirname has no vendor/ (same reasoning as src/shared/fs/ripgrep.ts). Returns null
 * in dev / the Node bundle, where this path doesn't exist and the normal import
 * already succeeded.
 */
function resolveVendoredSharp(): SharpFunction | null {
  if (vendoredSharp !== undefined) return vendoredSharp
  try {
    let execDir: string
    try {
      execDir = dirname(realpathSync(process.execPath))
    } catch {
      execDir = dirname(process.execPath)
    }
    const sharpDir = join(execDir, 'vendor', 'sharp', 'node_modules', 'sharp')
    const sharpPkgJson = join(sharpDir, 'package.json')
    if (!existsSync(sharpPkgJson)) {
      vendoredSharp = null
      return null
    }
    // Require sharp's main file by ABSOLUTE PATH: a Bun standalone binary's
    // resolver ignores package.json `main` for external bare specifiers, so
    // `require('sharp')` would fail — but an explicit file path loads, and
    // sharp's own nested requires then resolve against the vendored tree
    // (scripts/vendor-sharp.ts adds the index.js shims / native-addon redirect
    // that Bun's resolver needs).
    const main =
      (JSON.parse(readFileSync(sharpPkgJson, 'utf8')) as { main?: string })
        .main || 'index.js'
    const req = createRequire(sharpPkgJson)
    const imported = req(join(sharpDir, main)) as MaybeDefault<SharpFunction>
    vendoredSharp = unwrapDefault(imported)
    return vendoredSharp
  } catch (e) {
    logError(e as Error)
    vendoredSharp = null
    return null
  }
}

/**
 * Error thrown when no image processor is available (e.g., in the open build
 * where sharp and image-processor-napi are stubbed out).
 */
export class ImageProcessorUnavailableError extends Error {
  constructor() {
    super('No image processor available (sharp is not installed)')
    this.name = 'ImageProcessorUnavailableError'
  }
}

export async function getImageProcessor(): Promise<SharpFunction> {
  if (imageProcessorModule) {
    return imageProcessorModule.default
  }

  if (isInBundledMode()) {
    // Try to load the native image processor first
    try {
      // Use the native image processor module
      const imageProcessor = await import('image-processor-napi')
      if ((imageProcessor as { __stub?: boolean }).__stub) {
        throw new ImageProcessorUnavailableError()
      }
      const sharp = imageProcessor.sharp || imageProcessor.default
      imageProcessorModule = { default: sharp }
      return sharp
    } catch {
      // Fall back to sharp if native module is not available (e.g. stubbed
      // in this fork, where image-processor-napi is an Anthropic-internal
      // package replaced by the build with a noop module).
    }
  }

  // Use sharp for non-bundled builds or as fallback.
  // Single structural cast: our SharpFunction is a subset of sharp's actual type surface.
  try {
    const imported = (await import(
      'sharp'
    )) as unknown as MaybeDefault<SharpFunction> & { __stub?: boolean }
    if (imported && (imported as { __stub?: boolean }).__stub) {
      throw new ImageProcessorUnavailableError()
    }
    const sharp = unwrapDefault(imported as MaybeDefault<SharpFunction>)
    imageProcessorModule = { default: sharp }
    return sharp
  } catch (e) {
    // The standalone compiled binary has no node_modules beside it, so the
    // bare `import('sharp')` above fails (or resolves to the build stub). Fall
    // back to the sharp runtime vendored next to the executable.
    const vendored = resolveVendoredSharp()
    if (vendored) {
      imageProcessorModule = { default: vendored }
      return vendored
    }
    if (e instanceof ImageProcessorUnavailableError) throw e
    throw new ImageProcessorUnavailableError()
  }
}

/**
 * Get image creator for generating new images from scratch.
 * Note: image-processor-napi doesn't support image creation,
 * so this always uses sharp directly.
 */
export async function getImageCreator(): Promise<SharpCreator> {
  if (imageCreatorModule) {
    return imageCreatorModule.default
  }

  try {
    const imported = (await import(
      'sharp'
    )) as unknown as MaybeDefault<SharpCreator> & { __stub?: boolean }
    if (imported && (imported as { __stub?: boolean }).__stub) {
      throw new ImageProcessorUnavailableError()
    }
    const sharp = unwrapDefault(imported)
    imageCreatorModule = { default: sharp }
    return sharp
  } catch (e) {
    // Vendored sharp (compiled binary) exposes the same create() surface.
    const vendored = resolveVendoredSharp() as unknown as SharpCreator | null
    if (vendored) {
      imageCreatorModule = { default: vendored }
      return vendored
    }
    if (e instanceof ImageProcessorUnavailableError) throw e
    throw new ImageProcessorUnavailableError()
  }
}

// Dynamic import shape varies by module interop mode — ESM yields { default: fn }, CJS yields fn directly.
type MaybeDefault<T> = T | { default: T }

function unwrapDefault<T extends (...args: never[]) => unknown>(
  mod: MaybeDefault<T>,
): T {
  return typeof mod === 'function' ? mod : mod.default
}
