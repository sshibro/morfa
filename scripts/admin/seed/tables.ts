// The rows the demo model produces, table by table, in the order they are written (parents before children). Each table names its
// columns with the PostgreSQL array type its values are sent as: the writer inserts a whole table with one multi-row
// `INSERT … SELECT FROM unnest($1::text[], …)` per chunk. Columns left out keep their defaults (image_files '{}', fence 0, …).

export type ColumnType = 'text' | 'int8' | 'int4' | 'int2' | 'float8' | 'timestamptz' | 'bool';
type Spec = Readonly<Record<string, ColumnType>>;

const SPECS = {
  users: {
    id: 'text',
    email: 'text',
    name: 'text',
    password: 'text',
    email_verified: 'int8',
    created_at: 'text',
    deletion_requested_at: 'text',
    erasure_completed_at: 'text',
  },
  sessions: {token: 'text', user_id: 'text', expires: 'int8', created_at: 'text'},
  erasure_ledger: {id: 'text', kind: 'text', erased_at: 'text'},
  design_teams: {id: 'text', name: 'text', owner_id: 'text', created_at: 'timestamptz', deleted_at: 'timestamptz'},
  design_team_members: {team_id: 'text', user_id: 'text', role: 'text', joined_at: 'timestamptz', invited_by: 'text'},
  design_team_invites: {
    id: 'text',
    team_id: 'text',
    token: 'text',
    role: 'text',
    created_by: 'text',
    created_at: 'timestamptz',
    expires_at: 'timestamptz',
    max_uses: 'int4',
    uses: 'int4',
    revoked_at: 'timestamptz',
    email: 'text',
  },
  design_projects: {id: 'text', team_id: 'text', name: 'text', created_at: 'timestamptz', deleted_at: 'timestamptz'},
  design_files: {
    id: 'text',
    user_id: 'text',
    team_id: 'text',
    project_id: 'text',
    name: 'text',
    document: 'text',
    version: 'int8',
    bytes: 'int4',
    node_count: 'int4',
    thumbnail_filename: 'text',
    client_id: 'text',
    auto_version_at: 'timestamptz',
    created_at: 'timestamptz',
    updated_at: 'timestamptz',
    trashed_at: 'timestamptz',
    kind: 'text',
    link_access: 'text',
  },
  design_file_versions: {
    id: 'text',
    file_id: 'text',
    user_id: 'text',
    version: 'int8',
    label: 'text',
    document: 'text',
    bytes: 'int4',
    created_at: 'timestamptz',
  },
  design_images: {
    filename: 'text',
    user_id: 'text',
    file_id: 'text',
    kind: 'text',
    bytes: 'int4',
    width: 'int4',
    height: 'int4',
    created_at: 'timestamptz',
    team_id: 'text',
    content_hash: 'text',
    storage_key: 'text',
  },
  design_file_members: {file_id: 'text', user_id: 'text', role: 'text', invited_by: 'text', created_at: 'timestamptz'},
  design_favourite_files: {user_id: 'text', file_id: 'text', created_at: 'timestamptz'},
  design_comment_threads: {
    id: 'text',
    file_id: 'text',
    page_id: 'text',
    x: 'float8',
    y: 'float8',
    node_id: 'text',
    offset_x: 'float8',
    offset_y: 'float8',
    author_id: 'text',
    created_at: 'timestamptz',
    resolved_at: 'timestamptz',
    resolved_by: 'text',
    seq: 'int8',
  },
  design_comments: {
    id: 'text',
    thread_id: 'text',
    author_id: 'text',
    body: 'text',
    created_at: 'timestamptz',
    seq: 'int8',
  },
  design_comment_mentions: {comment_id: 'text', user_id: 'text', at: 'int4', length: 'int4'},
  design_comment_reads: {thread_id: 'text', user_id: 'text', read_seq: 'int8'},
  design_libraries: {
    id: 'text',
    file_id: 'text',
    user_id: 'text',
    version: 'int4',
    published_at: 'timestamptz',
    unpublished_at: 'timestamptz',
    created_at: 'timestamptz',
  },
  design_library_versions: {
    id: 'text',
    library_id: 'text',
    user_id: 'text',
    version: 'int4',
    file_version: 'int8',
    description: 'text',
    manifest: 'text',
    snapshot: 'text',
    bytes: 'int4',
    published_by: 'text',
    created_at: 'timestamptz',
  },
  design_library_subscriptions: {
    file_id: 'text',
    library_id: 'text',
    enabled_by: 'text',
    enabled_at: 'timestamptz',
    seen_version: 'int4',
  },
  design_meetings: {
    file_id: 'text',
    revision: 'int8',
    timer_state: 'text',
    timer_duration_ms: 'int4',
    timer_remaining_ms: 'int4',
    timer_music: 'text',
    timer_by: 'text',
    vote_id: 'text',
    vote_by: 'text',
    vote_per_person: 'int2',
    vote_with_timer: 'bool',
    vote_started_at: 'timestamptz',
    vote_ended_at: 'timestamptz',
    updated_at: 'timestamptz',
  },
  design_meeting_votes: {file_id: 'text', vote_id: 'text', user_id: 'text', node_id: 'text', count: 'int2'},
  admin_activity: {id: 'text', user_id: 'text', action: 'text', created_at: 'text'},
} as const satisfies Record<string, Spec>;

export type TableName = keyof typeof SPECS;
/** The tables in the order they are written: every foreign key points at a table written earlier. */
export const TABLE_ORDER = Object.keys(SPECS) as TableName[];
export type Row<T extends TableName> = {-readonly [K in keyof (typeof SPECS)[T]]?: string | number | boolean | null};

export class TableRows<T extends TableName = TableName> {
  readonly columns: readonly string[];
  readonly types: readonly ColumnType[];
  rows: Row<T>[] = [];
  constructor(readonly name: T) {
    const spec: Spec = SPECS[name];
    this.columns = Object.keys(spec);
    this.types = Object.values(spec);
  }
  add(row: Row<T>): Row<T> {
    this.rows.push(row);
    return row;
  }
}

export type Tables = {[T in TableName]: TableRows<T>};
export function emptyTables(): Tables {
  return Object.fromEntries(TABLE_ORDER.map(name => [name, new TableRows(name)])) as Tables;
}
