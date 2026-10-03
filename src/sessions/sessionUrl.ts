import { randomUUID, type UUID } from 'crypto'
import { validateUuid } from 'src/shared/data/uuid.js'

export type ParsedSessionUrl = {
  sessionId: UUID
  ingressUrl: string | null
  isUrl: boolean
  jsonlFile: string | null
  isJsonlFile: boolean
}

type ResumeTarget =
  | { kind: 'file'; path: string }
  | { kind: 'id'; id: UUID }
  | { kind: 'url'; href: string }

const INGRESS_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:'])

function asIngressUrl(text: string): string | null {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  // `foo:bar` and `C:\x` parse as URLs too; only a web address can be an ingress.
  return INGRESS_PROTOCOLS.has(url.protocol) ? url.href : null
}

function classify(text: string): ResumeTarget | null {
  // The extension is checked before anything else: a URL or a Windows path
  // ending in `.jsonl` names a transcript file.
  if (text.toLowerCase().endsWith('.jsonl')) return { kind: 'file', path: text }
  const id = validateUuid(text)
  if (id) return { kind: 'id', id }
  const href = asIngressUrl(text)
  return href === null ? null : { kind: 'url', href }
}

function toParsed(target: ResumeTarget): ParsedSessionUrl {
  switch (target.kind) {
    case 'file':
      return { sessionId: randomUUID(), ingressUrl: null, isUrl: false, jsonlFile: target.path, isJsonlFile: true }
    case 'id':
      return { sessionId: target.id, ingressUrl: null, isUrl: false, jsonlFile: null, isJsonlFile: false }
    case 'url':
      // The id in the URL belongs to the remote session; ours is always fresh.
      return { sessionId: randomUUID(), ingressUrl: target.href, isUrl: true, jsonlFile: null, isJsonlFile: false }
  }
}

/** What `-p --resume <value>` names: a transcript file, a session id, or an ingress URL. */
export function parseSessionIdentifier(
  resumeIdentifier: string,
): ParsedSessionUrl | null {
  const target = classify(resumeIdentifier)
  return target === null ? null : toParsed(target)
}
