# Deploy Orbit: Supabase + Render (temporary onrender.com address)

Time needed: about 30–40 minutes. You need:
- this GitHub repository
- a Supabase account (free)
- a Render account (free)

What you get:
- the owner app at `https://orbit-web….onrender.com`
- the API at `https://orbit-api….onrender.com`
- the database and sign-in on Supabase

The free plan is fine for a preview. Its limits:
- **Sleep:** each service sleeps after 15 minutes without visitors, and the first visit after that takes about a minute.
- **Lost reminders:** the free Redis keeps data in memory only, so reminders scheduled while it restarts are lost.

Upgrade both before real businesses use Orbit.

---

## Part A — Supabase (database and sign-in)

### A1. Create the project
1. Go to **supabase.com** and click **Start your project** (sign in with GitHub).
2. Click **New project**.
   - **Name:** `orbit`
   - **Database Password:** click **Generate a password**, then copy it somewhere safe.
   - **Region:** **South Asia (Mumbai)**
3. Click **Create new project** and wait about 2 minutes.

### A2. Create Orbit's database roles (one time)
1. Make three long passwords, using **letters and numbers only**. One way: a password manager's generator with symbols switched off.
   - one for **migrator**
   - one for **app**
   - one for **admin**
2. In GitHub, open `infra/db/supabase-setup.sql` on the `claude/orbit-ai-os-project-vycax0` branch. Click **Raw**, then select all and copy.
3. In Supabase, click **SQL Editor** in the left bar, then **+ New query**, and paste.
4. Replace the three passwords:
   - `CHANGE_ME_MIGRATOR` with your migrator password
   - `CHANGE_ME_APP` with your app password
   - `CHANGE_ME_ADMIN` with your admin password
5. Click **Run**. The last result table should show `orbit_admin | true`.
   - If it shows `false`, or a message says *"Could not grant BYPASSRLS"*, use the `postgres` connection string for `DATABASE_ADMIN_URL` in step A3.

### A3. Make the three connection strings
1. Click **Connect** at the top of the project page.
2. Open the **Connection String** tab and find **Transaction pooler**. Copy it. It looks like:
   `postgresql://postgres.abcdefghijklm:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:6543/postgres`
   - The part after `postgres.` (here `abcdefghijklm`) is your **project ref**.
3. Build these three lines in a note. Change only the user name, password and port. Use the exact pooler host Supabase showed you, because the `aws-0-…` part varies.

| Name | Value |
|---|---|
| `DATABASE_URL` | `postgresql://orbit_app.<ref>:<app password>@<pooler host>:6543/postgres` |
| `DATABASE_ADMIN_URL` | `postgresql://orbit_admin.<ref>:<admin password>@<pooler host>:6543/postgres` |
| `DATABASE_MIGRATION_URL` | `postgresql://orbit_migrator.<ref>:<migrator password>@<pooler host>:5432/postgres` |

- Port **6543** is the transaction pooler, used by the running app. Port **5432** on the same pooler host is the session pooler, used for setting up tables.
- Don't use the "Direct connection" string. It only works over IPv6, which Render may not support.

### A4. Copy the project URL and public key
1. Click **Project Settings** (gear icon), then **API Keys**. Some projects show this under **Data API**.
2. Copy the **Project URL**, for example `https://abcdefghijklm.supabase.co`.
3. Copy the **publishable** key. Older projects call it the **anon public** key. This key is meant to be public.

### A5. Email + password sign-in (with Resend)
Owners log in with their email and a password, or with Google (A6). New owners sign up on the same screen and confirm their email with a link.

**1. Turn on email + password**
1. Go to **Authentication** → **Sign In / Providers** → **Email**.
2. **Enable Email provider:** on.
3. **Confirm email:** on. Keep this on: Orbit only links a sign-in to an existing account (and its businesses) once the email is confirmed.
4. **Minimum password length:** `8`. Click **Save**.

**2. Tell Supabase where your site lives** (otherwise email links open `localhost`)
1. Go to **Authentication** → **URL Configuration**.
2. **Site URL:** your orbit-web address, for example `https://orbit-web-xxxx.onrender.com`.
3. **Redirect URLs** → **Add URL:** the same address followed by `/login`, for example `https://orbit-web-xxxx.onrender.com/login`. Click **Save URLs**.

**3. Send emails through Resend**
Supabase's built-in sender only delivers a few emails an hour, and only to your own team. Resend delivers to everyone.
1. In **resend.com**: go to **Domains** → **Add Domain**, add your domain and create the DNS records it shows, then wait for **Verified**. (Without a domain you can only send to your own Resend login email, from `onboarding@resend.dev`.)
2. In Resend: **API Keys** → **Create API Key** → permission **Sending access** → copy it (starts with `re_`).
3. In Supabase: **Project Settings** → **Authentication** → **SMTP Settings** → **Enable Custom SMTP**:

   | Field | Value |
   |---|---|
   | Sender email | `no-reply@yourdomain.com` (an address on your verified domain) |
   | Sender name | `Orbit` |
   | Host | `smtp.resend.com` |
   | Port | `465` |
   | Username | `resend` |
   | Password | your Resend API key |

4. Click **Save**. Then, under **Authentication** → **Rate Limits**, raise **emails per hour** (for example to `100`).

**4. Email templates**
Keep the default **Confirm signup** and **Reset password** templates: they contain a link (`{{ .ConfirmationURL }}`) that brings the owner back to Orbit. If you changed them earlier to show a code, put the link back.

### A6. (Optional) Google sign-in
1. Go to **console.cloud.google.com**, open **APIs & Services**, then **OAuth consent screen**.
   - Choose **External**, fill in the app name and your email, then click **Save**.
2. Go to **Credentials** → **+ Create credentials** → **OAuth client ID**.
   - **Application type:** **Web application**
   - **Authorized redirect URIs:** `https://<ref>.supabase.co/auth/v1/callback`
3. Click **Create**, then copy the **Client ID** and **Client secret**.
4. In Supabase, go to **Authentication** → **Sign In / Providers** → **Google**.
   - Switch it on, paste the Client ID and secret, and click **Save**.

If you skip this, set `AUTH_GOOGLE=false` on the web service in Part B. That hides the Google button.

---

## Part B — Render (the website and the API)

### B1. Connect GitHub
1. Go to **render.com** and click **Get Started**. Sign up with **GitHub**.
2. When GitHub asks, allow Render to access this repository (choosing **Only select repositories** is fine).

### B2. Create everything from the Blueprint
1. In the Render Dashboard, click **New** → **Blueprint**.
2. Next to this repository, click **Connect**.
3. Fill in the form:
   - **Blueprint Name:** `orbit`
   - **Branch:** `claude/orbit-ai-os-project-vycax0` (the code isn't on `main` yet)
4. Render lists three resources: **orbit-redis**, **orbit-api** and **orbit-web**. It asks for the values marked "sync: false". Enter them below.

**orbit-api** (`<ref>` is your Supabase project ref):

| Key | Value |
|---|---|
| `DATABASE_URL` | from A3 |
| `DATABASE_ADMIN_URL` | from A3 |
| `DATABASE_MIGRATION_URL` | from A3 |
| `SUPABASE_URL` | `https://<ref>.supabase.co` |
| `WEB_ORIGIN` | `https://orbit-web.onrender.com` |
| `PUBLIC_BASE_URL` | `https://orbit-web.onrender.com` |
| `WEB_BASE_URL` | `https://orbit-web.onrender.com` |
| `PLATFORM_ADMIN_EMAILS` | your email address (people here get the admin panel) |

**orbit-web:**

| Key | Value |
|---|---|
| `ORBIT_API_URL` | `https://orbit-api.onrender.com` |
| `API_INTERNAL_URL` | `https://orbit-api.onrender.com` |
| `SUPABASE_URL` | `https://<ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | the publishable key from A4 |

5. Click **Deploy Blueprint**. The first build takes about 5–10 minutes.
   - **orbit-api** creates the tables, adds the two demo businesses and starts.
   - Click a service, then **Logs**, to watch progress.

### B3. Check the real addresses (important)
Render may add letters to a name if it's already taken, for example `orbit-web-x7k2.onrender.com`.

1. Open **orbit-web** and look at its URL under the name. Do the same for **orbit-api**.
2. If either differs from what you typed in B2, fix it:
   - On **orbit-api**: go to **Environment** and update `WEB_ORIGIN`, `PUBLIC_BASE_URL` and `WEB_BASE_URL` to the real web URL. Click **Save, rebuild, and deploy**.
   - On **orbit-web**: go to **Environment** and update `ORBIT_API_URL` and `API_INTERNAL_URL` to the real API URL. Click **Save, rebuild, and deploy**.

### B4. Tell Supabase where the website lives
Now that you know the real orbit-web address, do step **2** of A5 (Site URL and Redirect URLs) if you haven't yet.

### B5. Try it
1. Open your **orbit-web** URL. The first visit after a sleep takes about a minute.
2. Click **Start free**, open the **Sign up** tab, enter your email and choose a password (or use **Continue with Google**).
3. Open the confirmation email and click the link, then log in. Orbit starts the business setup: pick your business type, add your details, and go live.
4. Customer page: open `https://<orbit-web>/<your-business-link>`. You can book there or chat with Aria.
   - Other people's emails need Resend set up (A5, step 3).

---

## WhatsApp, Instagram and Messenger (Meta)
Orbit uses **one Meta app** for all businesses. You set it up once; each business then connects its own number or page from **The Bridge → Powers**.

**1. Create the Meta app**
1. Go to **developers.facebook.com** → **My Apps** → **Create app** → use case **Other** → type **Business**. Name it `Orbit`.
2. In the app, open **App settings → Basic** and copy the **App secret** (click **Show**).
3. Add the products **WhatsApp** and **Messenger** (Messenger also covers Instagram).

**2. Tell orbit-api about it** (Render → orbit-api → Environment)

| Key | Value |
|---|---|
| `META_APP_SECRET` | the App secret from step 1.2 |
| `META_VERIFY_TOKEN` | any long random text you make up (letters and numbers), e.g. `orbitverify8Kq2mZ` |

Save; it redeploys.

**3. Point Meta's webhooks at Orbit**
1. In the Meta app: **WhatsApp → Configuration → Webhook → Edit**:
   - **Callback URL:** `https://<your orbit-api address>/webhooks/meta`
   - **Verify token:** the same `META_VERIFY_TOKEN`
   - Click **Verify and save**, then under **Webhook fields** subscribe to **messages**.
2. **Messenger → Settings → Webhooks** (and **Instagram settings → Webhooks**): same Callback URL and Verify token; subscribe to **messages**.

**4. Go live**
While the app is in **Development** mode only people with a role on the app can message it. For real customers: **App settings → Basic** (privacy policy URL, icon), then **App Review** for `whatsapp_business_messaging`, `pages_messaging` and `instagram_manage_messages`, then switch the app to **Live**.

**5. Each business connects**
In Orbit: **The Bridge → Powers → WhatsApp / Instagram / Messenger → Connect**. The form explains where to find each ID and token. WhatsApp can also take an approved **message template** (body `{{1}}`) so Orbit can send reminders to customers who last wrote more than 24 hours ago.

## Outlook email (Microsoft)
One Microsoft app for all businesses; each owner then clicks **Powers → Outlook → Connect** and signs in.
1. Go to **portal.azure.com** → **Microsoft Entra ID** → **App registrations** → **New registration**.
   - **Name:** `Orbit`
   - **Supported account types:** *Accounts in any organizational directory and personal Microsoft accounts*
   - **Redirect URI:** platform **Web**, `https://<your orbit-api address>/powers/oauth/microsoft/callback`
2. Copy the **Application (client) ID**.
3. **Certificates & secrets** → **New client secret** → copy its **Value**.
4. **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated**: `offline_access`, `User.Read`, `Mail.ReadWrite`, `Mail.Send`.
5. Render → orbit-api → Environment: `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_REDIRECT_URI` (the redirect URI from step 1).

## Zoho Books (accounting sync)
One Zoho app for all businesses; each owner clicks **Powers → Zoho Books → Connect**.
1. Go to **api-console.zoho.in** → **Add Client** → **Server-based Applications**.
   - **Client name:** `Orbit` · **Homepage URL:** your orbit-web address
   - **Authorized redirect URI:** `https://<your orbit-api address>/powers/oauth/zoho/callback`
2. Copy the **Client ID** and **Client Secret**. Under **Settings**, turn on **Multi-DC** so owners on other Zoho data centres can connect too.
3. Render → orbit-api → Environment: `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REDIRECT_URI` (the URI from step 1).

Each issued invoice is copied to Zoho with the same number and GST (Zoho's CGST+SGST group or IGST tax for the rate), each payment is recorded against it, and cancelled invoices are voided there.

## SMS (India, DLT)
Each business connects its own MSG91 account from **Powers → SMS** (the form explains DLT registration). Nothing to set on the server. SMS is one-way (reminders and updates); replies come in on WhatsApp.

## Phone calls with Vox (Exotel + Sarvam)
Vox answers your business number, talks in English, Hindi or Kannada, books appointments and passes callers to your team when needed. Vox is on the **Business** plan.

**Once for the server (Orbit's speech key):**
1. Create an account at **dashboard.sarvam.ai** and make an **API key**.
2. Render → **orbit-api** → **Environment** → add `SARVAM_API_KEY` = that key → **Save** (the API restarts).
   Optional: `SARVAM_TTS_SPEAKER` to pick a different voice.

**Each business (in Orbit → Powers → Business phone number → Connect):**
1. Create an **Exotel** account and buy an **ExoPhone** (the number customers call).
2. Exotel → **API settings**: copy the **Account SID**, **API key** and **API token**.
3. Exotel → **App Bazaar** → create a flow: **Voicebot** applet first, then a **Connect** applet to your team's phone. Attach the flow to the ExoPhone.
4. In Orbit, fill in the details and press **Connect**. Orbit shows a **Voicebot URL** (`wss://…/voice/exotel/…`): paste it into the Voicebot applet and save the flow.
5. Optional: add the flow's **app ID** (the number in its App Bazaar address) so Vox can also make calls (e.g. **Call me** to test).

Try it without a phone line: **Powers → Business phone number → Vox settings and test call → Start test call** talks to Vox in the browser (needs only `SARVAM_API_KEY`).
If Vox cannot take a call (switched off, minutes used up), the stream ends straight away and Exotel moves on to the **Connect** applet, so callers always reach someone.
Note: Render's free plan sleeps after 15 minutes without traffic; the first call after a sleep can fail. Use a paid instance for a real phone line.

### Or: a voice agent built on Sarvam's platform
If Vox runs on Sarvam's own Voice Agents platform (number rented from Sarvam, or your Exotel number connected there), connect it to Orbit so its bookings are real:
1. Orbit → **Powers → Business phone number → Vox settings and test call → Use a Sarvam voice agent → Create key**. Copy the key (shown once).
2. In Sarvam, save the key as a secret. For each tool listed in Orbit: **Tools → Add API tool**, paste the name, description and cURL, set **Auth → Bearer token** to the key, set **When should this tool run?** as shown, and in the body pick `@Interaction ID` and `@User Identifier` (and `@Call Transcript`, `@Call Length` for `call_ended`).
3. Paste Orbit's extra instructions at the end of the agent's prompt.
Bookings then appear in the calendar (with WhatsApp confirmations), messages as notifications, and each call in the inbox and the Crew feed. Endpoints: `POST /integrations/sarvam/{info,availability,book,my-bookings,reschedule,cancel,message,call-ended}`.

## Plans, AI tiers and limits
- Plans (Free, Plus ₹999, Pro ₹2,999, Business ₹7,999, Enterprise custom) live in the database. Edit prices, allowances, AI tier, Crew and Powers in **Admin → Plans**; an edited plan is never overwritten by a deploy.
- **Admin → AI & margins**: which provider and model serve each tier (free / standard / premium) and task (customer conversations, Command Orbit, simple text), with fallbacks. Everything runs on Groq until an `ANTHROPIC_API_KEY` is added and the premium tier is pointed at Claude there. Businesses only ever see "Orbit".
- Free: a daily allowance (default 20 conversations, resets at midnight in the business's timezone). Paid: a monthly allowance plus a daily cap of 3× the daily share. Chats already under way get up to 10 more replies; new ones get one polite note and wait in the inbox, the owner is told, and Orbit offers to reply when the allowance is back.
- Margins: revenue comes from Razorpay subscription charges; AI budget = net revenue × the set % (default 25%).

## Admin control centre
- Open **/admin** after signing in. The first time, scan the QR code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…) and enter the 6-digit code; after that, enter a code each time you open the admin centre (sessions last 8 hours, this browser tab only).
- People in `PLATFORM_ADMIN_EMAILS` start as **Owner**. Add the rest of the team in **Admin → Team** (they must have signed up first) as Owner, Finance, Support or Viewer.
- Lost your phone? Another Owner can **Reset 2FA** in Team. If you are the only Owner, run in Supabase SQL: `UPDATE admin_users SET totp_secret = NULL, totp_enabled_at = NULL WHERE user_id = (SELECT id FROM users WHERE email = 'you@example.com');`
- Email to business owners and admin alerts: set `EMAIL_API_KEY` (a Resend API key) and `EMAIL_FROM` (e.g. `Orbit <hello@yourdomain>`, on a domain verified in Resend), plus `API_PUBLIC_URL` (e.g. `https://orbit-api-xxxx.onrender.com`) for open/click tracking. Without them, messages still appear in the app.
- WhatsApp and push messages to owners arrive with the Orbit Assistant number (later phase); until then those channels show as "not available".
- Failed plan payments keep the plan for `billing.grace_days` (default 7) with reminders, then move the business to Free. Data is never deleted.
- The audit log is append-only at the database level.

## Optional settings (orbit-api → Environment)

| What | Setting |
|---|---|
| Real AI for Aria (Claude) | `AI_PROVIDER=claude` and `ANTHROPIC_API_KEY=<your key>` |
| Real AI for Aria (Groq) | `AI_PROVIDER=groq` and `GROQ_API_KEY=<your key>`; optional `GROQ_MODEL` (default `llama-3.3-70b-versatile`) |
| No AI key yet | `AI_PROVIDER=fake`: the offline demo brain answers from FAQs and offers real slots |
| Demo businesses (testing only) | `SEED_DEMO=true` adds Glow Studio and IronCore Gym with made-up owners. Leave it `false` on a real site. |
| Google Calendar / Gmail Powers | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI=https://<orbit-api>/powers/oauth/callback` |

## If something goes wrong

| What you see (in **Logs**) | Fix |
|---|---|
| `password authentication failed` | The password in that connection string doesn't match the one you set in A2. |
| `Tenant or user not found` | The user name must be `role.<ref>`, for example `orbit_app.abcdefghijklm`. |
| `permission denied for schema public` | Step A2 wasn't run, or not as `postgres`. Run it again. |
| The website loads, but sign-in says "Please sign in again" | `SUPABASE_URL` differs between orbit-api and orbit-web, or the A4 key is wrong. |
| The browser console shows a CORS error | `WEB_ORIGIN` on orbit-api must exactly match the web URL (no trailing `/`). |
