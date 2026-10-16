-- Design boards ("Board", docs/board.md §File kind): a file of the design tool is a design file or a board, the
-- whiteboard that opens in its own editor on the same document model. The kind is fixed when the file is made and copied
-- with it (a duplicate, a version's copy); every file made before this migration is a design file. A board is a file in every
-- other respect: the plan's file limit, the trash, versions, comments, teams and the account's room for documents count it.
-- Ships with 002–009 (the design tool's first release), so no release that makes design files without a kind ever runs on it.
ALTER TABLE public.design_files ADD COLUMN kind text COLLATE "C" NOT NULL DEFAULT 'design' CHECK(kind IN('design','board'));
