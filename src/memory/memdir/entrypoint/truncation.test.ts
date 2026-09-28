import { describe, expect, test } from 'bun:test'
import {
  type EntrypointTruncation,
  truncateEntrypointContent,
} from 'src/memory/memdir/memdir.js'

describe('truncateEntrypointContent', () => {
  test('an empty index is one empty line of zero bytes, left as it is', () => {
    const empty: EntrypointTruncation = truncateEntrypointContent(' \n\t\n')
    expect(empty).toEqual({
      content: '',
      lineCount: 1,
      byteCount: 0,
      wasLineTruncated: false,
      wasByteTruncated: false,
    })
  })
})
