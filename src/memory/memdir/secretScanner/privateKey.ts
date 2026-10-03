/**
 * PEM private-key detection in linear time.
 *
 * A single "BEGIN … body … END" pattern retries the lazy body from every BEGIN
 * marker, so text full of markers and no END costs quadratic time inside the
 * file tools' input validation. Splitting it in two scans keeps it linear: a
 * key exists exactly when some END marker starts at least MIN_BODY characters
 * past the end of the earliest-closing BEGIN marker, and the first BEGIN in
 * the text, closed as early as possible, is that marker.
 */

const MARKER_LABEL = String.raw`[ A-Z0-9_-]{0,100}?PRIVATE KEY(?: BLOCK)?-----`

const BEGIN_MARKER = new RegExp(`-----BEGIN${MARKER_LABEL}`, 'i')
const END_MARKER = new RegExp(`-----END${MARKER_LABEL}`, 'i')

/** Shortest text between the markers that still counts as a key. */
const MIN_BODY = 64

export function containsPrivateKey(text: string): boolean {
  const begin = BEGIN_MARKER.exec(text)
  if (!begin) return false
  const bodyStart = begin.index + begin[0].length
  return END_MARKER.test(text.slice(bodyStart + MIN_BODY))
}
