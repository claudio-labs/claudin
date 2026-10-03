// The texts the user sees in a prompt, and the model in a tool result. Each
// one names the path and the operation, so callers never need to parse them.

export const OUTSIDE_WORKING_DIRS = 'The path is outside the allowed working directories'

export function pathlessToolMessage(toolName: string): string {
  return `${toolName} needs your approval: it does not say which file it would touch.`
}

export function readDeniedMessage(path: string): string {
  return `Reading ${path} is blocked: a permission rule denied the read.`
}

export function editDeniedMessage(path: string): string {
  return `Editing ${path} is blocked: a permission rule denied the edit.`
}

export function readApprovalMessage(path: string): string {
  return `Claudin needs your approval to read ${path}.`
}

export function writeApprovalMessage(path: string): string {
  return `Claudin needs your approval to write to ${path}.`
}

export function uncReadMessage(path: string): string {
  return `Claudin needs your approval to read ${path}: it is a UNC path, which can reach other machines on the network.`
}

export function windowsShapeReadMessage(path: string): string {
  return `Claudin needs your approval to read ${path}: it has a suspicious Windows path pattern.`
}
