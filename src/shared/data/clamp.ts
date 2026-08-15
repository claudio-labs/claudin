/**
 * Bounds a number to the inclusive range [min, max].
 *
 * @param n The value to clamp
 * @param min Lower bound (inclusive)
 * @param max Upper bound (inclusive)
 * @returns `min` if `n < min`, `max` if `n > max`, otherwise `n`
 * @throws {RangeError} if `min > max`
 */
export function clamp(n: number, min: number, max: number): number {
  if (min > max) {
    throw new RangeError(`clamp: min (${min}) must not be greater than max (${max})`)
  }
  if (n < min) return min
  if (n > max) return max
  return n
}

/**
 * Rounds a number to the nearest integer and bounds it to the inclusive range [min, max].
 *
 * @param n The value to round and clamp
 * @param min Lower bound (inclusive)
 * @param max Upper bound (inclusive)
 * @returns `Math.round(n)` clamped so that `min <= result <= max`
 * @throws {RangeError} if `min > max`
 */
export function clampInt(n: number, min: number, max: number): number {
  return clamp(Math.round(n), min, max)
}

/**
 * Tests whether a number falls within the inclusive range [min, max].
 *
 * @param n The value to test
 * @param min Lower bound (inclusive)
 * @param max Upper bound (inclusive)
 * @returns `true` if `min <= n <= max`, otherwise `false`
 * @throws {RangeError} if `min > max`
 */
export function inRange(n: number, min: number, max: number): boolean {
  if (min > max) {
    throw new RangeError(`inRange: min (${min}) must not be greater than max (${max})`)
  }
  return n >= min && n <= max
}
