-- Invites by e-mail (docs/design-tool.md §Teams, "Invite by e-mail"): an invite may name the address it was made for. The person
-- of that address sees it in the app after signing in (once the address is proven theirs) and joins or declines it there; the link
-- of the invite works as any other link. Such an invite lets one person in. A link without an address stays as it was.
--
-- Older releases keep working on it (schema/rollback.json: compatible from 13): the column is nullable, and a release that does not
-- know it reads an e-mail invite as a link of one use.
ALTER TABLE public.design_team_invites
  ADD COLUMN email text COLLATE "C" CHECK(email IS NULL OR (char_length(email) BETWEEN 3 AND 320 AND email=lower(email) AND email ~ '^[^@\s]+@[^@\s]+$')),
  ADD CONSTRAINT design_team_invites_email_once CHECK(email IS NULL OR max_uses=1);
-- statement-breakpoint
-- The invitations waiting for an address (the invitee's list), and a team's invite of one address (no second one while it waits).
CREATE INDEX design_team_invites_email ON public.design_team_invites(email,team_id) WHERE email IS NOT NULL AND revoked_at IS NULL;
