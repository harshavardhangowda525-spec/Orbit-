# Phase 1 — Foundation: summary

## Acceptance criteria

| Criterion | Result |
|---|---|
| New owner completes onboarding on a phone in under 2 minutes | ✅ The automated e2e run on a Pixel 5 profile (4× CPU slowdown, 4G) finished in ~5 s. A real person still needs to time a hand-run test. |
| Two seeded businesses cannot access each other's data through any API route, job or query | ✅ 13 isolation tests run at the database level (app role, every table) and through every tenant API route, including impersonation tokens. There are no background jobs yet. |
| The Bridge renders with seeded data on a mid-range phone in under 2 s | ✅ ~600 ms cold load in the throttled e2e test. |

## What was built

- **Sign-in:** phone OTP and Google.
  - OTP codes are hashed, expire after 5 minutes, allow 5 tries, and each number can request 5 per hour. Each IP is rate limited.
  - Google sign-in is verified with Google's own token check.
- **Multi-tenancy:** shared database with RLS on all 34 business tables, three database roles, composite foreign keys, and automated isolation tests.
- **Full data model** from spec section 13, with migrations and a migration runner.
- **Onboarding**, every step with autosave, resume, a progress bar and a back button:
  - type (13 business-type templates)
  - quick import from a website (JSON-LD and meta tags, protected against requests to private addresses), an Instagram handle or a Maps link
  - name, services, hours with breaks, and staff (one question per screen)
  - calendar
  - live screen with the public link, QR code (print), website widget code, WhatsApp share, "Test your Orbit", and the checklist of optional upgrades
- **The Bridge:**
  - Pulse: score, one plain sentence, three numbers, and a colour and animation that change with business health
  - morning/evening briefing
  - swipeable Needs You cards: one-tap decisions, and expiry falls back to the safe default ("don't send")
  - Orbit Feed with grouping and expand
  - Orbit Earnings by agent
  - Command Bar with time-of-day suggestions and hold-to-speak (browser speech)
  - pull to refresh
  - swipe views: Crew, People, Powers, Details (bookings and conversations); Tomorrow and Rewind are placeholders
- **Public business page:** server-rendered, with structured business data for search engines, open/closed status, services, hours, reviews, map, and call/WhatsApp buttons. The chat entry point and `widget.js` are included.
- **Admin panel:**
  - business list with usage and health
  - change status (suspend) and plan
  - impersonation (audited, 1 hour, one business)
  - plan editor and template editor (versioned)
  - health and audit log
- **Languages:** English, Hindi and Kannada (360 keys), checked for completeness by a test.
- **PWA:** manifest, icons, service worker for static assets, light/dark following the system.

## Tests

| Suite | Tests |
|---|---|
| Shared unit tests (`node:test`): Pulse, phone numbers, URL names, timezones, templates, plans, agent tool lists, translations | 14 |
| API (Jest + Supertest): isolation, onboarding, Bridge, sign-in, admin, concurrent double booking, quick import, Feed grouping | 40 |
| End-to-end (Playwright): timed onboarding on a phone, resume, Bridge speed, Kannada/Hindi switching, Crew view | 3 |

## What's left for later phases

- **Phase 2:**
  - Aria and the AI layer
  - Command Bar understanding and planning (Phase 1 records commands as Orbit tasks only)
  - knowledge base editing and retrieval
  - booking flow, chat
  - BullMQ jobs: reminders, card expiry (now applied when The Bridge loads), briefings sent on WhatsApp
  - WebSockets (The Bridge polls every 30 s for now)
  - Google Calendar OAuth (the calendar step records a "setting up" Power)
- **Production pieces not yet built:**
  - a real SMS provider (DLT-registered)
  - encryption of Power tokens (the column exists; there is no key management yet)
  - home-screen widget
  - full Google Maps import (needs a Places API key)
- **Later phases:** Crew switches and auto-approval rules, Powers connect flows, Tomorrow/Rewind, billing.

## Known issues

- Template content (service names, FAQs, sequences) is English only. The data structure supports per-language overrides.
- All three locale files are bundled (~20 kB compressed). Loading only the chosen language would make the first load smaller.
- An owner can create at most 5 businesses. There is no in-app business switcher yet.
- Admin impersonation keeps the admin token in `sessionStorage` to allow "Stop viewing". Opening a new tab loses it, and the admin must sign in again.
- The OTP rate limit is per process (in memory). It should move to Redis before running more than one API instance.
