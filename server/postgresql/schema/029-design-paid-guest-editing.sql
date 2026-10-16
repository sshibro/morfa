-- Editing someone else's file needs a paid seat (the owner, 2026-10-13; docs/design-tool.md §Teams, "File access"): a file's guest
-- (someone it was shared with, or who opened it by its link) edits only on their own running Professional plan or with an editor seat
-- in a team whose plan runs; every other guest views and comments, which stay free. Team members and a file's owner are not affected.
-- Who may do what is still decided in one place, server/design/file-access.ts `fileRoleJoins`.
--
-- The guests who could edit before this release keep editing free for 30 days, or until the end of the period the file's owner has
-- already paid for when that is later (the offer: a paid period keeps what the plan held when it was paid; a team file's owner is its
-- team): `free_edit_until` is the instant until which a guest edits without a paid seat, ISO-8601 UTC text as
-- design_subscriptions.grace_until is (the rule compares the two kinds as text with the database's clock written the same way). NULL
-- for every guest added later.
--
-- It comes right after SQL028 (team billing), released with it.
-- Older releases keep working on it (schema/rollback.json: compatible from 20): the column is new and nullable; a release that does not
-- know it lets every guest edit as before.
ALTER TABLE public.design_file_members ADD COLUMN free_edit_until text COLLATE "C"
  CHECK(free_edit_until IS NULL OR free_edit_until ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$');
-- statement-breakpoint
-- Who could edit when this runs: a guest invited to edit, and every guest (invited, or come by the link) of a file whose link lets anyone
-- edit. One clock reading for all of them: the transaction's.
UPDATE public.design_file_members x
   SET free_edit_until=GREATEST(to_char((now()+interval '30 days') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         (SELECT s.paid_until FROM public.design_subscriptions s
           WHERE s.user_id=CASE WHEN f.team_id IS NULL THEN f.user_id ELSE 'design-team:'||f.team_id END AND s.state='active'))
  FROM public.design_files f
 WHERE f.id=x.file_id AND (x.role='editor' OR f.link_access='edit');
