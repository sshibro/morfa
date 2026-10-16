import fs from 'node:fs';
import path from 'node:path';
import {createDatabase, type TransactionContext} from './postgresql/client';
import {loadDatabaseConfig} from './postgresql/config';
import {assertDatabaseReady} from './postgresql/migrations';

export type Row = Record<string, any>;
export const dataDir = path.resolve(process.env.DATA_DIR || 'data');
fs.mkdirSync(path.join(dataDir, 'uploads'), {recursive: true});

// Configuration is mandatory. The pool is lazy and imports never connect or run DDL.
export const db = createDatabase(loadDatabaseConfig('application'));
export const initializeDatabase = () => assertDatabaseReady(db);
export const closeDatabase = () => db.close();

/** Nested domain work reuses its caller's explicit connection. Use tx.transaction for a savepoint. */
export async function inTransaction<T>(
  work: (tx: TransactionContext) => Promise<T>,
  existing?: TransactionContext,
): Promise<T> {
  if (!existing) return db.transaction(work);
  if (!existing.transactionScope.active) throw Error('The transaction context is no longer active.');
  return work(existing);
}
