import { createClient } from 'https://esm.sh/@libsql/client@0.14.0/web';

function getDb(env) {
  return createClient({
    url: env.TURSO_DATABASE_URL,
    authToken: env.TURSO_AUTH_TOKEN,
  });
}

function cors(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
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
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors(env) });
    }

    if (env.API_KEY && request.headers.get('X-Geetmala-Key') !== env.API_KEY) {
      return json({ error: 'unauthorized' }, 401, env);
    }

    const url = new URL(request.url);
    const db = getDb(env);
    const now = Date.now();

    try {
      let body = null;
      if (request.method === 'POST') {
        try { body = await request.json(); } catch { body = {}; }
      }

      const deviceId = url.searchParams.get('device_id') || body?.device_id;
      if (deviceId) {
        await db.execute({
          sql: `INSERT INTO devices (device_id, created_at, last_seen_at) VALUES (?, ?, ?)
                ON CONFLICT(device_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
          args: [deviceId, now, now],
        });
      }

      // --- GET /api/state ---
      if (url.pathname === '/api/state' && request.method === 'GET') {
        const favsRes = deviceId ? await db.execute({
          sql: 'SELECT track_id FROM favorites WHERE device_id = ? ORDER BY favorited_at DESC',
          args: [deviceId],
        }) : { rows: [] };

        const lastStateRes = deviceId ? await db.execute({
          sql: 'SELECT last_track_id, last_position_sec, shuffle_enabled, repeat_mode, volume, playback_speed FROM device_state WHERE device_id = ?',
          args: [deviceId],
        }) : { rows: [] };

        const topRes = await db.execute({
          sql: 'SELECT track_id, play_count, total_seconds_listened FROM track_stats ORDER BY play_count DESC LIMIT 20',
          args: [],
        });

        const recentRes = deviceId ? await db.execute({
          sql: 'SELECT track_id, played_at FROM play_events WHERE device_id = ? ORDER BY played_at DESC LIMIT 20',
          args: [deviceId],
        }) : { rows: [] };

        return json({
          favorites: favsRes.rows.map((r) => r.track_id),
          last: lastStateRes.rows[0] || null,
          top: topRes.rows,
          recent: recentRes.rows,
        }, 200, env);
      }

      // --- POST /api/favorite ---
      if (url.pathname === '/api/favorite' && request.method === 'POST') {
        if (!body?.device_id || !body?.track_id) {
          return json({ error: 'missing device_id or track_id' }, 400, env);
        }
        if (body.favorite) {
          await db.execute({
            sql: 'INSERT OR IGNORE INTO favorites (device_id, track_id, favorited_at) VALUES (?, ?, ?)',
            args: [body.device_id, body.track_id, now],
          });
        } else {
          await db.execute({
            sql: 'DELETE FROM favorites WHERE device_id = ? AND track_id = ?',
            args: [body.device_id, body.track_id],
          });
        }
        return json({ success: true }, 200, env);
      }

      // --- POST /api/play-event ---
      if (url.pathname === '/api/play-event' && request.method === 'POST') {
        if (!body?.device_id || !body?.track_id) {
          return json({ error: 'missing device_id or track_id' }, 400, env);
        }
        const playedSec = Number(body.played_seconds) || 0;
        const completed = body.completed ? 1 : 0;
        const source = String(body.source || 'manual');

        const statements = [
          {
            sql: 'INSERT INTO play_events (device_id, track_id, played_at, played_seconds, completed, source) VALUES (?, ?, ?, ?, ?, ?)',
            args: [body.device_id, body.track_id, now, playedSec, completed, source],
          },
        ];

        if (playedSec >= 5) {
          statements.push({
            sql: `INSERT INTO track_stats (track_id, play_count, total_seconds_listened, last_played_at)
                  VALUES (?, 1, ?, ?)
                  ON CONFLICT(track_id) DO UPDATE SET
                    play_count = play_count + 1,
                    total_seconds_listened = total_seconds_listened + excluded.total_seconds_listened,
                    last_played_at = excluded.last_played_at`,
            args: [body.track_id, playedSec, now],
          });
        } else if (!completed) {
          statements.push({
            sql: `INSERT INTO track_stats (track_id, skip_count) VALUES (?, 1)
                  ON CONFLICT(track_id) DO UPDATE SET skip_count = skip_count + 1`,
            args: [body.track_id],
          });
        }

        statements.push({
          sql: `INSERT INTO device_state (device_id, last_track_id, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(device_id) DO UPDATE SET last_track_id = excluded.last_track_id, updated_at = excluded.updated_at`,
          args: [body.device_id, body.track_id, now],
        });

        await db.batch(statements);
        return json({ success: true }, 200, env);
      }

      // --- POST /api/state-sync ---
      if (url.pathname === '/api/state-sync' && request.method === 'POST') {
        if (!body?.device_id) {
          return json({ error: 'missing device_id' }, 400, env);
        }
        await db.execute({
          sql: `INSERT INTO device_state (device_id, last_track_id, last_position_sec, shuffle_enabled, repeat_mode, volume, playback_speed, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(device_id) DO UPDATE SET
                  last_track_id = COALESCE(excluded.last_track_id, device_state.last_track_id),
                  last_position_sec = COALESCE(excluded.last_position_sec, device_state.last_position_sec),
                  shuffle_enabled = COALESCE(excluded.shuffle_enabled, device_state.shuffle_enabled),
                  repeat_mode = COALESCE(excluded.repeat_mode, device_state.repeat_mode),
                  volume = COALESCE(excluded.volume, device_state.volume),
                  playback_speed = COALESCE(excluded.playback_speed, device_state.playback_speed),
                  updated_at = excluded.updated_at`,
          args: [
            body.device_id,
            body.last_track_id || null,
            body.last_position_sec ?? null,
            body.shuffle_enabled ?? 0,
            body.repeat_mode || 'off',
            body.volume ?? 0.8,
            body.playback_speed ?? 1.0,
            now,
          ],
        });
        return json({ success: true }, 200, env);
      }

      // --- GET /api/most-played ---
      if (url.pathname === '/api/most-played' && request.method === 'GET') {
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
        const res = await db.execute({
          sql: 'SELECT track_id, play_count, total_seconds_listened FROM track_stats ORDER BY play_count DESC LIMIT ?',
          args: [limit],
        });
        return json({ top: res.rows }, 200, env);
      }

      return json({ error: 'not found' }, 404, env);
    } catch (err) {
      return json({ error: 'server error', detail: String(err) }, 500, env);
    }
  },
};
