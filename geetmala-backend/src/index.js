// Zero-dependency Turso REST HTTP Client for Cloudflare Workers
async function turso(env, statements) {
  let dbUrl = env.TURSO_DATABASE_URL || '';
  if (!dbUrl) {
    console.warn('TURSO_DATABASE_URL is missing in environment variables');
    return statements.map(() => ({ rows: [] }));
  }

  if (!dbUrl.startsWith('http://') && !dbUrl.startsWith('https://')) {
    dbUrl = 'https://' + dbUrl.replace(/^libsql:\/\//, '');
  }
  const pipelineUrl = `${dbUrl.replace(/\/$/, '')}/v2/pipeline`;

  const requests = statements.map((s) => {
    const args = (s.args || []).map((a) => {
      if (a === null || a === undefined) return { type: 'null' };
      if (typeof a === 'number') {
        return Number.isInteger(a) ? { type: 'integer', value: String(a) } : { type: 'float', value: a };
      }
      return { type: 'text', value: String(a) };
    });

    return {
      type: 'execute',
      stmt: { sql: s.sql, args },
    };
  });

  requests.push({ type: 'close' });

  const res = await fetch(pipelineUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.TURSO_AUTH_TOKEN || ''}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ requests }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Turso HTTP error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return data.results.map((r) => {
    if (r.type === 'error') throw new Error(r.error?.message || 'Turso Query Error');
    const resObj = r.response?.result;
    if (!resObj) return { rows: [] };
    const cols = (resObj.cols || []).map((c) => c.name);
    const rows = (resObj.rows || []).map((rowValues) => {
      const row = {};
      rowValues.forEach((v, idx) => {
        row[cols[idx]] = v ? (v.value !== undefined ? v.value : v) : null;
      });
      return row;
    });
    return { rows };
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
    const now = Date.now();

    try {
      let body = null;
      if (request.method === 'POST') {
        try { body = await request.json(); } catch { body = {}; }
      }

      const deviceId = url.searchParams.get('device_id') || body?.device_id;
      if (deviceId && env.TURSO_DATABASE_URL) {
        try {
          await turso(env, [{
            sql: `INSERT INTO devices (device_id, created_at, last_seen_at) VALUES (?, ?, ?)
                  ON CONFLICT(device_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
            args: [deviceId, now, now],
          }]);
        } catch (e) {
          console.warn('Device tracking error:', e);
        }
      }

      // --- GET /api/state ---
      if (url.pathname === '/api/state' && request.method === 'GET') {
        const [favsRes, lastStateRes, topRes, recentRes] = await turso(env, [
          { sql: 'SELECT track_id FROM favorites WHERE device_id = ? ORDER BY favorited_at DESC', args: [deviceId || ''] },
          { sql: 'SELECT last_track_id, last_position_sec, shuffle_enabled, repeat_mode, volume, playback_speed FROM device_state WHERE device_id = ?', args: [deviceId || ''] },
          { sql: 'SELECT track_id, play_count, total_seconds_listened FROM track_stats ORDER BY play_count DESC LIMIT 20', args: [] },
          { sql: 'SELECT track_id, played_at FROM play_events WHERE device_id = ? ORDER BY played_at DESC LIMIT 20', args: [deviceId || ''] },
        ]);

        return json({
          favorites: (favsRes.rows || []).map((r) => r.track_id),
          last: (lastStateRes.rows && lastStateRes.rows[0]) || null,
          top: topRes.rows || [],
          recent: recentRes.rows || [],
        }, 200, env);
      }

      // --- POST /api/favorite ---
      if (url.pathname === '/api/favorite' && request.method === 'POST') {
        if (!body?.device_id || !body?.track_id) {
          return json({ error: 'missing device_id or track_id' }, 400, env);
        }
        if (body.favorite) {
          await turso(env, [{
            sql: 'INSERT OR IGNORE INTO favorites (device_id, track_id, favorited_at) VALUES (?, ?, ?)',
            args: [body.device_id, body.track_id, now],
          }]);
        } else {
          await turso(env, [{
            sql: 'DELETE FROM favorites WHERE device_id = ? AND track_id = ?',
            args: [body.device_id, body.track_id],
          }]);
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

        await turso(env, statements);
        return json({ success: true }, 200, env);
      }

      // --- POST /api/state-sync ---
      if (url.pathname === '/api/state-sync' && request.method === 'POST') {
        if (!body?.device_id) {
          return json({ error: 'missing device_id' }, 400, env);
        }
        await turso(env, [{
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
        }]);
        return json({ success: true }, 200, env);
      }

      // --- GET /api/most-played ---
      if (url.pathname === '/api/most-played' && request.method === 'GET') {
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
        const [topRes] = await turso(env, [{
          sql: 'SELECT track_id, play_count, total_seconds_listened FROM track_stats ORDER BY play_count DESC LIMIT ?',
          args: [limit],
        }]);
        return json({ top: topRes.rows || [] }, 200, env);
      }

      return json({ error: 'not found' }, 404, env);
    } catch (err) {
      return json({ error: 'server error', detail: String(err) }, 500, env);
    }
  },
};
