import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {Database, SqlExecutor, TransactionContext} from './client';
import {
  ACCOUNT_EVIDENCE_TABLES,
  ACCOUNT_OWNED_TABLES,
  ACCOUNT_TABLES,
  ACTIVITY_TABLES,
  OPERATOR_SETTING_TABLES,
  DESIGN_TABLES,
  DESIGN_BILLING_LEDGER_TABLES,
  DESIGN_BILLING_SUBSCRIPTION_TABLES,
  DESIGN_AI_LEDGER_TABLES,
  DESIGN_AI_EVIDENCE_TABLES,
  DESIGN_AI_BALANCE_TABLES,
  DESIGN_TEAM_TABLES,
  DESIGN_COMMENT_TABLES,
  DESIGN_LIBRARY_TABLES,
  DESIGN_LIBRARY_PICTURE_TABLES,
  DESIGN_AI_PAUSE_TABLES,
  DESIGN_FILE_CHANGE_TABLES,
  DESIGN_MEETING_TABLES,
  DESIGN_FILE_SHARE_TABLES,
  DESIGN_FILE_HEAD_TABLES,
  EMAIL_CODE_TABLES,
  SIGN_IN_BUDGET_TABLES,
  DESIGN_FAVOURITE_TABLES,
  SUPPORT_THREAD_TABLES,
  SUPPORT_MESSAGE_TABLES,
  SUPPORT_PRESENCE_TABLES,
  DESIGN_OFFER_INTRO_TABLES,
  DESIGN_TEMPLATE_TABLES,
  DESIGN_TEMPLATE_VERSION_TABLES,
  DESIGN_MEETING_SESSION_TABLES,
  SUPPORT_AI_CONVERSATION_TABLES,
  SUPPORT_AI_APPEND_TABLES,
  SUPPORT_AI_RECORD_TABLES,
  ADMIN_ANALYST_READING_TABLES,
  ADMIN_ANALYST_CONVERSATION_TABLES,
  ADMIN_ANALYST_MESSAGE_TABLES,
  ADMIN_ANALYST_USAGE_TABLES,
  MCP_CLIENT_TABLES,
  MCP_GRANT_TABLES,
  MCP_USAGE_TABLES,
  MCP_EDIT_TABLES,
  MARKETPLACE_TABLES,
} from './schema/catalog';

/** Morfa's chain: 001 accounts, 002–011 the design tool (SQL031–040, kept as history in schema/history/), 012 the collab
 *  journal, lease and checkpoints (docs/BACKEND.md §3), 013 the document caps out of the database (docs/decisions/big-files.md),
 *  014 invites by e-mail, 015 sharing one file (docs/design-tool.md §Teams), 016 the collab journal's version counter beside the file,
 *  017 proven addresses, their confirmation codes and the sign-in budget (docs/authentication.md), 018 the
 *  files and projects an account starred ("Favorites", docs/figma-parity-shell.md), 019 the support chat (shared/support.ts), 020 the
 *  launch deal's SKU and the offers an account was introduced to (payments are gone; the tables stay, unused), 021 custom
 *  team templates and the voting sessions' history, 022 the tables of the
 *  support chat's former AI assistant, 023 those of the operator console's former AI analyst, 024 "Agent" in the former AI
 *  credits' ledger (the tables stay, unused), 025 the MCP server's sign-in and daily counts (docs/mcp-server.md), 026 its `write` right and the
 *  edits an assistant made (docs/mcp-server.md §Editing), 027 marketplace cards: brand kits, seller connections, card links,
 *  publications, daily numbers and A/B tests (docs/marketplaces.md), 028 team billing: seats added within a period and the team's
 *  shared AI credits (the tables stay, unused), 029 editing someone else's file once needed a paid seat, with 30 free days
 *  for the guests who could edit before (docs/design-tool.md §Teams "File access"; the tables stay, unused). */
export const DATABASE_SCHEMA_VERSION = 29;
// Migrations 001–011 are Morfa's first release: nothing older than each of them may run on it. From 012 on, every migration
// declares in schema/rollback.json the oldest schema version whose release may still run once it is applied.
const firstDeclaredVersion = 12;
// pg_advisory_xact_lock key: "MORF", "AMIG".
const lockKey = [1297044038, 1095584071] as const;
const metadataTables = ['postgres_migrations', 'postgres_migration_state'] as const;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const fail = (message: string): never => {
  throw Error('PostgreSQL migration: ' + message);
};
const identifier = (value: string): string => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) fail('invalid role or identifier');
  return '"' + value + '"';
};
const tableList = (tables: readonly string[]) => tables.map(table => 'public.' + identifier(table)).join(',');

export type DatabaseRoles = {runtimeRole: string; backupRole: string};
/** `fresh` is the only mode: Morfa has no older database to import from. */
export type MigrationOptions = DatabaseRoles & {expectedTarget?: TargetIdentity} & {mode: 'fresh'};
type MigrationKind = 'base' | 'ordinary';
/** compatibleFrom: the oldest schema version whose release may still run once this migration is applied. */
type Migration = {
  version: number;
  name: string;
  kind: MigrationKind;
  checksum: string;
  statements: string[];
  compatibleFrom: number;
};
type MigrationRow = {
  version: number;
  name: string;
  kind: MigrationKind;
  checksum: string;
  compatible_from: number | null;
};
/** What the ledger holds: the rows this release knows, and all rows including newer ones it accepted. */
type Ledger = {known: number; database: number};
/** Trusted, reviewed code extensions only; never accepted from a CLI/request. Without compatibleFrom
 * the migration excludes every older release. */
export type OrdinaryMigration = {version: number; name: string; sql: string; compatibleFrom?: number};
type StateRow = {
  state: 'ready';
  runtime_role: string;
  backup_role: string;
  structure_fingerprint: string;
};
export type TargetIdentity = {database: string; oid: string; schema: 'public'};
export type DatabaseReadiness = {ready: boolean; state: 'missing' | 'ready'; version: number};

/** The chain, in order. Each file's statements are separated by `-- statement-breakpoint` lines. */
const CHAIN = [
  [1, 'accounts', 'base', '001-accounts.sql'],
  [2, 'design-files', 'ordinary', '002-design-files.sql'],
  [3, 'design-billing', 'ordinary', '003-design-billing.sql'],
  [4, 'design-ai', 'ordinary', '004-design-ai.sql'],
  [5, 'design-teams', 'ordinary', '005-design-teams.sql'],
  [6, 'design-comments', 'ordinary', '006-design-comments.sql'],
  [7, 'design-libraries', 'ordinary', '007-design-libraries.sql'],
  [8, 'design-ai-pauses', 'ordinary', '008-design-ai-pauses.sql'],
  [9, 'design-file-changes', 'ordinary', '009-design-file-changes.sql'],
  [10, 'design-boards', 'ordinary', '010-design-boards.sql'],
  [11, 'design-meetings', 'ordinary', '011-design-meetings.sql'],
  [12, 'design-collab', 'ordinary', '012-design-collab.sql'],
  [13, 'design-big-files', 'ordinary', '013-design-big-files.sql'],
  [14, 'design-team-email-invites', 'ordinary', '014-design-team-email-invites.sql'],
  [15, 'design-file-sharing', 'ordinary', '015-design-file-sharing.sql'],
  [16, 'design-file-heads', 'ordinary', '016-design-file-heads.sql'],
  [17, 'proven-addresses', 'ordinary', '017-proven-addresses.sql'],
  [18, 'design-favourites', 'ordinary', '018-design-favourites.sql'],
  [19, 'support', 'ordinary', '019-support.sql'],
  [20, 'launch-deal', 'ordinary', '020-launch-deal.sql'],
  [21, 'design-team-templates', 'ordinary', '021-design-team-templates.sql'],
  [22, 'support-assistant', 'ordinary', '022-support-assistant.sql'],
  [23, 'admin-analyst', 'ordinary', '023-admin-analyst.sql'],
  [24, 'design-agent-credits', 'ordinary', '024-design-agent-credits.sql'],
  [25, 'mcp-server', 'ordinary', '025-mcp-server.sql'],
  [26, 'mcp-edits', 'ordinary', '026-mcp-edits.sql'],
  [27, 'marketplaces', 'ordinary', '027-marketplaces.sql'],
  [28, 'design-team-billing', 'ordinary', '028-design-team-billing.sql'],
  [29, 'design-paid-guest-editing', 'ordinary', '029-design-paid-guest-editing.sql'],
] as const;

/**
 * schema/rollback.json is where a migration says which older releases keep working on it. A failed activation restarts the
 * previous release on the migrated schema; a deploy reads the same file to refuse one that would leave no way back. Its own
 * version means "none older".
 */
export function declaredCompatibleFrom(declared: Readonly<Record<string, unknown>>, version: number): number {
  const value = Object.hasOwn(declared, String(version))
    ? declared[String(version)]
    : version < firstDeclaredVersion
      ? version
      : fail(`migration ${version} must declare the oldest release that may run on it in schema/rollback.json`);
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > version)
    return fail(`migration ${version} must name a whole schema version between 1 and its own version`);
  return value;
}

const splitStatements = (sql: string) =>
  sql
    .split('\n-- statement-breakpoint\n')
    .map(statement => statement.trim())
    .filter(Boolean);

/** SQL is checked in explicitly; delimiters separate complete statements/functions. */
export async function loadDatabaseMigrations(): Promise<Migration[]> {
  const result: Migration[] = [];
  const rollback: unknown = JSON.parse(await readFile(new URL('./schema/rollback.json', import.meta.url), 'utf8'));
  const declared =
    rollback && typeof rollback === 'object' && 'compatibleFrom' in rollback ? rollback.compatibleFrom : undefined;
  if (!declared || typeof declared !== 'object' || Array.isArray(declared))
    return fail('schema/rollback.json must hold a compatibleFrom object');
  for (const [version, name, kind, file] of CHAIN) {
    const sql = await readFile(new URL('./schema/' + file, import.meta.url), 'utf8');
    result.push({
      version,
      name,
      kind,
      checksum: sha256(sql),
      statements: splitStatements(sql),
      compatibleFrom: declaredCompatibleFrom(declared as Record<string, unknown>, version),
    });
  }
  if (Object.keys(declared).some(version => !result.some(migration => String(migration.version) === version)))
    fail('schema/rollback.json declares a migration that is not registered');
  return result;
}

async function registry(additional: readonly OrdinaryMigration[]): Promise<Migration[]> {
  const migrations = await loadDatabaseMigrations();
  for (const entry of additional) {
    if (entry.version !== migrations.length + 1 || !/^[a-z][a-z0-9-]{0,79}$/.test(entry.name) || !entry.sql.trim())
      fail('ordinary migrations must be named, nonempty and contiguous');
    migrations.push({
      ...entry,
      kind: 'ordinary',
      compatibleFrom: declaredCompatibleFrom({[entry.version]: entry.compatibleFrom ?? entry.version}, entry.version),
      checksum: sha256(entry.sql),
      statements: splitStatements(entry.sql),
    });
  }
  return migrations;
}

async function transactionSettings(tx: TransactionContext) {
  await tx.execute('SET LOCAL search_path TO pg_catalog, public');
  await tx.execute("SET LOCAL timezone TO 'UTC'");
}

/** Anything that changes the schema outside this tool (a test's inverse migration) takes this same transaction lock. */
export async function acquireMigrationLock(tx: TransactionContext): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock($1,$2)', lockKey);
  await transactionSettings(tx);
}

async function checkServer(tx: SqlExecutor) {
  const version = await tx.one<{version: string}>("SELECT current_setting('server_version_num') AS version");
  if (!version || Number(version.version) < 180000 || Number(version.version) >= 190000)
    fail('PostgreSQL 18 is required');
}

export async function databaseTargetIdentity(tx: SqlExecutor): Promise<TargetIdentity> {
  const row = await tx.one<{database: string; oid: string}>(
    'SELECT current_database() AS database,oid::text AS oid FROM pg_database WHERE datname=current_database()',
  );
  if (!row) return fail('target database identity unavailable');
  return {...row, schema: 'public'};
}

async function assertExpectedTarget(tx: SqlExecutor, expected?: TargetIdentity): Promise<void> {
  if (!expected) return;
  const actual = await databaseTargetIdentity(tx);
  if (expected.schema !== 'public' || actual.database !== expected.database || actual.oid !== expected.oid)
    fail('pinned target database identity changed');
}

/** Detect actual catalog drift as well as edited migration files/ledger rows. */
export async function databaseStructureFingerprint(tx: TransactionContext): Promise<string> {
  await transactionSettings(tx);
  const relations = await tx.many(`SELECT c.relname AS name,c.relkind AS kind,c.relpersistence AS persistence,
    r.rolname AS owner,c.relrowsecurity AS row_security,c.relforcerowsecurity AS force_row_security,c.reloptions AS options,
    CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid,false) ELSE NULL END AS view_definition,
    CASE WHEN c.relispartition THEN pg_get_expr(c.relpartbound,c.oid) ELSE NULL END AS partition_bound
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner
    WHERE n.nspname='public' ORDER BY c.relname,c.relkind`);
  const columns = await tx.many(`SELECT c.relname AS table_name,a.attnum::integer AS ordinal,a.attname AS name,
    format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,a.attidentity AS identity,
    co.collname AS collation,
    pg_get_expr(d.adbin,d.adrelid) AS default_value
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    LEFT JOIN pg_collation co ON co.oid=a.attcollation
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f','c') AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`);
  const constraints = await tx.many(`SELECT c.relname AS table_name,k.conname AS name,k.contype AS type,
    k.convalidated AS validated,pg_get_constraintdef(k.oid,true) AS definition
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' ORDER BY c.relname,k.conname`);
  const indexes = await tx.many(
    "SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname",
  );
  const triggers =
    await tx.many(`SELECT c.relname AS table_name,t.tgname AS name,t.tgenabled AS enabled,pg_get_triggerdef(t.oid,true) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`);
  const functions = await tx.many(`SELECT p.proname AS name,p.prokind AS kind,r.rolname AS owner,
    pg_get_function_identity_arguments(p.oid) AS arguments,
    CASE WHEN p.prokind IN ('f','p') THEN pg_get_functiondef(p.oid) ELSE NULL END AS definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
    WHERE n.nspname='public' ORDER BY p.proname,pg_get_function_identity_arguments(p.oid),p.prokind`);
  // Sequence counters are data, so their values never change the schema fingerprint.
  const sequences = await tx.many(`SELECT c.relname AS name,format_type(s.seqtypid,NULL) AS type,
    s.seqstart::text AS start,s.seqincrement::text AS increment,s.seqmax::text AS maximum,
    s.seqmin::text AS minimum,s.seqcache::text AS cache,s.seqcycle AS cycle
    FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' ORDER BY c.relname`);
  const types = await tx.many(`SELECT t.typname AS name,t.typtype AS kind,t.typnotnull AS not_null,
    CASE WHEN t.typbasetype=0 THEN NULL ELSE format_type(t.typbasetype,t.typtypmod) END AS base_type,
    t.typdefault AS default_value
    FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' ORDER BY t.typname`);
  const enums = await tx.many(`SELECT t.typname AS name,e.enumsortorder AS position,e.enumlabel AS label
    FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='public' ORDER BY t.typname,e.enumsortorder`);
  const policies = await tx.many(`SELECT tablename,policyname,permissive,roles,cmd,qual,with_check
    FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname`);
  return sha256(
    JSON.stringify({relations, columns, constraints, indexes, triggers, functions, sequences, types, enums, policies}),
  );
}

async function metadataExists(tx: SqlExecutor): Promise<boolean> {
  const row = await tx.one<{ledger: string | null; state: string | null}>(
    "SELECT to_regclass('public.postgres_migrations')::text AS ledger,to_regclass('public.postgres_migration_state')::text AS state",
  );
  if (!!row?.ledger !== !!row?.state) fail('incomplete migration metadata');
  return !!row?.ledger;
}

async function bootstrap(tx: TransactionContext) {
  const relations = await tx.many<{
    name: string;
  }>(`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f','S','c')
    UNION ALL SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
    UNION ALL SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype IN ('e','d')`);
  if (relations.length) fail('target public schema is not empty and has no migration ledger');
  await tx.execute(`CREATE TABLE public.postgres_migrations(
    version INTEGER PRIMARY KEY CHECK(version>0),name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('base','ordinary')),checksum TEXT NOT NULL CHECK(checksum ~ '^[a-f0-9]{64}$'),
    applied_at TEXT NOT NULL,
    compatible_from INTEGER CONSTRAINT postgres_migrations_compatible_from_check CHECK(compatible_from BETWEEN 1 AND version))`);
  await tx.execute(`CREATE TABLE public.postgres_migration_state(
    id INTEGER PRIMARY KEY CHECK(id=1),state TEXT NOT NULL CHECK(state='ready'),
    runtime_role TEXT NOT NULL,backup_role TEXT NOT NULL,structure_fingerprint TEXT NOT NULL)`);
}

/** The newest release knows which older ones its schema still serves, including a later correction. */
async function recordDeclarations(tx: TransactionContext, migrations: Migration[]) {
  await tx.execute(
    `UPDATE public.postgres_migrations m SET compatible_from=d.compatible_from
    FROM unnest($1::integer[],$2::integer[]) AS d(version,compatible_from)
    WHERE m.version=d.version AND m.compatible_from IS DISTINCT FROM d.compatible_from`,
    [migrations.map(migration => migration.version), migrations.map(migration => migration.compatibleFrom)],
  );
}

/**
 * Every row this release knows must match it exactly. A row it does not know is refused unless
 * `allowNewer`, and then accepted only as the next ordinary version whose migration named this
 * release's schema version, or an earlier one, as the oldest that may keep running on it.
 */
async function validateLedger(tx: TransactionContext, migrations: Migration[], allowNewer = false): Promise<Ledger> {
  const applied = await tx.many<MigrationRow>(
    'SELECT version,name,kind,checksum,compatible_from FROM public.postgres_migrations ORDER BY version',
  );
  const own = migrations.at(-1)!.version;
  for (const [index, row] of applied.entries()) {
    const expected = migrations[index];
    if (!expected) {
      if (!allowNewer || row.version !== index + 1 || row.kind !== 'ordinary' || row.compatible_from === null)
        fail('unknown, newer or non-contiguous schema version');
      else if (row.compatible_from > own)
        fail(
          `unknown, newer or non-contiguous schema version: migration ${row.version} needs a release at schema version ${row.compatible_from} or later; this release is at ${own}`,
        );
      continue;
    }
    if (row.version !== expected.version) fail('unknown, newer or non-contiguous schema version');
    if (row.name !== expected.name || row.kind !== expected.kind || row.checksum !== expected.checksum)
      fail('migration checksum/name/kind mismatch at version ' + row.version);
  }
  return {known: Math.min(applied.length, migrations.length), database: applied.length};
}

async function getState(tx: SqlExecutor): Promise<StateRow> {
  const rows = await tx.many<StateRow>(
    'SELECT state,runtime_role,backup_role,structure_fingerprint FROM public.postgres_migration_state WHERE id=1',
  );
  if (rows.length !== 1 || rows[0].state !== 'ready') return fail('missing or invalid migration state');
  return rows[0];
}

async function validateRoles(tx: SqlExecutor, roles: DatabaseRoles) {
  identifier(roles.runtimeRole);
  identifier(roles.backupRole);
  const owner =
    (await tx.one<{name: string}>('SELECT current_user AS name'))?.name ?? fail('migration role unavailable');
  if (new Set([owner, roles.runtimeRole, roles.backupRole]).size !== 3)
    fail('migration, runtime and backup roles must be distinct');
  for (const role of [roles.runtimeRole, roles.backupRole]) {
    const row = await tx.one<{safe: boolean}>(
      `SELECT NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
      AND NOT pg_has_role(oid,$2,'MEMBER')
      AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=pg_roles.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND d.datdba=pg_roles.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname='public' AND n.nspowner=pg_roles.oid)
      AS safe FROM pg_roles WHERE rolname=$1`,
      [role, owner],
    );
    if (!row?.safe) fail('runtime/backup role is missing or has elevated privileges');
  }
  if (
    (
      await tx.one<{member: boolean}>("SELECT pg_has_role($1,$2,'MEMBER') OR pg_has_role($2,$1,'MEMBER') AS member", [
        roles.runtimeRole,
        roles.backupRole,
      ])
    )?.member
  )
    fail('runtime and backup roles must not inherit one another');
}

/** The whole role policy, rebuilt from nothing on every run: the backup role reads everything, the runtime role gets exactly
 *  what each table group of schema/catalog.ts needs and nothing that changes the schema. */
async function applyPrivileges(tx: TransactionContext, roles: DatabaseRoles) {
  await validateRoles(tx, roles);
  const runtime = identifier(roles.runtimeRole),
    backup = identifier(roles.backupRole);
  const identity = await databaseTargetIdentity(tx);
  await tx.execute(`REVOKE CREATE ON SCHEMA public FROM PUBLIC,${runtime},${backup}`);
  await tx.execute(
    `REVOKE CREATE,TEMPORARY ON DATABASE ${identifier(identity.database)} FROM PUBLIC,${runtime},${backup}`,
  );
  await tx.execute(`GRANT USAGE ON SCHEMA public TO ${runtime},${backup}`);
  await tx.execute(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC,${runtime},${backup}`);
  await tx.execute(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC,${runtime},${backup}`);
  await tx.execute(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC,${runtime},${backup}`);
  // A defensive sweep of column-level grants recorded by hand: the policy below is table-level only.
  const columnGrants = await tx.many<{
    table_name: string;
    columns: string[];
  }>(`SELECT c.relname AS table_name,array_agg(a.attname::text ORDER BY a.attnum) AS columns
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
    WHERE n.nspname='public' AND c.relkind IN('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL GROUP BY c.relname ORDER BY c.relname`);
  for (const table of columnGrants) {
    const columns = table.columns.map(identifier).join(',');
    await tx.execute(
      `REVOKE SELECT(${columns}),INSERT(${columns}),UPDATE(${columns}),REFERENCES(${columns}) ON public.${identifier(table.table_name)} FROM PUBLIC,${runtime},${backup}`,
    );
  }
  await tx.execute(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${backup}`);
  await tx.execute(`GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${backup}`);
  await tx.execute(`GRANT SELECT ON ${tableList(metadataTables)} TO ${runtime}`);
  for (const role of [roles.runtimeRole, roles.backupRole]) {
    if (
      (
        await tx.one<{unsafe: boolean}>(
          "SELECT has_database_privilege($1,current_database(),'CREATE,TEMPORARY') OR has_schema_privilege($1,'public','CREATE') AS unsafe",
          [role],
        )
      )?.unsafe
    )
      fail('runtime/backup role retains effective DDL privileges');
  }
  const grant = (privileges: string, tables: readonly string[]) =>
    tx.execute(`GRANT ${privileges} ON ${tableList(tables)} TO ${runtime}`);
  // 001. An account row is anonymised on erasure, never deleted.
  await grant('SELECT,INSERT,UPDATE', ACCOUNT_TABLES);
  // Sessions, external sign-ins and the account's own uploads: replaced and erased with the account.
  await grant('SELECT,INSERT,UPDATE,DELETE', ACCOUNT_OWNED_TABLES);
  // The billing's audit and the erasure ledger are evidence: added, never changed.
  await grant('SELECT,INSERT', ACCOUNT_EVIDENCE_TABLES);
  // The activity journal: recorded, pruned and erased with the account.
  await grant('SELECT,INSERT,DELETE', ACTIVITY_TABLES);
  // The operator's settings are written by the migration role only.
  await grant('SELECT', OPERATOR_SETTING_TABLES);
  // 002: files, versions and pictures are written by autosave, pruned, and erased with the file or account.
  await grant('SELECT,INSERT,UPDATE,DELETE', DESIGN_TABLES);
  // 003: payments and refunds are financial evidence (create and update, never delete); the subscription row goes with the account.
  await grant('SELECT,INSERT,UPDATE', DESIGN_BILLING_LEDGER_TABLES);
  await grant('SELECT,INSERT,UPDATE,DELETE', DESIGN_BILLING_SUBSCRIPTION_TABLES);
  // 004: the AI credit ledger is append-only (insert, never update or delete); requests are evidence (create and update, never
  // delete); the credit lots are the ledger's cache under the account lock and go with the account.
  await grant('SELECT,INSERT', DESIGN_AI_LEDGER_TABLES);
  await grant('SELECT,INSERT,UPDATE', DESIGN_AI_EVIDENCE_TABLES);
  await grant('SELECT,INSERT,UPDATE,DELETE', DESIGN_AI_BALANCE_TABLES);
  // 005: teams, members, invite links and projects are created, changed, revoked and erased with the team or the owner.
  await grant('SELECT,INSERT,UPDATE,DELETE', DESIGN_TEAM_TABLES);
  // 006: threads, comments, mentions and read state are written, resolved, deleted and erased with their file.
  await grant('SELECT,INSERT,UPDATE,DELETE', DESIGN_COMMENT_TABLES);
  // 007: libraries are published, re-held with their file, enabled and disabled, erased with the file or the account; a picture
  // copy's row is written once and goes with its picture.
  await grant('SELECT,INSERT,UPDATE,DELETE', DESIGN_LIBRARY_TABLES);
  await grant('SELECT,INSERT,DELETE', DESIGN_LIBRARY_PICTURE_TABLES);
  // 008: AI pauses are written when an action's usage outgrows its price and cleared by the operator; evidence, never deleted.
  await grant('SELECT,INSERT,UPDATE', DESIGN_AI_PAUSE_TABLES);
  // 009: saved changes of large files: written by autosave, deleted once the file's text catches up, erased with the file.
  await grant('SELECT,INSERT,DELETE', DESIGN_FILE_CHANGE_TABLES);
  // 011: the timer and votes change and are cleared by the people in the file; ballots go with the account.
  await grant('SELECT,INSERT,UPDATE,DELETE', DESIGN_MEETING_TABLES);
  // 015: a file's guests and the invites waiting for their addresses are made, changed and removed by the people sharing the file.
  await grant('SELECT,INSERT,UPDATE,DELETE', DESIGN_FILE_SHARE_TABLES);
  // 016: the journal's version counter: moved by collab's commits, erased with the file.
  await grant('SELECT,INSERT,UPDATE,DELETE', DESIGN_FILE_HEAD_TABLES);
  // 017: an account's confirmation code is sent, counted, used and erased with the account; the sign-in budget's rows are
  // counted, reset and pruned.
  await grant('SELECT,INSERT,UPDATE,DELETE', EMAIL_CODE_TABLES);
  await grant('SELECT,INSERT,UPDATE,DELETE', SIGN_IN_BUDGET_TABLES);
  // 018: an account's stars, set and taken back by it, gone with it, its files and its projects.
  await grant('SELECT,INSERT,DELETE', DESIGN_FAVOURITE_TABLES);
  // 019: a conversation is opened, read, closed, reopened and typed in; its messages are written once and never changed; an
  // operator's presence is refreshed as they work; all go with the account.
  await grant('SELECT,INSERT,UPDATE,DELETE', SUPPORT_THREAD_TABLES);
  await grant('SELECT,INSERT,DELETE', SUPPORT_MESSAGE_TABLES);
  await grant('SELECT,INSERT,UPDATE,DELETE', SUPPORT_PRESENCE_TABLES);
  // 020: an offer's introduction is recorded once and goes with the account.
  await grant('SELECT,INSERT,DELETE', DESIGN_OFFER_INTRO_TABLES);
  // 021: a board's template is published, renamed and published again by its team's editors, forgets who published it with
  // their account, and goes with the board; its versions are written once, pruned and go with it; a meeting's past voting
  // sessions are kept, deleted by editors, forget who started them with their account and go with the file.
  await grant('SELECT,INSERT,UPDATE,DELETE', DESIGN_TEMPLATE_TABLES);
  await grant('SELECT,INSERT,UPDATE,DELETE', DESIGN_TEMPLATE_VERSION_TABLES);
  await grant('SELECT,INSERT,UPDATE,DELETE', DESIGN_MEETING_SESSION_TABLES);
  // 022: an AI conversation is opened, handed off and ended, and goes with its thread; its transcript and handoffs are written once,
  // never changed (append-only), and go with it; the replies, requests and tour events are the cost and analytics record: written
  // once, never changed or deleted by the runtime.
  await grant('SELECT,INSERT,UPDATE,DELETE', SUPPORT_AI_CONVERSATION_TABLES);
  await grant('SELECT,INSERT,DELETE', SUPPORT_AI_APPEND_TABLES);
  await grant('SELECT,INSERT', SUPPORT_AI_RECORD_TABLES);
  // 023: the AI analyst's readings are written once and pruned after a month; an operator's conversation is opened, moved on and
  // erased with the operator, its messages written once (append-only) and gone with it; what each request cost is evidence.
  await grant('SELECT,INSERT,DELETE', ADMIN_ANALYST_READING_TABLES);
  await grant('SELECT,INSERT,UPDATE,DELETE', ADMIN_ANALYST_CONVERSATION_TABLES);
  await grant('SELECT,INSERT,DELETE', ADMIN_ANALYST_MESSAGE_TABLES);
  await grant('SELECT,INSERT', ADMIN_ANALYST_USAGE_TABLES);
  // 025: the MCP server's clients register and are forgotten; a grant is made, used and revoked, its requests and tokens issued,
  // spent and swept, all gone with the account; the daily counts are added to, pruned and erased with the account.
  await grant('SELECT,INSERT,UPDATE,DELETE', MCP_CLIENT_TABLES);
  await grant('SELECT,INSERT,UPDATE,DELETE', MCP_GRANT_TABLES);
  await grant('SELECT,INSERT,UPDATE,DELETE', MCP_USAGE_TABLES);
  // 026: an assistant's edits are recorded, marked undone, pruned, and go with the connection or the file.
  await grant('SELECT,INSERT,UPDATE,DELETE', MCP_EDIT_TABLES);
  // 027: brand kits are edited and deleted; connections checked, synced and removed; card links, pictures, publications, tests and
  // the daily numbers made, updated, swept and erased with the account.
  await grant('SELECT,INSERT,UPDATE,DELETE', MARKETPLACE_TABLES);
  await tx.execute(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${runtime}`);
}

/** Role management is explicit and uses only existing roles, never CREATE ROLE. */
export async function configureDatabasePrivileges(
  database: Database,
  roles: DatabaseRoles,
  additional: readonly OrdinaryMigration[] = [],
): Promise<void> {
  const migrations = await registry(additional);
  await database.transaction(async tx => {
    await acquireMigrationLock(tx);
    const state = await getState(tx);
    const version = (await validateLedger(tx, migrations)).known;
    if (
      version !== migrations.at(-1)!.version ||
      state.structure_fingerprint !== (await databaseStructureFingerprint(tx))
    )
      fail('privilege changes require a verified compatible schema');
    if (state.runtime_role !== roles.runtimeRole || state.backup_role !== roles.backupRole)
      fail('role identity differs from the migration state');
    await applyPrivileges(tx, roles);
  });
}

async function install(tx: TransactionContext, migration: Migration) {
  for (const statement of migration.statements) await tx.execute(statement);
  await tx.execute(
    'INSERT INTO public.postgres_migrations(version,name,kind,checksum,applied_at,compatible_from) VALUES($1,$2,$3,$4,$5,$6)',
    [
      migration.version,
      migration.name,
      migration.kind,
      migration.checksum,
      new Date().toISOString(),
      migration.compatibleFrom,
    ],
  );
}

/**
 * Brings the database to this release's schema in one transaction: an empty schema gets the whole chain from 001, a migrated one
 * the migrations it lacks. The ledger, the readiness state, the structure fingerprint and the role policy commit together with
 * every DDL statement, so a half-migrated database is never visible. Concurrent runs serialize on the advisory lock.
 */
export async function migrateDatabase(
  database: Database,
  options: MigrationOptions,
  additional: readonly OrdinaryMigration[] = [],
): Promise<DatabaseReadiness> {
  options = {...options, expectedTarget: options.expectedTarget && {...options.expectedTarget}};
  if (options.mode !== 'fresh') fail('the only migration mode is fresh');
  const migrations = await registry(additional);
  return database.transaction(
    async tx => {
      await assertExpectedTarget(tx, options.expectedTarget);
      await acquireMigrationLock(tx);
      await checkServer(tx);
      await validateRoles(tx, options);
      if (await metadataExists(tx)) {
        const ledger = await validateLedger(tx, migrations, true);
        let version = ledger.known;
        const state = await getState(tx);
        if (state.runtime_role !== options.runtimeRole || state.backup_role !== options.backupRole)
          fail('role identity differs from the migration state');
        if (state.structure_fingerprint !== (await databaseStructureFingerprint(tx)))
          fail('database structure differs from the verified catalog');
        if (version < 1) fail('schema version and readiness state disagree');
        // A newer release migrated this database and declared that this one still runs on it. Its
        // ledger, fingerprint and privileges describe a catalog this release does not know: leave them.
        if (ledger.database > version) return {ready: true, state: 'ready', version: ledger.database};
        for (const migration of migrations.slice(version)) {
          if (migration.kind !== 'ordinary') fail('a migrated database cannot take a base migration again');
          await install(tx, migration);
          version = migration.version;
        }
        await recordDeclarations(tx, migrations);
        await tx.execute('UPDATE public.postgres_migration_state SET structure_fingerprint=$1 WHERE id=1', [
          await databaseStructureFingerprint(tx),
        ]);
        await applyPrivileges(tx, options);
        return {ready: true, state: 'ready', version};
      }
      await bootstrap(tx);
      for (const migration of migrations) await install(tx, migration);
      // Ordinary migrations bind permissions to these exact recorded roles.
      await tx.execute(
        `INSERT INTO public.postgres_migration_state(id,state,runtime_role,backup_role,structure_fingerprint)
      VALUES(1,'ready',$1,$2,$3)`,
        [options.runtimeRole, options.backupRole, await databaseStructureFingerprint(tx)],
      );
      await applyPrivileges(tx, options);
      return {ready: true, state: 'ready', version: migrations.at(-1)!.version};
    },
    {timeoutMs: 600000},
  );
}

/**
 * Runtime readiness is read-only and fails closed on metadata or catalog drift. A release also starts
 * on a database that newer migrations moved ahead of it, as long as each of them declared so: that is
 * the state a failed activation leaves for the previous release.
 */
export async function readDatabaseReadiness(
  database: Database,
  additional: readonly OrdinaryMigration[] = [],
): Promise<DatabaseReadiness> {
  const migrations = await registry(additional);
  return database.transaction(
    async tx => {
      await transactionSettings(tx);
      await checkServer(tx);
      if (!(await metadataExists(tx))) return {ready: false, state: 'missing', version: 0};
      const ledger = await validateLedger(tx, migrations, true),
        state = await getState(tx);
      if (state.structure_fingerprint !== (await databaseStructureFingerprint(tx)))
        fail('database structure differs from the verified catalog');
      if (ledger.known !== migrations.at(-1)!.version) fail('schema version and readiness state disagree');
      return {ready: true, state: 'ready', version: ledger.database};
    },
    {readOnly: true, timeoutMs: 30000},
  );
}

export async function assertDatabaseReady(database: Database): Promise<void> {
  const readiness = await readDatabaseReadiness(database);
  if (!readiness.ready) fail('database is not ready for application traffic');
  if (readiness.version > DATABASE_SCHEMA_VERSION)
    console.warn(
      `PostgreSQL migration: the database is at schema version ${readiness.version}; this release is at ${DATABASE_SCHEMA_VERSION} and runs on it as a declared compatible older release.`,
    );
}
