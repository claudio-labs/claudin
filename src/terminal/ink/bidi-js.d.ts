// `bidi-js` ships no type declarations. Mirrors the object the factory returns
// (see node_modules/bidi-js/dist/bidi.mjs, the `exports.*` block at the end).
declare module 'bidi-js' {
  type Paragraph = { start: number; end: number; level: number }

  type EmbeddingLevels = {
    levels: Uint8Array
    paragraphs: Paragraph[]
  }

  /** `[start, end]` index pairs whose characters must be reversed, in order. */
  type ReorderSegment = [number, number]

  type Bidi = {
    getEmbeddingLevels(
      text: string,
      baseDirection?: 'ltr' | 'rtl' | 'auto',
    ): EmbeddingLevels
    getReorderSegments(
      text: string,
      embeddingLevelsResult: EmbeddingLevels,
      start?: number,
      end?: number,
    ): ReorderSegment[]
    getReorderedIndices(
      text: string,
      embeddingLevelsResult: EmbeddingLevels,
      start?: number,
      end?: number,
    ): number[]
    getReorderedString(
      text: string,
      embeddingLevelsResult: EmbeddingLevels,
      start?: number,
      end?: number,
    ): string
    getBidiCharType(char: string): number
    getBidiCharTypeName(char: string): string
    getMirroredCharacter(char: string): string | null
    getMirroredCharactersMap(
      text: string,
      embeddingLevelsResult: EmbeddingLevels,
      start?: number,
      end?: number,
    ): Map<number, string>
    getCanonicalBracket(char: string): string | null
    closingToOpeningBracket(char: string): string | null
    openingToClosingBracket(char: string): string | null
  }

  export default function bidiFactory(): Bidi
}
