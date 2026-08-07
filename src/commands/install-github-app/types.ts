// Reconstructed from its use sites — the original module was not carried into
// this fork. `State` mirrors the `INITIAL_STATE` literal and the `state.*` reads
// in `install-github-app.tsx`; `Workflow` is the `value` union of the `WORKFLOWS`
// options in `components/WorkflowMultiselectDialog.tsx`.

/** A GitHub Actions workflow this installer can write. */
export type Workflow = 'claude' | 'claude-review'

/** A non-fatal problem surfaced before the install proceeds. */
export type Warning = {
  title: string
  message: string
  /** Lines shown under the message, usually remediation steps. */
  instructions?: string[]
}

/** Which panel the installer is on. */
export type InstallStep =
  | 'check-gh'
  | 'warnings'
  | 'choose-repo'
  | 'install-app'
  | 'select-workflows'
  | 'check-existing-workflow'
  | 'check-existing-secret'
  | 'api-key'
  | 'oauth-flow'
  | 'creating'
  | 'success'
  | 'error'

export type State = {
  step: InstallStep
  selectedRepoName: string
  /** Repo slug detected from the git remote, empty when there is none. */
  currentRepo: string
  useCurrentRepo: boolean
  apiKeyOrOAuthToken: string
  useExistingKey: boolean
  /** Index into the workflow-writing progress list shown by CreatingStep. */
  currentWorkflowInstallStep: number
  warnings: Warning[]
  secretExists: boolean
  secretName: string
  useExistingSecret: boolean
  workflowExists: boolean
  selectedWorkflows: Workflow[]
  selectedApiKeyOption: 'existing' | 'new' | 'oauth'
  authType: 'api_key' | 'oauth_token'
  /** Set once the user resolves an existing-workflow conflict. */
  workflowAction?: 'update' | 'skip' | 'exit'
  error?: string
  /** Short headline for the error panel. */
  errorReason?: string
  /** Lines of remediation shown under the reason. */
  errorInstructions?: string[]
}
