// Variables for the processes the session spawns. Callers import from this
// path; the code is in lifecycle/environment/.
export {
  clearSessionEnvVars,
  getSessionEnvVars,
} from 'src/sessions/lifecycle/environment/envVars.js'
