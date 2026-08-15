import type { Command } from 'src/commands.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'

const doctor: Command = {
  name: 'doctor',
  description: 'Diagnose and verify your Claude Code installation and settings',
  isEnabled: () => !isEnvTruthy(process.env.DISABLE_DOCTOR_COMMAND),
  type: 'local-jsx',
  load: () => import('src/commands/doctor/doctor.js'),
}

export default doctor
