// Ambient declaration for the checked-in stub at ./index.js — a permanently
// `isHidden: true` command this fork never received, kept only so it still
// slots into `Command[]` in commands.ts without a runtime import error.
import type { Command } from 'src/types/command.js'
declare const stub: Command
export default stub
