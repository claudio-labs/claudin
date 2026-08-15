import type { Command } from 'src/commands.js'
import { isEnvTruthy } from 'src/utils/envUtils.js'

const installGitHubApp = {
  type: 'local-jsx',
  name: 'install-github-app',
  description: 'Set up Claude GitHub Actions for a repository',
  availability: ['claude-ai', 'console'],
  isEnabled: () => !isEnvTruthy(process.env.DISABLE_INSTALL_GITHUB_APP_COMMAND),
  load: () => import('src/commands/install-github-app/install-github-app.js'),
} satisfies Command

export default installGitHubApp
