/**
 * An AWS SDK error from Converse, as the Anthropic APIError the retry loop
 * and the error classifier read (withRetry.ts, errors.ts), its status from the
 * exception's name or `$metadata`. An exception frame in the middle of a
 * stream reaches here as a bare `{ message }` — the SDK keeps neither its type
 * nor a status — and goes as a 500, which the retry loop retries. An abort
 * passes through untouched.
 */
import { APIError } from '@anthropic-ai/sdk'

const STATUS_BY_NAME: Record<string, number> = {
  ValidationException: 400,
  AccessDeniedException: 403,
  ResourceNotFoundException: 404,
  ModelNotReadyException: 429,
  ThrottlingException: 429,
  ServiceQuotaExceededException: 429,
  ModelTimeoutException: 408,
  ModelStreamErrorException: 424,
  ModelErrorException: 424,
  InternalServerException: 500,
  ServiceUnavailableException: 503,
}

type AwsError = { name?: string; message?: string; $metadata?: { httpStatusCode?: number; requestId?: string } }

export function converseApiError(error: AwsError): APIError {
  const name = error.name ?? 'Error'
  const status = STATUS_BY_NAME[name] ?? error.$metadata?.httpStatusCode ?? 500
  const message = error.message ?? name
  const headers = new Headers(error.$metadata?.requestId ? { 'x-amzn-requestid': error.$metadata.requestId } : {})
  return APIError.generate(
    status,
    { type: 'error', error: { type: name, message } },
    `Bedrock Converse ${name}: ${message}`,
    headers as never,
  )
}

export function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'AbortSignalError')
}
