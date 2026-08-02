# Geetmala Backend — Build Instructions (for the AI coding agent)

You are building a small backend for an existing client-side music player
("Geetmala" — HTML/CSS/vanilla JS, no framework, no build step). It currently
runs entirely in the browser and streams songs from Archive.org URLs listed
in `data/songs.csv`. Your job: add **favorites, last-played, and most-played**
tracking, backed by a Turso (libSQL) database, without breaking the app if
the backend is ever unreachable.

Read this whole file before writing code. Work top to bottom: DB → Worker
API → frontend wiring → UI. Don't skip the "degrade gracefully" requirement
in section 4 — the app must keep working offline exactly as it did before.

---

## 0. Architecture

```
Browser (geetmala/index.html, app.js)
   │  fetch() with a device_id + a static API key header
   ▼
Cloudflare Worker  (new project: geetmala-backend)
   │  @libsql/client/web
   ▼
Turso database:  libsql://geetmala-qijubevadi.aws-ap-south-1.turso.io
```

No user accounts. Each browser gets a random UUID (`device_id`) stored in
`localStorage`, generated once, sent with every API call. That's the only
identity concept — simple by design, matches the existing password-gate's
"soft protection, not a real auth system" posture.

---

## 1. Turso database — set up (do this first, manually)

The agent **cannot** run `turso auth login` (it's an interactive browser
login) — ask the user to run these themselves and hand you the token:

```bash
# user runs these, not the agent:
turso auth login
turso db tokens create geetmala-qijubevadi
```

That prints an auth token. It goes into a Cloudflare Worker **secret**
(never into a committed file — see section 3.4).

### 1.1 Schema

Run this against the existing DB (`turso db shell geetmala-qijubevadi < schema.sql`,
or paste into the Turso web console's SQL editor):

```sql
-- one row per browser/device, no login required
CREATE TABLE IF NOT EXISTS devices (
  device_id     TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

-- liked songs
CREATE TABLE IF NOT EXISTS favorites (
  device_id     TEXT NOT NULL,
  track_id      TEXT NOT NULL,
  favorited_at  INTEGER NOT NULL,
  PRIMARY KEY (device_id, track_id)
);

-- the source of truth: one row per play attempt
CREATE TABLE IF NOT EXISTS play_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id      TEXT NOT NULL,
  track_id       TEXT NOT NULL,
  played_at      INTEGER NOT NULL,   -- unix ms when playback started
  played_seconds REAL NOT NULL,      -- how long they actually listened
  completed      INTEGER NOT NULL DEFAULT 0,  -- 1 if it played to the end
  source         TEXT                -- 'click' | 'auto-next' | 'shuffle' | 'resume'
);
CREATE INDEX IF NOT EXISTS idx_play_events_device ON play_events(device_id, played_at DESC);
CREATE INDEX IF NOT EXISTS idx_play_events_track  ON play_events(track_id);

-- fast aggregate counters, updated whenever a play_event is inserted
CREATE TABLE IF NOT EXISTS track_stats (
  track_id              TEXT PRIMARY KEY,
  play_count            INTEGER NOT NULL DEFAULT 0,
  skip_count            INTEGER NOT NULL DEFAULT 0,
  total_seconds_listened REAL NOT NULL DEFAULT 0,
  last_played_at        INTEGER
);

-- one row per device: last track/position + synced preferences
CREATE TABLE IF NOT EXISTS device_state (
  device_id         TEXT PRIMARY KEY,
  last_track_id     TEXT,
  last_position_sec REAL,
  shuffle_enabled   INTEGER DEFAULT 0,
  repeat_mode       TEXT DEFAULT 'off',
  volume            REAL DEFAULT 0.8,
  playback_speed    REAL DEFAULT 1.0,
  updated_at        INTEGER
);
```

A play counts as "played" (increments `play_count`) once `played_seconds >= 5`.
Anything shorter than that is noise (accidental clicks) — still log the row
in `play_events` for completeness, but don't count it toward stats. A play
counts as "skipped" (increments `skip_count`) if the device moved to another
track (next/prev/click) before `completed = 1` and before finishing.

---

## 2. New project: `geetmala-backend` (Cloudflare Worker)

```bash
mkdir geetmala-backend && cd geetmala-backend
npm init -y
npm install @libsql/client
npm install -D wrangler
```

### 2.1 `wrangler.toml`

```toml
name = "geetmala-backend"
main = "src/index.js"
compatibility_date = "2024-11-01"

[vars]
TURSO_DATABASE_URL = "libsql://geetmala-qijubevadi.aws-ap-south-1.turso.io"
# CORS: restrict to the actual deployed frontend origin once known
ALLOWED_ORIGIN = "*"
```

`TURSO_DATABASE_URL` is not sensitive (it's just a hostname), so it's fine
as a plain var. `TURSO_AUTH_TOKEN` and `API_KEY` (section 2.4) **are**
sensitive — set those as secrets, never in this file:

```bash
wrangler secret put TURSO_AUTH_TOKEN
wrangler secret put API_KEY        # any random string you generate yourself
```

### 2.2 `src/db.js`

```js
import { createClient } from '@libsql/client/web';

export function getDb(env) {
  return createClient({
    url: env.TURSO_DATABASE_URL,
    authToken: env.TURSO_AUTH_TOKEN,
  });
}
```

### 2.3 API surface

All endpoints require header `X-Geetmala-Key: <API_KEY>` (the same static
key baked into the frontend — this isn't real auth, it's the same
"soft gate" tier as the existing password, just stopping randoms who find
the Worker URL from writing junk into the DB). Reject with `401` if missing
or wrong.

| Method | Path                  | Body / Query                                              | Does |
|--------|-----------------------|-------------------------------------------------------------|------|
| GET    | `/api/state`          | `?device_id=`                                               | Returns `{ favorites: [track_id...], last: {track_id, position_sec}, top: [{track_id, play_count}...20], recent: [{track_id, played_at}...20], preferences: {...} }` — everything the app needs on boot, one call |
| POST   | `/api/favorite`       | `{device_id, track_id, favorite: true\|false}`               | Upsert/delete a row in `favorites` |
| POST   | `/api/play-event`     | `{device_id, track_id, played_seconds, completed, source}`  | Insert into `play_events`, then upsert `track_stats`, then upsert `device_state.last_track_id/last_position_sec` |
| POST   | `/api/state-sync`     | `{device_id, last_track_id, last_position_sec, shuffle_enabled, repeat_mode, volume, playback_speed}` | Upsert `device_state` (called on the existing 3s autosave tick — see section 4) |
| GET    | `/api/most-played`    | `?limit=20`                                                  | Global top tracks, no device filter — for a "Popular" view |

Every handler: on any request, upsert the `devices` row
(`INSERT ... ON CONFLICT(device_id) DO UPDATE SET last_seen_at=?`) so device
bookkeeping happens automatically without a separate endpoint.

### 2.4 `src/index.js` — skeleton

```js
import { getDb } from './db.js';

function cors(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Geetmala-Key',
  };
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(env) },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(env) });

    if (request.headers.get('X-Geetmala-Key') !== env.API_KEY) {
      return json({ error: 'unauthorized' }, 401, env);
    }

    const url = new URL(request.url);
    const db = getDb(env);
    const now = Date.now();

    try {
      // touch devices row for whichever device_id is present
      const deviceId = url.searchParams.get('device_id')
        || (request.method === 'POST' ? (await request.clone().json()).device_id : null);
      if (deviceId) {
        await db.execute({
          sql: `INSERT INTO devices (device_id, created_at, last_seen_at) VALUES (?, ?, ?)
                ON CONFLICT(device_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
          args: [deviceId, now, now],
        });
      }

      if (url.pathname === '/api/state' && request.method === 'GET') {
        // run the four queries (favorites, last state, top-20 by play_count
        // for this device via play_events join track_stats, recent-20 from
        // play_events ordered by played_at desc) and return them combined
      }

      if (url.pathname === '/api/favorite' && request.method === 'POST') {
        // body.favorite === true  -> INSERT OR IGNORE INTO favorites
        // body.favorite === false -> DELETE FROM favorites WHERE device_id=? AND track_id=?
      }

      if (url.pathname === '/api/play-event' && request.method === 'POST') {
        // 1) INSERT INTO play_events
        // 2) if played_seconds >= 5: upsert track_stats
        //    (play_count += 1, total_seconds_listened += played_seconds, last_played_at = now)
        //    else if it was a skip (completed=0 and played_seconds < 5): skip_count += 1
        // 3) upsert device_state.last_track_id / last_position_sec
      }

      if (url.pathname === '/api/state-sync' && request.method === 'POST') {
        // upsert device_state with whatever fields are present in the body
      }

      if (url.pathname === '/api/most-played' && request.method === 'GET') {
        // SELECT track_id, play_count FROM track_stats ORDER BY play_count DESC LIMIT ?
      }

      return json({ error: 'not found' }, 404, env);
    } catch (err) {
      return json({ error: 'server error', detail: String(err) }, 500, env);
    }
  },
};
```

Fill in the SQL for each block using `db.execute({ sql, args })` /
`db.batch([...])` for the multi-statement ones (play-event does 3 writes —
use `db.batch` so they're atomic). Use parameterized queries everywhere,
never string-concatenate values into SQL.

### 2.5 Deploy

```bash
wrangler deploy
```
Note the resulting `*.workers.dev` URL — the frontend needs it next.

---

## 3. Frontend changes — `geetmala/js/app.js`

The app must work exactly as it does today if the Worker is down or the
user is offline. Every API call below is **fire-and-forget with a
try/catch that fails silently** — never block playback or throw a visible
error over a failed sync. `localStorage` remains the source of truth for
instant boot; the backend is an enhancement layered on top (multi-device
sync, aggregate stats), not a replacement.

### 3.1 New config + device id

```js
const API_BASE = 'https://geetmala-backend.<your-subdomain>.workers.dev';
const API_KEY = '<same value as the Worker secret API_KEY>';

function getDeviceId() {
  let id = localStorage.getItem('geetmala_device_id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('geetmala_device_id', id);
  }
  return id;
}

async function apiCall(path, options = {}) {
  try {
    const res = await fetch(API_BASE + path, {
      ...options,
      headers: { 'Content-Type': 'application/json', 'X-Geetmala-Key': API_KEY, ...options.headers },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // offline / worker down — caller treats this as "no data"
  }
}
```

### 3.2 On boot (after `bootLibrary()` finishes loading the CSV)

Call `GET /api/state?device_id=...`. If it returns data, use it to
**supplement**, not override, the existing localStorage-based resume flow
(the resume toast, played-history, shuffle queue already implemented stay
as-is). New uses of the response:
- `favorites` → mark those track rows as liked (see 3.4 UI)
- `top` → powers a new "Most Played" toggle in the playlist panel

### 3.3 Logging a play event

Track this with a small accumulator, not on every `timeupdate` tick:

- On `loadTrack()`, before switching to the new track, flush a play-event
  for whatever track was previously playing: `POST /api/play-event` with
  `played_seconds` = accumulated listened time this session,
  `completed` = true if it reached `ended`, `source` = how it started
  (reuse the existing `pushHistory`/shuffle/auto context you already have).
- Reset the accumulator on every new `loadTrack()` call.
- Also flush on `beforeunload` (alongside the existing
  `persistPlaybackPosition()` call) so a closed tab isn't lost.

### 3.4 Favorites UI

Add a heart/star icon:
- In the now-playing panel, near `track-meta` (a toggle button, filled vs
  outline state, using the existing `--accent` color).
- In each playlist row, small icon in a new column — but check overall row
  width first; on mobile the `.row__duration` column already hides at
  480px, so slot the heart where it hides, don't add a 5th column.

On click: optimistic UI update (toggle immediately), then
`POST /api/favorite`; on failure, silently revert the icon state on next
boot's `/api/state` reconcile — don't show an error toast for this, it's
low-stakes.

### 3.5 "Most Played" / "Recently Played" view

Add a small toggle in `.list-head` next to the existing search input:
`[ All ] [ Favorites ] [ Most Played ]` — reuses the existing
`state.filtered` + `renderList()` pipeline, just changes what populates
`state.filtered` (full library / favorited subset / top-N by play_count,
same row rendering as today, no new component needed).

### 3.6 Preferences sync (optional, do last)

The existing `AUTOSAVE_MS` (3s) `timeupdate` tick already saves position to
localStorage. Piggyback a `POST /api/state-sync` on that same interval
(don't add a second timer) with the current shuffle/repeat/volume/speed —
same fire-and-forget pattern as everything else here.

---

## 4. Degrade-gracefully checklist (verify before calling this done)

- [ ] Turning off wifi / blocking the Worker's domain: app still loads the
      CSV, plays songs, remembers position via localStorage, exactly like
      before this backend existed.
- [ ] No `alert()`/blocking dialogs on any failed API call — silent catch only.
- [ ] `API_KEY` and `TURSO_AUTH_TOKEN` never appear in git history — check
      `wrangler.toml` doesn't have the token, only `.dev.vars` (gitignored)
      does for local dev.
- [ ] `played_seconds < 5` never inflates `play_count`.
- [ ] Two browser tabs open on the same device_id don't double-count a play
      (each tab flushes its own accumulator independently — acceptable for
      v1, note it as a known limitation rather than solving it now).

## 5. Testing

1. `wrangler dev` locally, point `API_BASE` at `http://localhost:8787`
   temporarily, confirm all 5 endpoints respond with `curl` + the
   `X-Geetmala-Key` header before wiring the frontend.
2. Play a song for >5s, switch tracks, check `track_stats.play_count`
   incremented via `turso db shell geetmala-qijubevadi "SELECT * FROM track_stats"`.
3. Favorite a track, reload the page, confirm it's still shown as favorited
   (round-trips through `/api/state`).
4. Kill the Worker (or feed it a wrong `API_KEY`) and confirm the app is
   still fully usable.
