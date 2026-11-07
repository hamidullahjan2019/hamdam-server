# Hamdam server — deploy guide (Supabase + Render)

The server is zero-dependency Node.js. With `SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE_KEY` set it stores everything in Supabase Postgres;
without them it falls back to the local JSON file (`data/db.json`), exactly
like the original dev server. The API is unchanged — the existing front-end
works with either store.

## 1. Supabase project

1. Create a project at https://supabase.com/dashboard (free tier, no card).
2. SQL Editor → New query → paste the whole `supabase-schema.sql` → Run.
3. Project Settings → API: copy the **Project URL** (`SUPABASE_URL`),
   the **anon public** key (`SUPABASE_ANON_KEY`) and the **service_role
   secret** key (`SUPABASE_SERVICE_ROLE_KEY`).
   The service_role key bypasses all security rules — it lives ONLY on the
   server, never in the front-end or a public repo.

## 2. Real OTP e-mails (required for real users)

Supabase's built-in e-mail only delivers to project team members (2/hour).
For real users, in the Supabase dashboard go to Authentication → SMTP
Settings and enable custom SMTP — e.g. Gmail:
`SMTP Host: smtp.gmail.com, Port: 587, User: your Gmail address,
Password: a Gmail app password` (Google Account → Security → 2-Step
Verification → App passwords). Without this, users never receive their code.

## 3. Deploy on Render

1. Push this folder to a git repo (GitHub/GitLab).
2. Render dashboard → New → Blueprint → select the repo.
   (Or New → Web Service → Node, build `npm install`, start `node server.js`.)
3. Set the environment variables (Render → Environment):
   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
   `ADMIN_KEY` (long random string), `ALLOW_ORIGIN` (the Netlify site URL),
   `PUBLIC_URL` (the Render URL, e.g. `https://hamdam-server.onrender.com`),
   `DEV_OTP=0`, `DEV_GOLD=0`.
4. Deploy. Check `https://<your-service>.onrender.com/api/health` — it
   should return `{"ok":true,"store":"supabase",...}`.
   Note: Render's free tier sleeps after 15 minutes without traffic; the
   first request after that takes up to ~60 seconds to wake up.

## 4. Connect the front-end

The front-end switches to the server with this snippet, added to
`index.html` **before** the app's main script:

```html
<script>window.HAMDAM_CONFIG = { mode: 'remote', baseUrl: 'https://<your-service>.onrender.com' };</script>
```

Then redeploy the front-end (Netlify). Two alternatives:

- **Serve the front-end from this server instead:** just open the Render
  URL — `server.js` already serves `index.html` and injects
  `mode:'remote'` with an empty `baseUrl` (same origin), so no edit is
  needed. The Netlify site can then stay as the demo or be retired.
- **Keep Netlify:** use the snippet above with the Render URL as `baseUrl`,
  and make sure `ALLOW_ORIGIN` on Render matches the Netlify origin.

## 5. Local testing

```sh
cp .env.example .env        # fill in values, or leave Supabase empty for JSON mode
node server.js              # http://localhost:8787
```

JSON mode (no Supabase vars): `DEV_OTP=1` makes `/auth/start` return the
code in the response so you can test login without e-mail. Never set
`DEV_OTP=1` in production — codes must never be returned or logged.

## Known limits (by design, for a later step)

- **Media uploads** (photos, voice messages) are saved on the server's
  local disk and served from `/media/`. On Render free the disk is
  ephemeral: uploads disappear on restart/redeploy. The proper fix is
  Supabase Storage; the API shape (`POST /api/media` returns a URL) already
  allows swapping the backend without touching the front-end.
- **One instance only.** The server keeps its working set in memory and
  syncs it to Postgres; running two instances would diverge. Render free
  runs a single instance, so this is fine.
- **Gold checkout** still returns `billing_not_configured` unless
  `DEV_GOLD=1` (trial only). Connect a real payment provider before
  charging users.
