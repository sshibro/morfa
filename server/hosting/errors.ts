export function fail(status: number, code: string, message: string, retryable = false): never {
  throw Object.assign(new Error(message), {status, code, retryable});
}
