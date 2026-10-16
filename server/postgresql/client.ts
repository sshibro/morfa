import {AsyncLocalStorage} from 'node:async_hooks';
import {Pool, type PoolClient, type QueryConfig, type QueryResult, type QueryResultRow} from 'pg';
import {type DatabaseConfig} from './config';
import {postgresClientOptions} from './connection-options';
import {DatabaseError, databaseFailure} from './errors';
import {ONE_HOUR_MS} from '../time-constants';

export interface SqlExecutor {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
  one<T extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<T | undefined>;
  many<T extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  execute(sql: string, params?: readonly unknown[]): Promise<{changes: number}>;
}
export interface TransactionScope {
  readonly active: boolean;
}
export interface TransactionContext extends SqlExecutor {
  readonly transactionScope: TransactionScope;
  transaction<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T>;
  /** Values must be immutable: savepoint rollback restores a shallow map snapshot. */
  getLocal<T>(key: symbol): T | undefined;
  setLocal<T>(key: symbol, value: T): void;
}
export interface TransactionOptions {
  isolation?: 'read committed' | 'repeatable read' | 'serializable';
  readOnly?: boolean;
  timeoutMs?: number;
}
export interface Database extends SqlExecutor {
  transaction<T>(work: (tx: TransactionContext) => Promise<T>, options?: TransactionOptions): Promise<T>;
  close(): Promise<void>;
  getStatistics(): {
    total: number;
    idle: number;
    waiting: number;
    active: number;
    closing: boolean;
    drained: boolean;
    lastErrorCode?: string;
  };
}

type Frame = {active: boolean; pending: Set<Promise<unknown>>; failure?: unknown; state: TransactionState};
type TransactionState = {
  active: boolean;
  current: Frame;
  locals: Map<symbol, unknown>;
  scope: TransactionScope;
  nextSavepoint: number;
};
const context = new AsyncLocalStorage<Frame>();
const misuse = (message: string) => new DatabaseError('transaction_context', message);

function assertStatement(sql: string): void {
  // Skip leading comments, including PostgreSQL's nested block comments.
  let at = 0;
  while (at < sql.length) {
    if (/\s/.test(sql[at])) {
      at++;
      continue;
    }
    if (sql.startsWith('--', at)) {
      const end = sql.indexOf('\n', at + 2);
      at = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith('/*', at)) {
      at += 2;
      let depth = 1;
      while (depth && at < sql.length) {
        if (sql.startsWith('/*', at)) {
          depth++;
          at += 2;
        } else if (sql.startsWith('*/', at)) {
          depth--;
          at += 2;
        } else at++;
      }
      if (depth) throw misuse('The SQL comment is incomplete.');
      continue;
    }
    break;
  }
  const command = /^[a-z]+/i.exec(sql.slice(at))?.[0].toUpperCase();
  if (!command) throw misuse('A non-empty SQL statement is required.');
  if (['BEGIN', 'COMMIT', 'END', 'ABORT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'START', 'PREPARE'].includes(command))
    throw misuse('Use the transaction API for transaction control.');
}

function parameter(value: unknown): unknown {
  if (
    typeof value === 'number' &&
    (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
  )
    throw new DatabaseError('database_codec', 'A database parameter cannot be represented safely.');
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime()))
      throw new DatabaseError('database_codec', 'The database timestamp parameter is invalid.');
    return value.toISOString();
  }
  return Array.isArray(value) ? value.map(parameter) : value;
}

/** A statement's text → its name: `prepared` statements are parsed and planned once per connection (lane A7). */
const preparedNames = new Map<string, string>();
/** Fixed statements the app prepares; more means texts built from data, which would grow every connection's statement cache. */
const MAX_PREPARED = 256;
/**
 * Marks a hot statement to be prepared: each pooled connection parses and plans it once under a stable name, then runs it from
 * its plan (PostgreSQL's plan cache; lane A7 measured the file list's planning at 3.6 ms of 7 ms). Returns `sql` itself; build the
 * text once (a module constant, or one per shape) and pass the same string to the executor. Only for statements whose result
 * columns cannot change under a migration (no `SELECT *` of a table: a column added while the process runs would fail the cached
 * plan with "cached plan must not change result type").
 */
export function prepared(sql: string): string {
  if (!preparedNames.has(sql)) {
    if (preparedNames.size >= MAX_PREPARED) throw misuse('Too many prepared statements: prepare fixed texts only.');
    preparedNames.set(sql, 'morfa_' + preparedNames.size);
  }
  return sql;
}

function helpers(query: SqlExecutor['query']): SqlExecutor {
  return {
    query,
    async one<T extends QueryResultRow = QueryResultRow>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<T | undefined> {
      const result = await query<T>(sql, params);
      if (result.rows.length > 1)
        throw new DatabaseError('database_cardinality', 'The database query returned more than one row.');
      return result.rows[0];
    },
    async many<T extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<T[]> {
      return (await query<T>(sql, params)).rows;
    },
    async execute(sql, params) {
      return {changes: (await query(sql, params)).rowCount || 0};
    },
  };
}

/** Lazy: creating this object never opens a connection or runs a migration. */
export function createDatabase(config: DatabaseConfig): Database {
  const pool = new Pool({
    ...postgresClientOptions(config),
    max: config.poolMax,
    min: 0,
    idleTimeoutMillis: config.poolIdleTimeoutMs,
  });
  let closing = false,
    drained = false,
    closed: Promise<void> | undefined,
    ending: Promise<void> | undefined,
    lastErrorCode: string | undefined;
  const operations = new Set<Promise<unknown>>();
  const pendingAcquisitions = new Set<(error: DatabaseError) => void>();
  type Lease = {
    client: PoolClient;
    interruptible<T>(work: Promise<T>): Promise<T>;
    failure?: DatabaseError;
    released: boolean;
    abort(error: DatabaseError): void;
    release(destroy?: boolean): void;
  };
  const leases = new Set<Lease>();
  pool.on('error', error => {
    lastErrorCode = databaseFailure(error).code;
  });

  function assertPoolUse() {
    if (context.getStore())
      throw misuse(
        'Pass the explicit transaction context instead of using a database pool inside a transaction callback.',
      );
    if (closing) throw new DatabaseError('database_closed', 'The database is closing or closed.');
  }
  function track<T>(work: () => Promise<T>): Promise<T> {
    let promise: Promise<T>;
    try {
      assertPoolUse();
      promise = work();
    } catch (error) {
      return Promise.reject(error);
    }
    const tracked = promise.finally(() => operations.delete(tracked));
    operations.add(tracked);
    return tracked;
  }
  async function acquire(): Promise<Lease> {
    let client: PoolClient;
    let cancelled = false;
    let cancel: (error: DatabaseError) => void = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      cancel = error => {
        cancelled = true;
        reject(error);
      };
    });
    pendingAcquisitions.add(cancel);
    const connection = pool.connect().then(connected => {
      if (cancelled) {
        connected.release(true);
        throw new DatabaseError('database_closed', 'The database connection arrived after shutdown.');
      }
      return connected;
    });
    try {
      client = await Promise.race([connection, interrupted]);
    } catch (error) {
      throw databaseFailure(error);
    } finally {
      pendingAcquisitions.delete(cancel);
    }
    const interruptions = new Set<(error: unknown) => void>();
    const onError = (error: unknown) => lease.abort(databaseFailure(error));
    const onEnd = () => lease.abort(new DatabaseError('database_unavailable', 'The database connection ended.'));
    const lease: Lease = {
      client,
      released: false,
      interruptible<T>(work: Promise<T>): Promise<T> {
        // A shared pending Promise.race retains every completed query result until
        // interruption. Explicit subscriptions release each result as work settles.
        return new Promise<T>((resolve, reject) => {
          let settled = false;
          const cancel = (error: unknown) => {
            if (settled) return;
            settled = true;
            interruptions.delete(cancel);
            reject(error);
          };
          interruptions.add(cancel);
          Promise.resolve(work).then(value => {
            if (settled) return;
            settled = true;
            interruptions.delete(cancel);
            resolve(value);
          }, cancel);
          if (lease.failure) cancel(lease.failure);
          else if (lease.released) cancel(misuse('The transaction connection is no longer available.'));
        });
      },
      abort(error) {
        if (lease.released || lease.failure) return;
        lease.failure = error;
        lastErrorCode = error.code;
        for (const cancel of [...interruptions]) cancel(error);
      },
      release(destroy = false) {
        if (lease.released) return;
        lease.released = true;
        leases.delete(lease);
        client.off('error', onError);
        client.off('end', onEnd);
        client.release(destroy || !!lease.failure);
      },
    };
    client.on('error', onError);
    client.on('end', onEnd);
    leases.add(lease);
    // Requests accepted before close() may finish acquiring and drain normally.
    // Its hard deadline cancels pending acquisitions before destroying leases.
    return lease;
  }
  async function raw<T extends QueryResultRow = QueryResultRow>(
    lease: Lease,
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    if (lease.failure) throw lease.failure;
    if (lease.released) throw misuse('The transaction connection is no longer available.');
    try {
      // Extended protocol rejects multiple commands without attempting a fragile SQL splitter.
      const query: QueryConfig & {queryMode: 'extended'} = {
        text: sql,
        values: params.map(parameter),
        queryMode: 'extended',
      };
      const name = preparedNames.get(sql);
      if (name) query.name = name;
      return await lease.interruptible(lease.client.query<T>(query));
    } catch (error) {
      const failure = databaseFailure(error);
      if (
        ['database_unavailable', 'database_timeout', '25P03', '25P04', '57P01', '57P02', '57P03'].includes(
          failure.code,
        ) ||
        failure.code.startsWith('08')
      )
        lease.abort(failure);
      throw failure;
    }
  }

  const query: SqlExecutor['query'] = <T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ) =>
    track(async () => {
      assertStatement(sql);
      const lease = await acquire();
      try {
        return await raw<T>(lease, sql, params);
      } finally {
        lease.release();
      }
    });

  function transaction<T>(work: (tx: TransactionContext) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    return track(async () => {
      const isolation = options.isolation || 'read committed',
        timeout = options.timeoutMs ?? config.transactionTimeoutMs;
      if (
        !['read committed', 'repeatable read', 'serializable'].includes(isolation) ||
        !Number.isInteger(timeout) ||
        timeout < 10 ||
        timeout > ONE_HOUR_MS ||
        (options.readOnly !== undefined && typeof options.readOnly !== 'boolean')
      )
        throw misuse('The transaction options are invalid.');
      const lease = await acquire();
      const state = {active: true, locals: new Map<symbol, unknown>(), nextSavepoint: 0} as TransactionState;
      state.scope = Object.freeze({
        get active() {
          return state.active;
        },
      });
      const frame: Frame = {active: true, pending: new Set(), state};
      state.current = frame;
      const timer = setTimeout(() => {
        state.active = false;
        lease.abort(
          new DatabaseError('database_transaction_timeout', 'The transaction callback exceeded its time limit.'),
        );
        lease.release(true);
      }, timeout);
      let began = false;
      const ensure = (current: Frame) => {
        if (!state.active || !current.active) throw misuse('The transaction context has finished.');
        if (context.getStore() !== current || state.current !== current)
          throw misuse('Use the current nested transaction context; concurrent savepoint branches are not supported.');
        if (lease.failure) throw lease.failure;
      };
      function makeContext(current: Frame): TransactionContext {
        const executeQuery: SqlExecutor['query'] = <T extends QueryResultRow = QueryResultRow>(
          sql: string,
          params?: readonly unknown[],
        ) => {
          try {
            ensure(current);
            assertStatement(sql);
          } catch (error) {
            return Promise.reject(error);
          }
          const operation = raw<T>(lease, sql, params).catch(error => {
            current.failure ??= error;
            throw error;
          });
          const tracked = operation.finally(() => current.pending.delete(tracked));
          current.pending.add(tracked);
          // Missing awaits still fail the transaction gate, without leaking an unhandled rejection.
          void tracked.catch(() => {});
          return tracked;
        };
        return Object.freeze({
          ...helpers(executeQuery),
          transactionScope: state.scope,
          getLocal<V>(key: symbol) {
            ensure(current);
            return state.locals.get(key) as V | undefined;
          },
          setLocal<V>(key: symbol, value: V) {
            ensure(current);
            state.locals.set(key, value);
          },
          transaction<V>(nested: (tx: TransactionContext) => Promise<V>): Promise<V> {
            try {
              ensure(current);
              if (current.pending.size) throw misuse('Await transaction queries before entering a savepoint.');
            } catch (error) {
              return Promise.reject(error);
            }
            const child: Frame = {active: true, pending: new Set(), state};
            const checkpoint = new Map(state.locals),
              name = 'morfa_savepoint_' + ++state.nextSavepoint;
            state.current = child;
            const operation = (async () => {
              let saved = false;
              try {
                await raw(lease, 'SAVEPOINT ' + name);
                saved = true;
                const result = await lease.interruptible(context.run(child, () => nested(makeContext(child))));
                if (child.pending.size) throw misuse('Await all nested transaction work before returning.');
                if (child.failure) throw child.failure;
                await raw(lease, 'RELEASE SAVEPOINT ' + name);
                return result;
              } catch (error) {
                await Promise.allSettled([...child.pending]);
                if (saved && !lease.failure && !lease.released) {
                  try {
                    await raw(lease, 'ROLLBACK TO SAVEPOINT ' + name);
                    await raw(lease, 'RELEASE SAVEPOINT ' + name);
                  } catch (rollbackError) {
                    current.failure ??= rollbackError;
                    lease.abort(databaseFailure(rollbackError));
                  }
                } else current.failure ??= error;
                state.locals = checkpoint;
                throw error;
              } finally {
                child.active = false;
                state.current = current;
              }
            })();
            const tracked = operation.finally(() => current.pending.delete(tracked));
            current.pending.add(tracked);
            void tracked.catch(() => {});
            return tracked;
          },
        });
      }
      try {
        await raw(
          lease,
          `BEGIN ISOLATION LEVEL ${isolation.toUpperCase()} ${options.readOnly ? 'READ ONLY' : 'READ WRITE'}`,
        );
        began = true;
        // Every connection starts with the configured transaction_timeout (connection-options.ts) and nothing sets it for the
        // session, so only another timeout costs a round trip (lane A7: one of five statements around a short read).
        if (timeout !== config.transactionTimeoutMs)
          await raw(lease, "SELECT set_config('transaction_timeout', $1, true)", [String(timeout)]);
        const result = await lease.interruptible(context.run(frame, () => work(makeContext(frame))));
        if (frame.pending.size) throw misuse('Await all transaction work before returning.');
        if (frame.failure) throw frame.failure;
        if (!state.active || lease.failure) throw lease.failure || misuse('The transaction has finished.');
        const committed = await raw(lease, 'COMMIT');
        if (committed.command !== 'COMMIT')
          throw new DatabaseError('25P02', 'The database transaction did not commit.');
        return result;
      } catch (error) {
        state.active = false;
        frame.active = false;
        await Promise.allSettled([...frame.pending]);
        if (began && !lease.failure && !lease.released) {
          try {
            await raw(lease, 'ROLLBACK');
          } catch (rollbackError) {
            lease.abort(databaseFailure(rollbackError));
          }
        }
        throw error;
      } finally {
        clearTimeout(timer);
        state.active = false;
        frame.active = false;
        lease.release();
      }
    });
  }

  function close(): Promise<void> {
    if (context.getStore()) return Promise.reject(misuse('Close the database outside transaction callbacks.'));
    if (closed) return closed;
    closing = true;
    const endPool = () =>
      (ending ||= pool.end().then(() => {
        drained = true;
      }));
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const failure = new DatabaseError(
          'database_close_timeout',
          'The database did not drain before its close deadline.',
        );
        for (const cancel of [...pendingAcquisitions]) cancel(failure);
        for (const lease of [...leases]) {
          lease.abort(failure);
          lease.release(true);
        }
        // Handshakes already inside pg remain bounded by connectionTimeoutMillis.
        // Late clients are destroyed by acquire(); no caller waits for that background drain.
        void endPool().catch(error => {
          lastErrorCode = databaseFailure(error).code;
        });
        reject(failure);
      }, config.closeTimeoutMs);
    });
    const graceful = (async () => {
      await Promise.allSettled([...operations]);
      await endPool();
    })();
    closed = Promise.race([graceful, deadline]).finally(() => clearTimeout(timer));
    return closed;
  }
  return Object.freeze({
    ...helpers(query),
    transaction,
    close,
    getStatistics: () => ({
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
      active: operations.size,
      closing,
      drained,
      lastErrorCode,
    }),
  });
}
