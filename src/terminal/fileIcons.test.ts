import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import {
  CONFIG_ICON,
  EXTENSION_ICONS,
  FILENAME_ICONS,
  FOLDER_ICON,
  GENERIC_FILE_ICON,
  getFileTypeIcon,
} from 'src/terminal/fileIcons.js'

describe('getFileTypeIcon', () => {
  test('directory with trailing slash → folder', () => {
    expect(getFileTypeIcon('src/')).toBe(FOLDER_ICON)
  })

  test('nested directory with trailing separator → folder', () => {
    expect(getFileTypeIcon('src/utils/')).toBe(FOLDER_ICON)
  })

  test('directory via path.sep (cross-platform) → folder', () => {
    expect(getFileTypeIcon('src' + path.sep)).toBe(FOLDER_ICON)
  })

  test('known extensions map to their glyph', () => {
    expect(getFileTypeIcon('src/index.ts')).toBe(EXTENSION_ICONS['.ts'])
    expect(getFileTypeIcon('a.js')).toBe(EXTENSION_ICONS['.js'])
    expect(getFileTypeIcon('a.json')).toBe(EXTENSION_ICONS['.json'])
    expect(getFileTypeIcon('a.md')).toBe(EXTENSION_ICONS['.md'])
    expect(getFileTypeIcon('a.py')).toBe(EXTENSION_ICONS['.py'])
    expect(getFileTypeIcon('a.rs')).toBe(EXTENSION_ICONS['.rs'])
    expect(getFileTypeIcon('a.go')).toBe(EXTENSION_ICONS['.go'])
    expect(getFileTypeIcon('a.css')).toBe(EXTENSION_ICONS['.css'])
  })

  test('extension lookup is case-insensitive', () => {
    expect(getFileTypeIcon('Photo.PNG')).toBe(EXTENSION_ICONS['.png'])
  })

  test('special filename wins over extension', () => {
    expect(getFileTypeIcon('package.json')).toBe(FILENAME_ICONS['package.json'])
    expect(getFileTypeIcon('package.json')).not.toBe(EXTENSION_ICONS['.json'])
    expect(getFileTypeIcon('Dockerfile')).toBe(FILENAME_ICONS['dockerfile'])
    expect(getFileTypeIcon('LICENSE')).toBe(FILENAME_ICONS['license'])
    expect(getFileTypeIcon('bun.lock')).toBe(FILENAME_ICONS['bun.lock'])
  })

  test('README* prefix → markdown glyph', () => {
    expect(getFileTypeIcon('README.md')).toBe(EXTENSION_ICONS['.md'])
    expect(getFileTypeIcon('README')).toBe(EXTENSION_ICONS['.md'])
    expect(getFileTypeIcon('readme.txt')).toBe(EXTENSION_ICONS['.md'])
  })

  test('.env family → config glyph (extname-empty bug guard)', () => {
    expect(getFileTypeIcon('.env')).toBe(CONFIG_ICON)
    expect(getFileTypeIcon('.env.local')).toBe(CONFIG_ICON)
    expect(getFileTypeIcon('.env.example')).toBe(CONFIG_ICON)
  })

  test('unknown extension → generic file', () => {
    expect(getFileTypeIcon('a.xyz')).toBe(GENERIC_FILE_ICON)
  })

  test('no extension / unknown dotfile → generic file', () => {
    expect(getFileTypeIcon('Makefile')).toBe(GENERIC_FILE_ICON)
    expect(getFileTypeIcon('.editorconfig')).toBe(GENERIC_FILE_ICON)
    expect(getFileTypeIcon('bin/claudin')).toBe(GENERIC_FILE_ICON)
  })

  test('uses basename, not the full path', () => {
    expect(getFileTypeIcon('a/b/c/helpers.tsx')).toBe(EXTENSION_ICONS['.tsx'])
  })
})
