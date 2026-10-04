/**
 * How a revocation request authenticates the client (RFC 7009 §2.1, with the
 * client authentication of RFC 6749 §2.3.1). Exactly one form is sent.
 */

export type RevocationClientAuth =
  | { kind: 'basic'; clientId: string; clientSecret: string }
  | { kind: 'post'; clientId: string; clientSecret: string }
  | { kind: 'public'; clientId: string }
  | { kind: 'none' }

/** The metadata fields that decide between Basic and form-post credentials. */
export type ClientAuthMetadata = {
  revocation_endpoint_auth_methods_supported?: string[]
  token_endpoint_auth_methods_supported?: string[]
}

export function chooseClientAuth(
  client: { clientId?: string; clientSecret?: string },
  metadata: ClientAuthMetadata,
): RevocationClientAuth {
  const { clientId, clientSecret } = client
  if (!clientId) return { kind: 'none' }
  if (!clientSecret) return { kind: 'public', clientId }

  const advertised =
    metadata.revocation_endpoint_auth_methods_supported ??
    metadata.token_endpoint_auth_methods_supported
  // Basic is the RFC default; post only when the server rules Basic out.
  const postOnly =
    advertised !== undefined &&
    advertised.includes('client_secret_post') &&
    !advertised.includes('client_secret_basic')
  return { kind: postOnly ? 'post' : 'basic', clientId, clientSecret }
}

export function basicCredentials(clientId: string, clientSecret: string): string {
  const pair = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`
  return `Basic ${Buffer.from(pair).toString('base64')}`
}

/** Puts the client credentials where the chosen method wants them. */
export function applyClientAuth(
  auth: RevocationClientAuth,
  headers: Record<string, string>,
  form: URLSearchParams,
): void {
  switch (auth.kind) {
    case 'basic':
      headers.Authorization = basicCredentials(auth.clientId, auth.clientSecret)
      return
    case 'post':
      form.set('client_id', auth.clientId)
      form.set('client_secret', auth.clientSecret)
      return
    case 'public':
      form.set('client_id', auth.clientId)
      return
    case 'none':
      return
  }
}
