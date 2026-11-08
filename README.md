# Orbit — AI operating system for small businesses

Orbit gives every small business an online presence and a team of AI agents (the **Crew**: Aria, Vox, Nudge, Ledger, Spark, managed by **Orbit**) that run the front office. The owner works from **The Bridge**, a phone-first home screen that feels like talking to a trusted manager.

**Status: Phase 2 (Core Orbit) complete.** See [docs/PHASE2.md](docs/PHASE2.md) (and [docs/PHASE1.md](docs/PHASE1.md)) for what was built, what's left and known issues.

## Repository layout

```
apps/api          NestJS REST API (TypeScript)
  migrations/     SQL migrations, incl. Row-Level Security policies
  src/            auth, tenant guard, onboarding, bridge, admin, public pages
  test/           integration tests (isolation, onboarding, bridge, auth/admin, double booking)
apps/web          Next.js PWA (mobile-first): login, onboarding, The Bridge, public pages, admin
  e2e/            Playwright end-to-end tests on a throttled phone profile
packages/shared   Types, plans, business-type templates, Pulse logic, i18n (en, hi, kn)
infra/db          PostgreSQL roles and database setup
```

## Setup

Requirements: Node 20+, PostgreSQL 16 with `pgvector`, Redis (live updates and background jobs).

```bash
npm install
```

Start PostgreSQL and Redis with Docker (roles and databases are created automatically):

```bash
docker compose up -d
```

Or, with a local PostgreSQL, create the roles and databases yourself:

```bash
PGSUPER="psql -U postgres -h localhost" npm run db:setup
```

Then:

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
npm run build:shared
npm run db:migrate
npm run db:seed
npm run dev:api
npm run dev:web
```

Open http://localhost:3000. In development the sign-in code is shown on screen (`OTP_DEV_ECHO=true`).

| Seeded account | Phone |
|---|---|
| Glow Studio owner, Meera (Base plan) | +91 98000 00001 |
| IronCore Gym owner (Business plan) | +91 98000 00002 |
| Platform admin | +91 98000 00000 |

Public pages: http://localhost:3000/glow-studio and http://localhost:3000/ironcore-gym (booking and chat with Aria). The inbox is at http://localhost:3000/inbox.

No Anthropic key yet? Start the API with `AI_PROVIDER=fake` to use the offline demo brain (answers from FAQs, offers real slots).

## Tests

```bash
npm test
npm run test:e2e
```

- `npm test` runs the shared unit tests and the API tests against the separate `orbit_test` database. That database is reset automatically.
- `npm run test:e2e` needs the API on :4000 (seeded) and the web app on :3000. Start the API with `AI_PROVIDER=fake THROTTLE_DISABLED=true`. Each e2e run re-seeds the local sample businesses and clears sign-in code history (`apps/web/e2e/global-setup.ts`), so never point it at a real database.

## Environment variables

**API (`apps/api/.env`)**

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Runtime role `orbit_app`: not table owner, no BYPASSRLS. RLS always applies. |
| `DATABASE_ADMIN_URL` | `orbit_admin` (BYPASSRLS). Admin panel aggregates only. |
| `DATABASE_MIGRATION_URL` | `orbit_migrator`, the schema owner. Used for migrations and seed only. |
| `REDIS_URL` | Queues (Phase 2). |
| `JWT_SECRET` | Token signing. Required in production. |
| `PORT` | API port (default 4000). |
| `WEB_ORIGIN` | Allowed CORS origins (comma-separated). |
| `PUBLIC_BASE_URL` | Base of public business links and the QR code, e.g. `https://orbit.app`. |
| `GOOGLE_CLIENT_ID` | Enables Google sign-in. |
| `SMS_PROVIDER` | `dev` logs OTPs. Production needs a DLT-registered provider adapter. |
| `OTP_DEV_ECHO` | Returns the OTP in the response (ignored in production). |
| `PLATFORM_ADMIN_PHONES` | E.164 numbers that become platform admins. |
| `THROTTLE_DISABLED` | Test/e2e only. |
| `AI_PROVIDER`, `ANTHROPIC_API_KEY`, `AI_MODEL`, `AI_EFFORT` | Aria's model. `claude` (default, Opus 5.5 at low effort) or `fake` (offline demo). |
| `JOBS_MODE`, `JOBS_ENABLED`, `REALTIME_MODE` | Background jobs (BullMQ) and live updates (Redis pub/sub). |
| `POWERS_ENCRYPTION_KEY` | 32-byte base64 key encrypting Power tokens. Required in production. |
| `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `WEB_BASE_URL` | Google Calendar and Gmail Powers (OAuth). |
| `DEV_DELIVER` | Development only: log messages to customers with no connected channel. |

**Web (`apps/web/.env.local`)**

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_API_URL` | API URL as seen by the browser. |
| `API_INTERNAL_URL` | API URL for server-rendered public pages. |
| `NEXT_PUBLIC_GOOGLE_CLIENT_ID` | Shows the Google sign-in button. |

## Architecture overview

### Multi-tenancy: enforced in the database

- Every business-owned table has `business_id NOT NULL`, defaulting to the business set on the transaction.
- Every such table has `ENABLE` + `FORCE ROW LEVEL SECURITY` and a `tenant_isolation` policy on `app_current_business()`. A migration loop applies this to every table with a `business_id` column. A test fails if any table is missed.
- The API connects as `orbit_app`, which cannot bypass RLS and owns no tables.
- `DbService.withTenant(businessId, fn)` sets `app.business_id` with `set_config(..., true)` (transaction-local), so pooled connections never leak context. With no business set, every policy matches nothing (fails closed).
- `TenantGuard` reads `X-Business-Id` and proves active membership before any business route runs.
- Child rows reference parents with **composite foreign keys** `(business_id, parent_id)`, so a row can never point at another business's row, even via a bug.
- Double booking is blocked by a PostgreSQL exclusion constraint per staff member.
- The admin role (`orbit_admin`) is used only by `/admin/*`. Impersonation tokens are locked to one business, expire after 1 hour and are audited.

### Other key decisions

- **Plain language:** API errors are `{ error: { code, message } }` with owner-friendly messages.
- **Translatable sentences:** Feed, Pulse, cards and briefings store `{key, params}` sentences, rendered in the viewer's language. Times (`~t:`) and money (`~m:`) are formatted per language and timezone.
- **Adding a language** means adding a JSON file in `packages/shared/src/locales` and one line in `LANGUAGES`. No other code changes. Locale files are generated by `packages/shared/scripts/build-locales.py`.
- **Plans and templates** are seeded from `packages/shared` but read from the database, so they are editable from the admin panel without code changes.
- **Agents** have least-privilege tool and Power lists (`packages/shared/src/agents.ts`), ready for the Phase 2 AI layer.
- **Logging:** structured JSON with `requestId`, `business_id` and `user_id` on every line.
- **AI layer** (`apps/api/src/ai`): one wrapper for all model calls; each agent gets only its own tools, which run inside the business's RLS context; guardrails block made-up prices and hand over to a person when needed; tokens and cost are logged per business and agent.
- **Live updates:** WebSocket at `/ws` (owners: their business only; customers: their own chat only), fanned out through Redis.
- **Background jobs:** BullMQ. Every job carries `business_id`, runs under it, re-checks state (idempotent) and retries with backoff.
