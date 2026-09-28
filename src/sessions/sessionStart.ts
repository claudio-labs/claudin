// The SessionStart and Setup hooks. Callers import from this path; the code is
// in lifecycle/startHooks/.
export { takeInitialUserMessage } from 'src/sessions/lifecycle/startHooks/initialUserMessage.js'
export {
  processSessionStartHooks,
  processSetupHooks,
} from 'src/sessions/lifecycle/startHooks/startHooks.js'
