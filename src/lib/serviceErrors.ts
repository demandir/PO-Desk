export class SubmissionError extends Error {
  constructor(message: string, readonly rejected: boolean) { super(message) }
}

export async function functionError(error: unknown): Promise<SubmissionError> {
  const response = (error as { context?: unknown })?.context
  if (response instanceof Response) {
    let message = 'The service could not complete this request. Please try again.'
    try {
      const body = await response.clone().json()
      if (typeof body?.error === 'string') message = body.error
    } catch { /* Keep the useful fallback for a non-JSON upstream response. */ }
    return new SubmissionError(message, [400, 401, 403, 413, 429].includes(response.status))
  }
  return new SubmissionError('The connection was interrupted. Please retry; your request will not be duplicated.', false)
}
