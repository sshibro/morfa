import {randomBytes, createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {Client, type ClientConfig} from 'pg';

type Environment = Record<string, string | undefined>;
export type PostgresqlTestConfig = {
  clusterId: string; token: string; host: string; port: number;
  user: string; password: string; database: string;
};
export type PostgresqlTestDatabase = {
  databaseName: string; clusterId: string;
  roles: {migration: string; runtime: string; backup: string};
  migrationUrl: string; runtimeUrl: string; backupUrl: string;
  env: {MORFA_DATABASE_URL: string; MORFA_MIGRATION_DATABASE_URL: string; MORFA_BACKUP_DATABASE_URL: string};
  close(): Promise<void>;
};
const idPattern = /^[a-f0-9]{32}$/;
const tokenPattern = /^[a-f0-9]{64}$/;
const databasePattern = /^morfa_test_[a-f0-9]{32}$/;
const rolePattern = /^morfa_test_[a-f0-9]{32}_(migration|runtime|backup)$/;
const configKeys = ['MORFA_TEST_DATABASE_URL', 'MORFA_TEST_CLUSTER_ID', 'MORFA_TEST_CLUSTER_TOKEN', 'MORFA_TEST_ENDPOINT'] as const;
function unsafe(): never { throw Error('Unsafe PostgreSQL test configuration; use the isolated test-cluster env file.'); }
function privateHost(host: string): boolean {
  if (host === '127.0.0.1' || host === '::1') return true;
  if (isIP(host) !== 4) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
/** Pure validation: never opens a connection, including for malformed/malicious input. */
export function readPostgresqlTestConfig(env: Environment = process.env): PostgresqlTestConfig | undefined {
  if (!configKeys.some(key => env[key] !== undefined)) return undefined;
  if (env.NODE_ENV === 'production' || configKeys.some(key => !env[key])) unsafe();
  const clusterId = env.MORFA_TEST_CLUSTER_ID!, token = env.MORFA_TEST_CLUSTER_TOKEN!;
  if (!idPattern.test(clusterId) || !tokenPattern.test(token)) unsafe();
  let url: URL;
  try { url = new URL(env.MORFA_TEST_DATABASE_URL!); } catch { return unsafe(); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port);
  const endpoint = (host.includes(':') ? `[${host}]` : host) + ':' + port;
  if (url.protocol !== 'postgresql:' || url.search || url.hash || !privateHost(host)
    || !Number.isInteger(port) || port < 1025 || port > 65535 || port === 5432
    || endpoint !== env.MORFA_TEST_ENDPOINT) unsafe();
  // Exact generated names/hex credentials reject percent-encoded aliases and ordinary DB users.
  const user = `morfa_test_admin_${clusterId}`, database = `morfa_test_control_${clusterId}`;
  if (url.username !== user || url.pathname !== '/' + database || !tokenPattern.test(url.password)
    || env.MORFA_TEST_DATABASE_URL !== `postgresql://${user}:${url.password}@${endpoint}/${database}`) unsafe();
  return {clusterId, token, host, port, user, password: url.password, database};
}
export function postgresqlTestConfigured(env: Environment = process.env): boolean {
  return readPostgresqlTestConfig(env) !== undefined;
}
export function assertPostgresqlTestDatabaseName(name: string): void {
  if (!databasePattern.test(name)) throw Error('Refusing a non-generated PostgreSQL test database name.');
}
export function assertPostgresqlTestRoleName(name: string): void {
  if (!rolePattern.test(name)) throw Error('Refusing a non-generated PostgreSQL test role name.');
}
function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw Error('Unsafe test identifier.');
  return '"' + value + '"';
}
type ClientTimeouts = {statementMs: number; queryMs: number};
const DEFAULT_TIMEOUTS: ClientTimeouts = {statementMs: 10_000, queryMs: 15_000};
// DROP DATABASE forces a checkpoint. With many suites tearing down in parallel it
// regularly outlasts the ordinary statement budget, which fails a passing suite
// and leaks its database. Only the cleanup connection gets the longer budget.
const CLEANUP_TIMEOUTS: ClientTimeouts = {statementMs: 120_000, queryMs: 130_000};
function clientConfig(config: PostgresqlTestConfig, database = config.database, user = config.user, password = config.password, timeouts = DEFAULT_TIMEOUTS): ClientConfig {
  return {host: config.host, port: config.port, database, user, password, ssl: false,
    connectionTimeoutMillis: 5000, statement_timeout: timeouts.statementMs, lock_timeout: 3000,
    query_timeout: timeouts.queryMs, options: '-c search_path=public', application_name: 'morfa-isolated-postgresql-test'};
}
async function connect(config: PostgresqlTestConfig, timeouts = DEFAULT_TIMEOUTS): Promise<Client> {
  const client = new Client(clientConfig(config, config.database, config.user, config.password, timeouts));
  // Never disclose a supplied URL/password or driver detail in test failures.
  client.on('error', () => {});
  try { await client.connect(); await verifyCluster(client, config); return client; }
  catch { await client.end().catch(() => {}); throw Error('PostgreSQL test cluster connection/identity verification failed.'); }
}
async function verifyCluster(client: Client, config: PostgresqlTestConfig): Promise<void> {
  const identity = (await client.query(`SELECT current_user AS username, current_database() AS database,
    current_setting('server_version_num')::int AS version,
    r.rolsuper,r.rolcreatedb,r.rolcreaterole,d.datdba::regrole::text AS owner
    FROM pg_roles r JOIN pg_database d ON d.datname=current_database() WHERE r.rolname=current_user`)).rows[0];
  if (!identity || identity.username !== config.user || identity.database !== config.database
    || identity.owner !== `morfa_test_bootstrap_${config.clusterId}` || identity.rolsuper
    || !identity.rolcreatedb || !identity.rolcreaterole || identity.version < 180000 || identity.version >= 190000) unsafe();
  const marker = (await client.query(`SELECT cluster_id,token,format_version,
    (SELECT relowner::regrole::text FROM pg_class WHERE oid='morfa_test_guard.cluster'::regclass) AS owner
    FROM morfa_test_guard.cluster`)).rows;
  if (marker.length !== 1 || marker[0].cluster_id !== config.clusterId || marker[0].token !== config.token
    || marker[0].format_version !== 1 || marker[0].owner !== `morfa_test_bootstrap_${config.clusterId}`) unsafe();
}
function connectionUrl(config: PostgresqlTestConfig, database: string, user: string, password: string): string {
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  return `postgresql://${user}:${password}@${host}:${config.port}/${database}`;
}

/** Each caller owns a database and three independent least-privilege role credentials. */
export async function createPostgresqlTestDatabase(env: Environment = process.env): Promise<PostgresqlTestDatabase> {
  const config = readPostgresqlTestConfig(env);
  if (!config) throw Error('PostgreSQL integration unavailable: explicitly load the isolated test-cluster env file.');
  const suffix = randomBytes(16).toString('hex');
  const databaseName = 'morfa_test_' + suffix;
  const roles = {migration: `${databaseName}_migration`, runtime: `${databaseName}_runtime`, backup: `${databaseName}_backup`};
  const passwords = {migration: randomBytes(32).toString('hex'), runtime: randomBytes(32).toString('hex'), backup: randomBytes(32).toString('hex')};
  const proof = createHash('sha256').update(config.token + ':' + suffix + ':' + randomBytes(32).toString('hex')).digest('hex');
  const comment = `morfa-test-v1:${config.clusterId}:${proof}`;
  const roleNames = Object.values(roles);
  assertPostgresqlTestDatabaseName(databaseName);
  roleNames.forEach(assertPostgresqlTestRoleName);
  let initialized = false, closed = false;
  const cleanup = async () => {
    if (closed) return;
    const admin = await connect(config, CLEANUP_TIMEOUTS);
    try {
      const allocation =(await admin.query('SELECT proof,roles FROM morfa_test_guard.allocations WHERE database_name=$1', [databaseName])).rows[0];
      if (!allocation || allocation.proof !== proof || JSON.stringify(allocation.roles) !== JSON.stringify(roleNames))
        throw Error('Refusing test cleanup: allocation ownership proof is missing or changed.');
      const database = (await admin.query('SELECT oid::text AS oid,datdba::regrole::text AS owner,shobj_description(oid,\'pg_database\') AS marker FROM pg_database WHERE datname=$1', [databaseName])).rows[0];
      if (database && (database.owner !== roles.migration || database.marker !== comment))
        throw Error('Refusing test cleanup: database ownership marker changed.');
      const existingRoles = (await admin.query('SELECT rolname,shobj_description(oid,\'pg_authid\') AS marker FROM pg_roles WHERE rolname=ANY($1::text[])', [roleNames])).rows;
      if (existingRoles.some(row => row.marker !== comment)) throw Error('Refusing test cleanup: role ownership marker changed.');
      // Database ownership cannot terminate the runtime/backup roles' sessions.
      // Fence new connections, then use each proven role only on its own sessions
      // in this exact database. Never grant global pg_signal_backend privileges.
      if (database) {
        await admin.query(`SET ROLE ${identifier(roles.migration)}`);
        try { await admin.query(`ALTER DATABASE ${identifier(databaseName)} ALLOW_CONNECTIONS false`); }
        finally { await admin.query('RESET ROLE'); }
        for (const row of existingRoles) {
          await admin.query(`SET ROLE ${identifier(row.rolname)}`);
          try {
            await admin.query(`SELECT pg_terminate_backend(pid,3000) FROM pg_stat_activity
              WHERE datid=$1::oid AND usesysid=(SELECT oid FROM pg_roles WHERE rolname=current_user)
              AND pid<>pg_backend_pid()`, [database.oid]);
          } finally { await admin.query('RESET ROLE'); }
        }
        // An unrelated backend, prepared transaction or failed termination must
        // make DROP fail closed. No FORCE and no broader fallback are allowed.
        await admin.query(`SET ROLE ${identifier(roles.migration)}`);
        try { await admin.query(`DROP DATABASE ${identifier(databaseName)}`); }
        finally { await admin.query('RESET ROLE'); }
      }
      for (const row of existingRoles) await admin.query(`DROP ROLE ${identifier(row.rolname)}`);
      await admin.query('DELETE FROM morfa_test_guard.allocations WHERE database_name=$1 AND proof=$2', [databaseName, proof]);
      closed = true;
    } finally { await admin.end(); }
  };
  const admin = await connect(config);
  try {
    await admin.query('BEGIN');
    await admin.query('INSERT INTO morfa_test_guard.allocations(database_name,proof,roles) VALUES($1,$2,$3::jsonb)', [databaseName, proof, JSON.stringify(roleNames)]);
    for (const key of ['migration', 'runtime', 'backup'] as const) {
      await admin.query(`CREATE ROLE ${identifier(roles[key])} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${passwords[key]}'`);
      await admin.query(`COMMENT ON ROLE ${identifier(roles[key])} IS '${comment}'`);
      await admin.query(`GRANT ${identifier(roles[key])} TO ${identifier(config.user)} WITH SET TRUE, INHERIT FALSE`);
    }
    // SECURITY DEFINER dispatch guards must inspect only this runtime role's
    // dedicated worker-session identity. The inverse direction is forbidden:
    // runtime/backup never inherit or SET the migration owner. No global stats.
    await admin.query(`GRANT ${identifier(roles.runtime)} TO ${identifier(roles.migration)} WITH INHERIT TRUE, SET FALSE, ADMIN FALSE`);
    await admin.query('COMMIT');
    initialized = true;
    await admin.query(`CREATE DATABASE ${identifier(databaseName)} OWNER ${identifier(roles.migration)} TEMPLATE template0 ENCODING 'UTF8'`);
    // Mark/restrict the database before handing any credentials to a caller.
    await admin.query(`SET ROLE ${identifier(roles.migration)}`);
    await admin.query(`COMMENT ON DATABASE ${identifier(databaseName)} IS '${comment}'`);
    await admin.query(`REVOKE ALL ON DATABASE ${identifier(databaseName)} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${identifier(databaseName)} TO ${roleNames.map(identifier).join(',')}`);
    await admin.query('RESET ROLE');
    const migration = new Client(clientConfig(config, databaseName, roles.migration, passwords.migration));
    try {
      await migration.connect();
      await migration.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
      await migration.query(`GRANT USAGE ON SCHEMA public TO ${identifier(roles.runtime)},${identifier(roles.backup)}`);
    } finally { await migration.end(); }
  } catch {
    await admin.query('ROLLBACK').catch(() => {});
    // An unmarked database is intentionally retained for operator inspection, never guessed safe.
    if (initialized) await cleanup().catch(() => {});
    throw Error('PostgreSQL isolated test database setup failed; inspect private cluster state.');
  } finally { await admin.end(); }
  const migrationUrl = connectionUrl(config, databaseName, roles.migration, passwords.migration);
  const runtimeUrl = connectionUrl(config, databaseName, roles.runtime, passwords.runtime);
  const backupUrl = connectionUrl(config, databaseName, roles.backup, passwords.backup);
  return {databaseName, clusterId: config.clusterId, roles, migrationUrl, runtimeUrl, backupUrl,
    env: {MORFA_DATABASE_URL: runtimeUrl, MORFA_MIGRATION_DATABASE_URL: migrationUrl, MORFA_BACKUP_DATABASE_URL: backupUrl}, close: cleanup};
}
