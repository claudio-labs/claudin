import type { CommandSpec } from 'src/services/bash/registry.js'
import alias from 'src/services/bash/specs/alias.js'
import nohup from 'src/services/bash/specs/nohup.js'
import pyright from 'src/services/bash/specs/pyright.js'
import sleep from 'src/services/bash/specs/sleep.js'
import srun from 'src/services/bash/specs/srun.js'
import time from 'src/services/bash/specs/time.js'
import timeout from 'src/services/bash/specs/timeout.js'

export default [
  pyright,
  timeout,
  sleep,
  alias,
  nohup,
  time,
  srun,
] satisfies CommandSpec[]
