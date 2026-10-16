/** Database failures intentionally exclude SQL, parameter values and provider messages. */
export class DatabaseError extends Error {
  readonly code: string;
  readonly constraint?: string;
  readonly table?: string;

  constructor(code: string, message: string, metadata: {constraint?: string; table?: string} = {}) {
    super(message);
    this.name = 'DatabaseError';
    this.code = code;
    this.constraint = identifier(metadata.constraint);
    this.table = identifier(metadata.table);
  }
}

const identifier = (value: unknown) =>
  typeof value === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(value) ? value : undefined;

export function databaseFailure(error: unknown): DatabaseError {
  if (error instanceof DatabaseError) return error;
  const candidate =
    error && typeof error === 'object'
      ? (error as {code?: unknown; constraint?: string; table?: string; message?: unknown})
      : {};
  const code = typeof candidate.code === 'string' && /^[A-Z0-9]{5}$/.test(candidate.code) ? candidate.code : undefined;
  const messages: Record<string, string> = {
    '23505': 'A database uniqueness constraint was violated.',
    '23503': 'A database relationship constraint was violated.',
    '23502': 'A required database value was missing.',
    '23514': 'A database value constraint was violated.',
    '40001': 'The database transaction conflicted with another transaction.',
    '40P01': 'The database transaction was selected to resolve a deadlock.',
    '55P03': 'The database lock could not be acquired in time.',
    '57014': 'The database statement was cancelled or timed out.',
    '25P02': 'The database transaction is aborted.',
    '25P03': 'The idle database transaction timed out.',
    '25P04': 'The database transaction exceeded its time limit.',
    '25006': 'The database transaction is read-only.',
  };
  if (code) return new DatabaseError(code, messages[code] || 'The database rejected the operation.', candidate);
  const timeout = typeof candidate.message === 'string' && /timeout|timed out/i.test(candidate.message);
  return new DatabaseError(
    timeout ? 'database_timeout' : 'database_unavailable',
    timeout ? 'The database operation timed out.' : 'The database connection is unavailable.',
  );
}

export function isDatabaseError(error: unknown, code: string): error is DatabaseError {
  return error instanceof DatabaseError && error.code === code;
}
