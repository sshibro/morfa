import {readFileSync} from 'node:fs';
import {DatabaseError} from './errors';
import {ONE_HOUR_MS} from '../time-constants';

export type DatabasePurpose = 'application' | 'migration' | 'backup' | 'test';
export type DatabaseEnvironment = Readonly<Record<string, string | undefined>>;
export interface DatabaseConfig {
  readonly purpose: DatabasePurpose;
  readonly production: boolean;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly ssl: false | Readonly<{rejectUnauthorized: true; ca?: string}>;
  readonly applicationName: string;
  readonly poolMax: number;
  readonly connectionTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly lockTimeoutMs: number;
  readonly transactionTimeoutMs: number;
  readonly idleTransactionTimeoutMs: number;
  readonly poolIdleTimeoutMs: number;
  readonly closeTimeoutMs: number;
}

const purposeKeys: Record<DatabasePurpose, string> = {
  application: 'MORFA_DATABASE_URL',
  migration: 'MORFA_MIGRATION_DATABASE_URL',
  // MORFA_TEST_DATABASE_URL belongs exclusively to the guarded cluster harness.
  backup: 'MORFA_BACKUP_DATABASE_URL',
  test: 'MORFA_TEST_APPLICATION_DATABASE_URL',
};
const ambientKeys = [
  'PGHOST',
  'PGHOSTADDR',
  'PGPORT',
  'PGUSER',
  'PGPASSWORD',
  'PGDATABASE',
  'PGSSLMODE',
  'PGOPTIONS',
  'PGREPLICATION',
  'PGCLIENT_ENCODING',
  'PGAPPNAME',
  'PGCONNECT_TIMEOUT',
  'PGSSLNEGOTIATION',
  'PGBINARY',
  'PGPASSFILE',
  'PGSERVICE',
  'PGSERVICEFILE',
];
const fail = (message: string): never => {
  throw new DatabaseError('database_configuration', message);
};

/** pg falls back to ambient PG* values for some false/empty options. Fail explicitly. */
export function assertNoAmbientPostgresConfig(env: DatabaseEnvironment = process.env): void {
  for (const key of ambientKeys) if (env[key]) fail(`Use explicit MORFA database configuration instead of ${key}.`);
}

export function validateDatabaseConfig(config: DatabaseConfig): void {
  if (!Object.hasOwn(purposeKeys, config.purpose)) fail('The database purpose is invalid.');
  if (!config.host || !config.database || !config.user || typeof config.password !== 'string' || !config.password)
    fail('An explicit database host, database, user and password are required.');
  if (
    /[\s\u0000/]/.test(config.host) ||
    /[\u0000/]/.test(config.database) ||
    /\u0000/.test(config.user + config.password)
  )
    fail('The database connection fields are invalid.');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) fail('The database port is invalid.');
  if (config.ssl !== false && (!config.ssl || config.ssl.rejectUnauthorized !== true))
    fail('Database TLS must verify the server certificate.');
  if (config.production && config.ssl === false) fail('Production database connections require verified TLS.');
  if (config.ssl === false && !['localhost', '127.0.0.1', '::1'].includes(config.host))
    fail('Remote database connections require verified TLS.');
  if (/^morfa_test_control_/.test(config.database) || /^morfa_test_admin_/.test(config.user))
    fail('The guarded test control database is reserved for the test harness.');
  if (config.purpose === 'test' && (config.production || !['localhost', '127.0.0.1', '::1'].includes(config.host)))
    fail('Test database connections must use a local, non-production endpoint.');
  if (config.purpose === 'test' && !/^morfa_test_[a-f0-9]{32}$/.test(config.database))
    fail('Test connections require a generated, owned test database.');
  if (
    config.purpose === 'test' &&
    !['migration', 'runtime', 'backup'].some(role => config.user === config.database + '_' + role)
  )
    fail('Test connections require the matching generated database role.');
  if (!/^[a-zA-Z0-9_.:-]{1,63}$/.test(config.applicationName)) fail('The database application name is invalid.');
  if (!Number.isInteger(config.poolMax) || config.poolMax < 1 || config.poolMax > 50)
    fail('The database pool size must be between 1 and 50.');
  for (const key of [
    'connectionTimeoutMs',
    'statementTimeoutMs',
    'lockTimeoutMs',
    'transactionTimeoutMs',
    'idleTransactionTimeoutMs',
    'poolIdleTimeoutMs',
    'closeTimeoutMs',
  ] as const) {
    if (!Number.isInteger(config[key]) || config[key] < 10 || config[key] > ONE_HOUR_MS)
      fail(`The database ${key} must be between 10 and 3600000 milliseconds.`);
  }
}

export function loadDatabaseConfig(
  purpose: DatabasePurpose = 'application',
  env: DatabaseEnvironment = process.env,
): DatabaseConfig {
  if (!Object.hasOwn(purposeKeys, purpose)) fail('The database purpose is invalid.');
  assertNoAmbientPostgresConfig(env);
  const raw = env[purposeKeys[purpose]];
  if (!raw?.trim()) fail(`Set ${purposeKeys[purpose]} explicitly; database fallback is disabled.`);
  let url: URL;
  try {
    url = new URL(raw!);
  } catch {
    return fail('The database URL is invalid.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hash ||
    !url.hostname ||
    !url.username ||
    !url.pathname ||
    url.pathname === '/'
  )
    fail('The database URL must specify a PostgreSQL host, user and database.');
  for (const [key] of url.searchParams)
    if (key !== 'sslmode') fail('The database URL contains unsupported connection options.');
  if (url.searchParams.getAll('sslmode').length > 1) fail('The database URL contains duplicate TLS options.');
  const production = env.NODE_ENV === 'production';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const local = ['localhost', '127.0.0.1', '::1'].includes(host);
  const sslmode = url.searchParams.get('sslmode') || (production || !local ? 'verify-full' : 'disable');
  if (!['verify-full', 'disable'].includes(sslmode)) fail('Database sslmode must be verify-full or local disable.');
  if (sslmode === 'disable' && !local) fail('Remote database connections require verified TLS.');
  const caFile = env.MORFA_DATABASE_CA_CERT_FILE?.trim();
  let ca = env.MORFA_DATABASE_CA_CERT?.trim();
  if (!ca && caFile) {
    try {
      ca = readFileSync(caFile, 'utf8').trim();
    } catch {
      return fail('The database CA certificate file is unreadable.');
    }
  }
  if (ca && (!ca.includes('-----BEGIN CERTIFICATE-----') || !ca.includes('-----END CERTIFICATE-----')))
    fail('The database CA certificate must be PEM encoded.');
  const number = (suffix: string, fallback: number) => {
    const value = env['MORFA_DATABASE_' + suffix];
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value)) return fail(`MORFA_DATABASE_${suffix} must be a positive integer.`);
    return Number(value);
  };
  let database: string, user: string, password: string;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    return fail('The database URL contains invalid encoding.');
  }
  const maintenance = purpose === 'migration' || purpose === 'backup';
  const config: DatabaseConfig = {
    purpose,
    production,
    host,
    port: url.port ? Number(url.port) : 5432,
    database,
    user,
    password,
    ssl: sslmode === 'disable' ? false : Object.freeze({rejectUnauthorized: true as const, ...(ca ? {ca} : {})}),
    applicationName: env.MORFA_DATABASE_APPLICATION_NAME || `morfa-${purpose}`,
    poolMax: number('POOL_MAX', maintenance ? 2 : 10),
    connectionTimeoutMs: number('CONNECTION_TIMEOUT_MS', 5000),
    statementTimeoutMs: number('STATEMENT_TIMEOUT_MS', maintenance ? 120000 : 15000),
    lockTimeoutMs: number('LOCK_TIMEOUT_MS', 5000),
    transactionTimeoutMs: number('TRANSACTION_TIMEOUT_MS', maintenance ? 300000 : 30000),
    idleTransactionTimeoutMs: number('IDLE_TRANSACTION_TIMEOUT_MS', maintenance ? 30000 : 10000),
    poolIdleTimeoutMs: number('POOL_IDLE_TIMEOUT_MS', 30000),
    closeTimeoutMs: number('CLOSE_TIMEOUT_MS', maintenance ? 305000 : 35000),
  };
  validateDatabaseConfig(config);
  // Diagnostics must not accidentally serialize credentials when inspecting config.
  Object.defineProperty(config, 'toJSON', {
    value: () => ({
      ...config,
      password: '[redacted]',
      ssl: config.ssl ? {rejectUnauthorized: true, customCA: !!config.ssl.ca} : false,
    }),
  });
  Object.defineProperty(config, Symbol.for('nodejs.util.inspect.custom'), {
    value: () => ({
      ...config,
      password: '[redacted]',
      ssl: config.ssl ? {rejectUnauthorized: true, customCA: !!config.ssl.ca} : false,
    }),
  });
  return Object.freeze(config);
}
