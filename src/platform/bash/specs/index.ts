import type { CommandSpec } from 'src/platform/bash/registry.js'
import alias from 'src/platform/bash/specs/alias.js'
import nohup from 'src/platform/bash/specs/nohup.js'
import pyright from 'src/platform/bash/specs/pyright.js'
import sleep from 'src/platform/bash/specs/sleep.js'
import srun from 'src/platform/bash/specs/srun.js'
import time from 'src/platform/bash/specs/time.js'
import timeout from 'src/platform/bash/specs/timeout.js'

export default [
  pyright,
  timeout,
  sleep,
  alias,
  nohup,
  time,
  srun,
] satisfies CommandSpec[]
