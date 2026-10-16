-- Design files and "Board" meetings (docs/board-meeting.md): a file's shared timer and its voting session with the ballots.
-- The rows belong to the file: erasing it (and so a team or the account that
-- holds it) takes them (ON DELETE CASCADE). What people do live (cursor chat, emote bursts, a wave, "High five") is presence of
-- the co-editing stream and never reaches a table. Who may do what is decided by server/design/meeting/ through
-- server/design/file-access.ts; erasing an account deletes its ballots and forgets it as the one who started a timer or a vote.
-- Ships with 002–010 (the design tool's first release).
CREATE TABLE public.design_meetings (
  file_id text COLLATE "C" PRIMARY KEY REFERENCES public.design_files(id) ON DELETE CASCADE,
  -- Grows with every change of the row; the editors keep the newest answer and ignore older ones.
  revision bigint NOT NULL CHECK(revision > 0),
  -- The timer: none (every timer column NULL), running until timer_ends_at, or paused with timer_remaining_ms left.
  timer_state text COLLATE "C" CHECK(timer_state IN('running','paused')),
  timer_duration_ms integer CHECK(timer_duration_ms BETWEEN 1000 AND 5999000),
  timer_ends_at timestamptz,
  timer_remaining_ms integer CHECK(timer_remaining_ms BETWEEN 0 AND 5999000),
  -- Background music the editors play while it runs (a generator in the browser; nothing is fetched).
  timer_music text COLLATE "C" CHECK(timer_music IN('lofi','ambient','rain')),
  timer_by text COLLATE "C" REFERENCES public.users(id) ON DELETE SET NULL,
  -- The voting session: none, running (vote_ended_at NULL; it also ends once vote_ends_at passes) or ended, its results kept until an
  -- editor clears them or starts the next one.
  vote_id text COLLATE "C" CHECK(vote_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  vote_by text COLLATE "C" REFERENCES public.users(id) ON DELETE SET NULL,
  vote_per_person smallint CHECK(vote_per_person BETWEEN 1 AND 20),
  -- It ends when the timer reaches zero, and pauses with it.
  vote_with_timer boolean,
  vote_started_at timestamptz,
  vote_ends_at timestamptz,
  vote_ended_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((timer_state IS NULL) = (timer_duration_ms IS NULL)),
  CHECK(timer_state IS NOT NULL OR (timer_ends_at IS NULL AND timer_remaining_ms IS NULL AND timer_music IS NULL AND timer_by IS NULL)),
  CHECK(timer_state IS DISTINCT FROM 'running' OR (timer_ends_at IS NOT NULL AND timer_remaining_ms IS NULL)),
  CHECK(timer_state IS DISTINCT FROM 'paused' OR (timer_ends_at IS NULL AND timer_remaining_ms IS NOT NULL)),
  CHECK((vote_id IS NULL) = (vote_per_person IS NULL) AND (vote_id IS NULL) = (vote_with_timer IS NULL) AND (vote_id IS NULL) = (vote_started_at IS NULL)),
  CHECK(vote_id IS NOT NULL OR (vote_by IS NULL AND vote_ends_at IS NULL AND vote_ended_at IS NULL))
);
-- statement-breakpoint
CREATE INDEX design_meetings_timer_by ON public.design_meetings(timer_by) WHERE timer_by IS NOT NULL;
-- statement-breakpoint
CREATE INDEX design_meetings_vote_by ON public.design_meetings(vote_by) WHERE vote_by IS NOT NULL;
-- statement-breakpoint
-- One person's votes for one object in one session (a dot each). Hidden from everyone else until the session ends.
CREATE TABLE public.design_meeting_votes (
  file_id text COLLATE "C" NOT NULL REFERENCES public.design_meetings(file_id) ON DELETE CASCADE,
  vote_id text COLLATE "C" NOT NULL CHECK(vote_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  user_id text COLLATE "C" NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  node_id text COLLATE "C" NOT NULL CHECK(node_id ~ '^[A-Za-z0-9_:;.,-]+$' AND char_length(node_id)<=512),
  count smallint NOT NULL CHECK(count BETWEEN 1 AND 20),
  PRIMARY KEY(file_id,vote_id,user_id,node_id)
);
-- statement-breakpoint
CREATE INDEX design_meeting_votes_user ON public.design_meeting_votes(user_id);
