// Reviewed table inventory of Morfa's migration chain (001–011). Engine metadata (postgres_migrations, postgres_migration_state)
// is separate. server/postgresql/migrations.ts grants the runtime role exactly what each group lists below.

// 001: accounts and what the server keeps beside them.
/** Read and written by the runtime; an account row is anonymised on erasure, never deleted. */
export const ACCOUNT_TABLES = ['users'] as const;
/** Sessions, external sign-ins and the account's own uploads: created, replaced and erased with the account. */
export const ACCOUNT_OWNED_TABLES = ['sessions', 'identities', 'uploads'] as const;
/** Evidence: the runtime adds rows and never changes or deletes them (the billing's audit, the erasure ledger). */
export const ACCOUNT_EVIDENCE_TABLES = ['launch_audit', 'erasure_ledger'] as const;
/** The activity journal: recorded per request, pruned and erased with the account. */
export const ACTIVITY_TABLES = ['admin_activity'] as const;
/** The operator's settings: read by the runtime only. */
export const OPERATOR_SETTING_TABLES = ['admin_cost_settings'] as const;
/** Every table of 001. The design tables (002–011) are not in it. */
export const APPLICATION_TABLES = [
  ...ACCOUNT_TABLES,
  ...ACCOUNT_OWNED_TABLES,
  ...ACCOUNT_EVIDENCE_TABLES,
  ...ACTIVITY_TABLES,
  ...OPERATOR_SETTING_TABLES,
] as const;

// 002: design files, their saved versions and the pictures placed in them (server/design).
export const DESIGN_TABLES = ['design_files', 'design_file_versions', 'design_images'] as const;
// 003: the Professional plan: what was paid and refunded (evidence: kept when the account is erased), and the subscription itself
// (goes with the account).
export const DESIGN_BILLING_LEDGER_TABLES = ['design_payments', 'design_refunds'] as const;
export const DESIGN_BILLING_SUBSCRIPTION_TABLES = ['design_subscriptions'] as const;
// 004: AI credits: the append-only ledger, the requests (both kept as evidence) and the credit lots (the ledger's cache, erased with
// the account).
export const DESIGN_AI_LEDGER_TABLES = ['design_ai_ledger'] as const;
export const DESIGN_AI_EVIDENCE_TABLES = ['design_ai_requests'] as const;
export const DESIGN_AI_BALANCE_TABLES = ['design_ai_balances'] as const;
// 005: teams: workspaces, their members, invite links (token hashes only) and projects. 014 only adds a column (an invite's e-mail).
export const DESIGN_TEAM_TABLES = [
  'design_teams',
  'design_team_members',
  'design_team_invites',
  'design_projects',
] as const;
// 006: comments: threads pinned to a file's page, their comments, mentions of members and each account's read state.
export const DESIGN_COMMENT_TABLES = [
  'design_comment_threads',
  'design_comments',
  'design_comment_mentions',
  'design_comment_reads',
] as const;
// 007: shared libraries: libraries, their immutable versions, the files that enabled them, and picture copies made for files of
// another place.
export const DESIGN_LIBRARY_TABLES = [
  'design_libraries',
  'design_library_versions',
  'design_library_subscriptions',
] as const;
export const DESIGN_LIBRARY_PICTURE_TABLES = ['design_library_pictures'] as const;
// 008: AI pauses: an action paused because its reported usage cost more than its price table's ceiling (evidence: kept).
export const DESIGN_AI_PAUSE_TABLES = ['design_ai_pauses'] as const;
// 009: saved changes of large files: what saves changed after the version a file's stored text holds.
export const DESIGN_FILE_CHANGE_TABLES = ['design_file_changes'] as const;
// 011: meetings: a file's shared timer and voting session, and the ballots (hidden until it ends). 010 only adds a column.
export const DESIGN_MEETING_TABLES = ['design_meetings', 'design_meeting_votes'] as const;
// 015: sharing one file: its guests and the invites waiting for their addresses (design_files gains link_access).
export const DESIGN_FILE_SHARE_TABLES = ['design_file_members', 'design_file_invites'] as const;
// 016: the collab journal's version counter beside the file (written only by a node run with MORFA_JOURNAL_VERSION_HEADS=1).
export const DESIGN_FILE_HEAD_TABLES = ['design_file_heads'] as const;
// 017: "Confirm e-mail" (since removed): the code sent to an account's address (users.email becomes unique among proven addresses only), and
// the sign-in routes' one budget per client address, shared by the api processes.
export const EMAIL_CODE_TABLES = ['account_email_codes'] as const;
export const SIGN_IN_BUDGET_TABLES = ['sign_in_budget'] as const;
// 018: "Favorites": the files and projects an account starred (only it sees them).
export const DESIGN_FAVOURITE_TABLES = ['design_favourite_files', 'design_favourite_projects'] as const;
// 019: the support chat (shared/support.ts): one conversation per account with Morfa's operators (opened, read, closed, typed in),
// its messages (written once, never changed), and when each operator last used the console; all go with the account.
export const SUPPORT_THREAD_TABLES = ['support_threads'] as const;
export const SUPPORT_MESSAGE_TABLES = ['support_messages'] as const;
export const SUPPORT_PRESENCE_TABLES = ['support_operator_presence'] as const;
// 020: the launch deal: the offers an account was introduced to (once per account; design_payments gains the deal's SKU).
export const DESIGN_OFFER_INTRO_TABLES = ['design_offer_intros'] as const;
// 021: custom team templates (a board published for its team) and their versions; a meeting's past voting sessions.
export const DESIGN_TEMPLATE_TABLES = ['design_templates'] as const;
export const DESIGN_TEMPLATE_VERSION_TABLES = ['design_template_versions'] as const;
export const DESIGN_MEETING_SESSION_TABLES = ['design_meeting_sessions'] as const;
// 022: the support chat's AI assistant (shared/support-assistant.ts): its conversations (opened, handed off, ended, erased with the
// thread); the API transcript and the handoffs (written once, erased with the conversation); the replies, the requests and the tours'
// events (the cost and analytics record: written once, kept).
export const SUPPORT_AI_CONVERSATION_TABLES = ['support_ai_conversations'] as const;
export const SUPPORT_AI_APPEND_TABLES = ['support_ai_transcript', 'support_ai_handoffs'] as const;
export const SUPPORT_AI_RECORD_TABLES = ['support_ai_replies', 'support_ai_requests', 'support_tour_events'] as const;
// 023: the operator console's AI analyst (shared/admin-analyst.ts): its readings of a period (kept a month), the operators'
// conversations with it and their messages (append-only, gone with the operator), and what each request to the model cost (evidence).
export const ADMIN_ANALYST_READING_TABLES = ['admin_analyst_insights'] as const;
export const ADMIN_ANALYST_CONVERSATION_TABLES = ['admin_analyst_conversations'] as const;
export const ADMIN_ANALYST_MESSAGE_TABLES = ['admin_analyst_messages'] as const;
export const ADMIN_ANALYST_USAGE_TABLES = ['admin_analyst_usage'] as const;
// 025: the MCP server (docs/mcp-server.md): the assistants that registered, what a person allowed them (the grants, their authorization
// requests and tokens), and the calls each account made in a day.
export const MCP_CLIENT_TABLES = ['oauth_clients'] as const;
export const MCP_GRANT_TABLES = ['oauth_grants', 'oauth_codes', 'oauth_tokens'] as const;
export const MCP_USAGE_TABLES = ['mcp_daily_calls'] as const;
// 023: the edits an assistant made through the MCP server, with their way back (docs/mcp-server.md §Editing).
export const MCP_EDIT_TABLES = ['mcp_edits', 'mcp_uploads'] as const;
// 027: marketplace cards (docs/marketplaces.md): brand kits, seller connections, card links, published pictures, A/B tests, publications
// and the daily numbers.
export const MARKETPLACE_TABLES = [
  'marketplace_brand_kits',
  'marketplace_connections',
  'marketplace_card_links',
  'marketplace_media',
  'marketplace_tests',
  'marketplace_publications',
  'marketplace_metrics',
] as const;
