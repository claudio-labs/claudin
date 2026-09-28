// The environment hooks leave for the session's shell commands. Callers import
// from this path; the code is in lifecycle/environment/.
export {
  clearCwdEnvFiles,
  getHookEnvFilePath,
} from 'src/sessions/lifecycle/environment/envDirectory.js'
export {
  getSessionEnvironmentScript,
  invalidateSessionEnvCache,
} from 'src/sessions/lifecycle/environment/environmentScript.js'
