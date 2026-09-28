// Session-storage helpers that load on their own. The bridge and the lite
// metadata reader import this module without the app's bootstrap state, and
// the test suite bundles it alone to run it under Node, so nothing behind it
// may import the session-storage barrel, bootstrap state or logging.

export { validateUuid } from 'src/shared/data/uuid.js'
export {
  extractJsonStringField,
  extractLastJsonStringField,
} from 'src/sessions/sessionStoragePortable/jsonStringField.js'
export {
  LITE_READ_BUF_SIZE,
  readHeadAndTail,
} from 'src/sessions/sessionStoragePortable/headAndTail.js'
export {
  getProjectDir,
  getProjectsDir,
  sanitizePath,
} from 'src/sessions/sessionStoragePortable/projectDirectory.js'
export {
  readTranscriptForLoad,
  SKIP_PRECOMPACT_THRESHOLD,
} from 'src/sessions/sessionStoragePortable/transcriptForLoad.js'
