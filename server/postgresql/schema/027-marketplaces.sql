-- "Marketplaces" (docs/marketplaces.md): product cards for Wildberries, Ozon and Yandex Market. Card Canvas keeps everything in the
-- file itself (layers' pluginData); Catalog Generation keeps an account's brand kits here; the Performance Loop keeps the seller's
-- connections (their API keys encrypted), which card frame stands for which product, what was published, the daily numbers the
-- marketplaces report and the A/B tests run from Morfa.
--
-- Older releases keep working on it (schema/rollback.json): every table is new and nothing older reads them.

-- A brand kit (Catalog Generation): the fonts, colours, logos, icons and tone every generated card follows. `kit` is the kit as the
-- editor edits it (shared/design/marketplace/brand-kit.ts checks it); pictures in it are the account's design pictures. Erased with
-- the account (server/launch/lifecycle.ts).
CREATE TABLE public.marketplace_brand_kits (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f-]{36}$'),
  user_id text COLLATE "C" NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 80),
  kit jsonb NOT NULL CHECK(jsonb_typeof(kit)='object' AND octet_length(kit::text) <= 65536),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- statement-breakpoint
CREATE INDEX marketplace_brand_kits_user ON public.marketplace_brand_kits(user_id, updated_at DESC);
-- statement-breakpoint

-- A seller's account on a marketplace, connected by its API key (WB: one token; Ozon: Client-Id and Api-Key). `secret` is the AES-GCM
-- envelope of server/hosting/secrets.ts, never the key itself; `hint` tells two keys apart (the last characters, the Client-Id).
CREATE TABLE public.marketplace_connections (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f-]{36}$'),
  user_id text COLLATE "C" NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  marketplace text COLLATE "C" NOT NULL CHECK(marketplace IN('wb','ozon')),
  label text NOT NULL CHECK(char_length(label) BETWEEN 1 AND 80),
  secret text NOT NULL CHECK(char_length(secret) BETWEEN 1 AND 8192),
  hint text NOT NULL CHECK(char_length(hint) BETWEEN 1 AND 40),
  status text COLLATE "C" NOT NULL DEFAULT 'ok' CHECK(status IN('ok','refused','error')),
  last_error text CHECK(last_error IS NULL OR char_length(last_error) <= 500),
  checked_at timestamptz,
  synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- statement-breakpoint
CREATE INDEX marketplace_connections_user ON public.marketplace_connections(user_id, created_at DESC);
-- statement-breakpoint

-- A card frame of a file standing for one photo slot of a product on the marketplace. WB: `product_id` is the nmID; Ozon: the
-- product_id, `sku` the SKU its analytics count by. Gone with the file or the connection.
CREATE TABLE public.marketplace_card_links (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f-]{36}$'),
  user_id text COLLATE "C" NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  file_id text COLLATE "C" NOT NULL REFERENCES public.design_files(id) ON DELETE CASCADE,
  node_id text COLLATE "C" NOT NULL CHECK(char_length(node_id) BETWEEN 1 AND 200),
  connection_id text COLLATE "C" NOT NULL REFERENCES public.marketplace_connections(id) ON DELETE CASCADE,
  product_id text COLLATE "C" NOT NULL CHECK(char_length(product_id) BETWEEN 1 AND 64),
  sku text COLLATE "C" CHECK(sku IS NULL OR char_length(sku) BETWEEN 1 AND 64),
  title text CHECK(title IS NULL OR char_length(title) <= 300),
  slot smallint NOT NULL DEFAULT 1 CHECK(slot BETWEEN 1 AND 30),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(file_id, node_id)
);
-- statement-breakpoint
CREATE INDEX marketplace_card_links_product ON public.marketplace_card_links(connection_id, product_id);
-- statement-breakpoint
CREATE INDEX marketplace_card_links_user ON public.marketplace_card_links(user_id);
-- statement-breakpoint

-- A published picture the marketplace downloads (Ozon takes pictures by link): served at /api/marketplace-media/<token> with no
-- session while it lasts; the token is stored only as sha256. Swept when it expires.
CREATE TABLE public.marketplace_media (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f-]{36}$'),
  token_hash text COLLATE "C" NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
  user_id text COLLATE "C" NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  filename text COLLATE "C" NOT NULL CHECK(filename ~ '^[a-zA-Z0-9_.-]{1,200}$'),
  bytes integer NOT NULL CHECK(bytes BETWEEN 1 AND 10485760),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL
);
-- statement-breakpoint
CREATE INDEX marketplace_media_expires ON public.marketplace_media(expires_at);
-- statement-breakpoint
CREATE INDEX marketplace_media_user ON public.marketplace_media(user_id);
-- statement-breakpoint

-- An A/B test of two card frames for one product slot. `cabinet`: the marketplace's own test, started in the seller's cabinet and
-- followed here; `rotation`: Morfa itself swaps the photo every `swap_hours` and compares the numbers of each variant's hours. A
-- rotation keeps both pictures (`media_a`, `media_b`, uploaded when it starts) for the worker to swap in.
CREATE TABLE public.marketplace_tests (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f-]{36}$'),
  user_id text COLLATE "C" NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  link_id text COLLATE "C" NOT NULL REFERENCES public.marketplace_card_links(id) ON DELETE CASCADE,
  file_id text COLLATE "C" NOT NULL REFERENCES public.design_files(id) ON DELETE CASCADE,
  variant_a text COLLATE "C" NOT NULL CHECK(char_length(variant_a) BETWEEN 1 AND 200),
  variant_b text COLLATE "C" NOT NULL CHECK(char_length(variant_b) BETWEEN 1 AND 200),
  media_a text COLLATE "C" REFERENCES public.marketplace_media(id) ON DELETE SET NULL,
  media_b text COLLATE "C" REFERENCES public.marketplace_media(id) ON DELETE SET NULL,
  mode text COLLATE "C" NOT NULL CHECK(mode IN('cabinet','rotation')),
  status text COLLATE "C" NOT NULL DEFAULT 'planned' CHECK(status IN('planned','running','finished','stopped')),
  days smallint NOT NULL CHECK(days BETWEEN 1 AND 60),
  swap_hours smallint CHECK(swap_hours IS NULL OR swap_hours BETWEEN 6 AND 168),
  live_variant text COLLATE "C" CHECK(live_variant IS NULL OR live_variant IN('a','b')),
  next_swap_at timestamptz,
  started_at timestamptz,
  ends_at timestamptz,
  finished_at timestamptz,
  winner text COLLATE "C" CHECK(winner IS NULL OR winner IN('a','b','none')),
  result jsonb CHECK(result IS NULL OR jsonb_typeof(result)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(variant_a <> variant_b),
  CHECK(mode <> 'rotation' OR swap_hours IS NOT NULL)
);
-- statement-breakpoint
CREATE INDEX marketplace_tests_link ON public.marketplace_tests(link_id, created_at DESC);
-- statement-breakpoint
CREATE INDEX marketplace_tests_running ON public.marketplace_tests(next_swap_at) WHERE status='running';
-- statement-breakpoint
CREATE INDEX marketplace_tests_user ON public.marketplace_tests(user_id);
-- statement-breakpoint

-- One picture sent to the marketplace for a linked slot: which frame (a test's variant, or the link's own frame), its state, and the
-- hours it was the live photo, which the numbers below are counted to.
CREATE TABLE public.marketplace_publications (
  id text COLLATE "C" PRIMARY KEY CHECK(id ~ '^[0-9a-f-]{36}$'),
  user_id text COLLATE "C" NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  link_id text COLLATE "C" NOT NULL REFERENCES public.marketplace_card_links(id) ON DELETE CASCADE,
  node_id text COLLATE "C" NOT NULL CHECK(char_length(node_id) BETWEEN 1 AND 200),
  test_id text COLLATE "C" REFERENCES public.marketplace_tests(id) ON DELETE SET NULL,
  media_id text COLLATE "C" REFERENCES public.marketplace_media(id) ON DELETE SET NULL,
  status text COLLATE "C" NOT NULL DEFAULT 'pending' CHECK(status IN('pending','sent','live','failed','replaced')),
  external_ref text CHECK(external_ref IS NULL OR char_length(external_ref) <= 200),
  error text CHECK(error IS NULL OR char_length(error) <= 500),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at timestamptz,
  live_from timestamptz,
  live_until timestamptz
);
-- statement-breakpoint
CREATE INDEX marketplace_publications_link ON public.marketplace_publications(link_id, requested_at DESC);
-- statement-breakpoint
CREATE INDEX marketplace_publications_open ON public.marketplace_publications(status) WHERE status IN('pending','sent');
-- statement-breakpoint
CREATE INDEX marketplace_publications_user ON public.marketplace_publications(user_id);
-- statement-breakpoint

-- The numbers a marketplace reports for a product, one row a day (Moscow days): impressions, card opens, carts and orders. A number
-- the marketplace does not report stays NULL (WB's funnel has no impressions). Gone with the connection; older than 400 days pruned.
CREATE TABLE public.marketplace_metrics (
  connection_id text COLLATE "C" NOT NULL REFERENCES public.marketplace_connections(id) ON DELETE CASCADE,
  product_id text COLLATE "C" NOT NULL CHECK(char_length(product_id) BETWEEN 1 AND 64),
  day date NOT NULL,
  views integer CHECK(views IS NULL OR views >= 0),
  clicks integer CHECK(clicks IS NULL OR clicks >= 0),
  carts integer CHECK(carts IS NULL OR carts >= 0),
  orders integer CHECK(orders IS NULL OR orders >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(connection_id, product_id, day)
);
-- statement-breakpoint
CREATE INDEX marketplace_metrics_day ON public.marketplace_metrics(day);
