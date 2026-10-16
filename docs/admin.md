# Operator console

`#admin` in the app (`src/admin/`) is the operator's view of Morfa: who has an account and what people do. It reads `GET /api/admin/*` (`server/admin/`); both sides share the contract in `shared/admin-analytics.ts`. Visual rules are in
`docs/admin-design.md`.

| Screen | What it answers |
|---|---|
| Overview | Accounts, new and active ones; the funnel (signed up → made a file → came back), engagement (DAU / WAU / MAU), weekly cohorts, the weekday × hour heatmap, alerts |
| Accounts | Every account with its status (active, closing) and activity; one account's page: files, teams, collaboration, sessions, recent actions |
| Support | The support inbox: conversations waiting for an answer, replies, closing |
| Usage | Files, versions, comments; feature adoption; storage; top actions |

Accounts at a reserved `.invalid` address (RFC 6761: the drain drill's, the bench's) are not people: no count or list has them and their page is a 404 (`server/admin/analytics/people.ts`); storage stays whole.

## Who is an operator

`MORFA_OPERATORS` lists them, comma-separated: account ids, or account addresses. An account's address is the name it signs in with, in
lower case, at `name.invalid` (`docs/authentication.md`): `MORFA_OPERATORS=owner@name.invalid` makes whoever types the name `owner` an
operator, so keep the deployment behind your own authentication. Everyone else gets the API's plain 404,
and `/api/config` has no `admin` key for them.


## Run it locally with demo data

With the PostgreSQL test cluster up (docs/dev.md):

```sh
MORFA_TEST_ENV_FILE=$STATE/cluster.env scripts/admin/demo-up.sh   # or load cluster.env first; extra options go to the seeder
```

It creates a database in the cluster (or reuses the one it made before), migrates it, seeds it, and prints the commands that start the
API on 3400 (`MORFA_OPERATORS=owner@name.invalid`, the database's env file) and Vite on 5400. Open
`http://127.0.0.1:5400/`, sign in with the name `owner`, then `http://127.0.0.1:5400/#admin`. The connection settings
live in `~/.cache/morfa-demo/demo.env` (`MORFA_DEMO_STATE` moves it; mode 0600, never printed); the database lives until the cluster goes down.

Any other local database (migrated with `npm run db:migrate`) takes the seeder directly, with its migration role:

```sh
npm run admin:seed-demo -- --database-url <migration url> [--accounts 600] [--days 200] [--seed 42] [--now <ISO>] [--operator owner@localhost] [--reset] --yes
```

Without `--database-url` it reads `MORFA_MIGRATION_DATABASE_URL`. The history ends now (or at `--now`) and is the same for the same seed
and instant: signups growing over the window with a launch-day spike, ~45 % one-visit tourists, week-1 retention near 40 % falling to
~15 % by week 8; closing and erased accounts; files, versions, pictures, teams, sharing, comments, libraries and meetings; ~200 000 journal rows. It ends with a summary read back from the database. 600 accounts take about 15 s.

## What the seeder refuses

- `NODE_ENV=production`, ambient `PG*` variables, and any host but a loopback one (127.0.0.1, localhost, ::1).
- A database holding any account that is not a development (`…@localhost`) or demo (`…@demo.example`) one. Demo addresses use the
  reserved `.example` domain, so none can reach a person.
- A database it seeded before, unless `--reset`: that removes exactly the rows the earlier run recorded (its marker in `launch_audit`)
  and seeds again. Development accounts, the operator's among them, stay.
- Running without `--yes`. Everything is written in one transaction.

## Caveats

- The activity journal (`server/admin/telemetry.ts`) records each action at most once a minute per account and keeps 400 days (the
  worker's maintenance pass deletes older rows), so the running app goes on recording activity in a demo database.
- Do not run the worker on it: its maintenance pass would erase the closing accounts.
- Pictures and thumbnails have rows but no files in `DATA_DIR`.
