# Phase 2 — Core Orbit: summary

## Acceptance criteria

| Criterion | Result | Proof |
|---|---|---|
| A customer can ask a question, get a correct answer from the knowledge base and book a real free slot via web chat | ✅ | `apps/api/test/aria.e2e-spec.ts` (answer from FAQ; offers 3 real slots; books the chosen one; slot disappears for the next customer), `apps/web/e2e/customer.spec.ts` |
| Double booking is impossible under concurrent requests | ✅ | Per-business lock + slot re-check + database exclusion constraint. `nudge-bookings.e2e-spec.ts` (3 customers race through the public API: one 201, two 409), `bookings.e2e-spec.ts` (8 concurrent inserts at the database) |
| Reminders and follow-ups send at the right local time and stop when the customer books | ✅ | 24 h / 2 h reminders in the business timezone, moved out of quiet hours without passing the appointment; follow-ups cancelled on booking; reschedule moves reminders; cancel removes them |
| Owner can take over a conversation and hand it back | ✅ | Inbox API + UI. While taken over, Aria stays silent; on hand-back Aria answers the waiting message. The customer sees the team's reply live |
| Daily briefing generates correctly for seeded data | ✅ | 08:00 morning / 19:00 evening in each business's timezone, once per day, posted to the Feed and notifications |

## What was built

- **Bookings engine**
  - The slot engine (`packages/shared/src/availability.ts`) handles opening hours with breaks, staff hours, leave, holidays, buffers, lead time, existing bookings and Google Calendar busy times. It works in each business's timezone, including daylight-saving changes.
  - Create, reschedule, cancel, complete and no-show.
  - Public booking flow: service → person → time → name and phone → confirmed, with an add-to-calendar file.
  - A manage-booking link lets customers move or cancel their booking within the business's cancellation policy.
- **Knowledge base:** add, edit and remove FAQs and notes, with search. The "What Orbit knows" editor is under Details.
- **AI layer**
  - **Single wrapper:** one service wraps all model calls. It uses Claude (Opus 5.5 at low effort for fast chat, with prompt caching and server-side fallbacks) or an offline demo brain for development and tests.
  - **Limited tools:** each agent can only use its own list of tools, and every tool runs inside the business's own data context.
  - **Guardrails:**
    - Any price that isn't in the business's own data is blocked.
    - A request for a person hands over instantly, without calling the AI.
    - Customer content is treated as data, never as instructions.
    - If the AI is unavailable, the customer gets a polite message and the owner is notified.
  - **Cost tracking:** tokens and cost are recorded per business and per agent.
- **Aria (front desk)**
  - Website chat widget and public chat link, replying in the customer's language.
  - Answers from the knowledge base and service list, books, reschedules and cancels.
  - Captures leads and hands over to a person (Needs You card plus notification).
- **Unified inbox:** website chat, chat link and Gmail in one list. Each conversation shows a customer card with history across channels, plus take over and hand back to Aria. A staff reply on an email conversation goes out by email.
- **Nudge**
  - Every message goes through an outbox (`scheduled_messages`) and a delayed job. When the job fires, Nudge re-checks the booking or lead, consent, opt-outs, quiet hours and the weekly contact cap before sending.
  - Lead follow-ups now exist in every business-type template.
- **Orbit task system:** a task records each piece of Crew work, with a live activity sentence that drives the ticker and the agent pings. Owner commands are recorded as Orbit tasks.
- **Daily briefing:** morning and evening, generated from live data.
- **Powers: Google Calendar and Gmail**
  - Connect and disconnect with Google sign-in, requesting only the permissions needed.
  - Tokens are encrypted (AES-256-GCM) and refreshed automatically. An expired grant pauses the Power and asks the owner to reconnect.
  - Google Calendar busy times block slots, and bookings create, update and delete calendar events.
  - Gmail enquiries become conversations that Aria answers in the same email thread.
- **Live updates:** a WebSocket endpoint at `/ws`, with owners limited to their own business and customers to their own chat. Redis pub/sub spreads updates across API instances. Jobs run on BullMQ.
- **The Bridge redesign (spec section 5)**
  - **Visual design:** the approved colours, Plus Jakarta Sans (served by us, not loaded from Google), and agent colours with initials everywhere.
  - **Orbit hero:** agents circle on their own rings and pulse when they are really working. A floating Pulse dial sits in the centre. A live ticker cycles every 2.6 seconds, with typing dots only while work is in progress.
  - **Stat tiles and Needs You:** three stat tiles. Needs You shows one decision at a time with the next card peeking behind; cards can be swiped right to act or left for later, and pop in after a decision. When nothing is waiting, a success panel draws a tick.
  - **Earnings and feed:** Orbit Earnings with growing bars, and the Crew feed with grouping and new rows sliding in.
  - **Command bar:** cycling hints and hold-to-speak.
  - **Motion:** entrance animations play once per session, with numbers counting up. Motion respects the reduced-motion setting and pauses in the background.
  - **Desktop:** three columns, with the stat tiles inside the hero.
  - **States:** loading skeletons, an empty state with a share button, and a friendly error with retry.
- **Seed data:** "Glow Studio" (owner Meera) and "IronCore Gym", now with channels on feed events and live Crew activity.

## Tests

- 20 shared unit tests (slot engine, daylight saving, quiet hours, translations).
- 66 API tests: isolation, Aria, bookings, Nudge, briefings, WebSockets, Powers, sign-in and admin.
- Browser end-to-end tests: onboarding, The Bridge (phone and desktop), live updates, customer chat, booking, manage link and inbox takeover.

## Bugs found and fixed while testing

- **Chat crash on newer Chrome:** the chat crashed whenever it opened from the first render. Newer Chrome returns a promise from `scrollIntoView`, and React treated it as a cleanup function. This would have hit real customers.
- **Messages blocked by the browser:** customer chat messages were rejected because the API's CORS settings didn't allow the visitor token header. Fixed, with a regression test.
- **Signup race:** two owners signing up at the same moment with the same placeholder name could clash on the public link name. Creation and renaming now retry safely.
- **Visit spend failure:** completing a booking failed because of a type cast in the visit-spend update.
- **Stale booking page:** a cached public page could offer services that had just changed, and showed "no free times". The booking flow now loads the current services and shows the real error.
- **Inbox opened from a link:** opening the inbox from a link before the business was chosen showed an empty list. It now waits for sign-in, or sends the person to the login page.
- **Chat message order:** a live reply could appear before the customer's own message. Messages are now kept in time order.

## Decisions you may want to revisit

- **View switcher on phones:** spec 5.2 lists no view switcher on phones, where views are reached by swiping. I also show the same pill switcher below the greeting on phones so Crew, People and Powers can be found. It is easy to remove.
- **Dark mode:** the spec gives light colours only. A matching dark palette follows the system setting (the original spec asked for dark mode).
- **Contact cap:** booking reminders are transactional, so they don't count towards the weekly marketing contact cap. Follow-ups, win-backs and greetings do count.
- **Model:** Aria uses Claude Opus 5.5 at low effort for speed, with server-side fallbacks if a request is declined. Model and effort are environment settings.

## What's left / known issues

- **Command Bar:** commands are recorded but not yet understood or planned. That arrives in Phase 5 (Ask Orbit / Command Orbit).
- **WhatsApp, Instagram and SMS:** these arrive in Phase 3. Until then, reminders reach customers by website chat or Gmail only. Otherwise they are skipped with the reason recorded, never faked.
- **Google Powers:** these need a Google Cloud OAuth client (and Gmail API verification for production) before they can be used. In this environment they are tested against a mocked Google API only.
- **Briefings on WhatsApp:** briefings are shown in the app. Sending them to the owner on WhatsApp needs the Phase 3 WhatsApp Power.
- **Knowledge search:** it uses PostgreSQL full-text search. Semantic search with vector embeddings (pgvector) needs an embedding provider to be chosen.
- **Bundle size:** the three translation files add about 35 kB to the first load. Loading only the chosen language is a planned improvement.
- **Owner availability settings:** staff working hours, leave and holidays are supported by the engine, but there are no owner screens for them yet (classic Details).
