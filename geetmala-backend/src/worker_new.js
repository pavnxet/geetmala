// ============================================================
// Geetmala Cloudflare Worker — Full Rewrite
// Zero-dependency · Native fetch · Turso REST /v2/pipeline
// ============================================================

// ── Turso HTTP client ────────────────────────────────────────
async function turso(env, statements) {
  const rawUrl = env.TURSO_DATABASE_URL || '';
  const token  = env.TURSO_AUTH_TOKEN  || '';

  if (!rawUrl) throw new Error('TURSO_DATABASE_URL not set');
  if (!token)  throw new Error('TURSO_AUTH_TOKEN not set');

  // Convert libsql:// to https://
  const baseUrl = rawUrl
    .replace(/^libsql:\/\//, 'https://')
    .replace(/\/$/, '');

  const pipelineUrl = baseUrl + '/v2/pipeline';

  const requests = statements.map((s) => ({
    type: 'execute',
    stmt: {
      sql: s.sql,
      args: (s.args || []).map(toTursoArg),
    },
  }));
  requests.push({ type: 'close' });

  const resp = await fetch(pipelineUrl, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ requests }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error('Turso ' + resp.status + ': ' + txt);
  }

  const data = await resp.json();

  return data.results.map((r) => {
    if (r.type === 'error') {
      throw new Error('Turso query error: ' + (r.error && r.error.message ? r.error.message : JSON.stringify(r.error)));
    }
    const result = r.response && r.response.result ? r.response.result : null;
    if (!result) return { rows: [] };
    const cols = (result.cols || []).map((c) => c.name);
    const rows = (result.rows || []).map((rowArr) => {
      const row = {};
      rowArr.forEach((cell, i) => {
        row[cols[i]] = (cell && cell.value !== undefined) ? cell.value : null;
      });
      return row;
    });
    return { rows };
  });
}

function toTursoArg(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'boolean')        return { type: 'integer', value: v ? '1' : '0' };
  if (typeof v === 'number') {
    if (isNaN(v) || !isFinite(v))    return { type: 'null' };
    if (Number.isInteger(v))         return { type: 'integer', value: String(v) };
    return { type: 'float', value: String(v) };
  }
  return { type: 'text', value: String(v) };
}

// ── CORS + JSON helpers ──────────────────────────────────────
function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin':  env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Geetmala-Key',
  };
}

function jsonResp(data, status, env) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders(env)),
  });
}

// ── Main Worker ──────────────────────────────────────────────
export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    // API key guard
    if (env.API_KEY && request.headers.get('X-Geetmala-Key') !== env.API_KEY) {
      return jsonResp({ error: 'unauthorized' }, 401, env);
    }

    const url = new URL(request.url);
    const now = Date.now();

    try {
      // Parse POST body
      let body = {};
      if (request.method === 'POST') {
        try { body = await request.json(); } catch (e) { body = {}; }
      }

      const deviceId = url.searchParams.get('device_id') || body.device_id || null;

      // Register / heartbeat device
      if (deviceId) {
        try {
          await turso(env, [{
            sql: 'INSERT INTO devices (device_id, created_at, last_seen_at) VALUES (?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET last_seen_at = excluded.last_seen_at',
            args: [deviceId, now, now],
          }]);
        } catch (e) {
          console.warn('Device upsert warning: ' + String(e));
        }
      }

      // ── GET /api/state ──────────────────────────────────────
      if (url.pathname === '/api/state' && request.method === 'GET') {
        const did = deviceId || '';
        const results = await turso(env, [
          { sql: 'SELECT track_id FROM favorites WHERE device_id = ? ORDER BY favorited_at DESC', args: [did] },
          { sql: 'SELECT last_track_id, last_position_sec, shuffle_enabled, repeat_mode, volume, playback_speed FROM device_state WHERE device_id = ?', args: [did] },
          { sql: 'SELECT track_id, play_count, total_seconds_listened FROM track_stats ORDER BY play_count DESC LIMIT 20', args: [] },
          { sql: 'SELECT track_id, played_at FROM play_events WHERE device_id = ? ORDER BY played_at DESC LIMIT 20', args: [did] },
        ]);
        return jsonResp({
          favorites: (results[0].rows || []).map((r) => r.track_id),
          last:      (results[1].rows && results[1].rows[0]) || null,
          top:       results[2].rows || [],
          recent:    results[3].rows || [],
        }, 200, env);
      }

      // ── POST /api/favorite ──────────────────────────────────
      if (url.pathname === '/api/favorite' && request.method === 'POST') {
        if (!body.device_id || !body.track_id) {
          return jsonResp({ error: 'missing device_id or track_id' }, 400, env);
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
        return jsonResp({ success: true }, 200, env);
      }

      // ── POST /api/play-event ────────────────────────────────
      if (url.pathname === '/api/play-event' && request.method === 'POST') {
        if (!body.device_id || !body.track_id) {
          return jsonResp({ error: 'missing device_id or track_id' }, 400, env);
        }
        const playedSec  = Math.max(0, Number(body.played_seconds) || 0);
        const completedN = body.completed ? 1 : 0;
        const src        = String(body.source || 'manual');

        const stmts = [{
          sql: 'INSERT INTO play_events (device_id, track_id, played_at, played_seconds, completed, source) VALUES (?, ?, ?, ?, ?, ?)',
          args: [body.device_id, body.track_id, now, playedSec, completedN, src],
        }];

        if (playedSec >= 5) {
          stmts.push({
            sql: 'INSERT INTO track_stats (track_id, play_count, skip_count, total_seconds_listened, last_played_at) VALUES (?, 1, 0, ?, ?) ON CONFLICT(track_id) DO UPDATE SET play_count = play_count + 1, total_seconds_listened = total_seconds_listened + excluded.total_seconds_listened, last_played_at = excluded.last_played_at',
            args: [body.track_id, playedSec, now],
          });
        } else {
          stmts.push({
            sql: 'INSERT INTO track_stats (track_id, play_count, skip_count, total_seconds_listened, last_played_at) VALUES (?, 0, 1, 0, ?) ON CONFLICT(track_id) DO UPDATE SET skip_count = skip_count + 1, last_played_at = excluded.last_played_at',
            args: [body.track_id, now],
          });
        }

        stmts.push({
          sql: 'INSERT INTO device_state (device_id, last_track_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET last_track_id = excluded.last_track_id, updated_at = excluded.updated_at',
          args: [body.device_id, body.track_id, now],
        });

        await turso(env, stmts);
        return jsonResp({ success: true }, 200, env);
      }

      // ── POST /api/state-sync ────────────────────────────────
      if (url.pathname === '/api/state-sync' && request.method === 'POST') {
        if (!body.device_id) {
          return jsonResp({ error: 'missing device_id' }, 400, env);
        }
        const lastTrackId    = body.last_track_id    != null ? String(body.last_track_id)      : null;
        const lastPosSec     = body.last_position_sec != null ? Number(body.last_position_sec)  : null;
        const shuffleEnabled = body.shuffle_enabled   != null ? (body.shuffle_enabled ? 1 : 0)  : 0;
        const repeatMode     = String(body.repeat_mode || 'off');
        const volume         = body.volume            != null ? Number(body.volume)              : 0.8;
        const playbackSpeed  = body.playback_speed    != null ? Number(body.playback_speed)      : 1.0;

        await turso(env, [{
          sql: 'INSERT INTO device_state (device_id, last_track_id, last_position_sec, shuffle_enabled, repeat_mode, volume, playback_speed, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET last_track_id = COALESCE(excluded.last_track_id, device_state.last_track_id), last_position_sec = COALESCE(excluded.last_position_sec, device_state.last_position_sec), shuffle_enabled = excluded.shuffle_enabled, repeat_mode = excluded.repeat_mode, volume = excluded.volume, playback_speed = excluded.playback_speed, updated_at = excluded.updated_at',
          args: [body.device_id, lastTrackId, lastPosSec, shuffleEnabled, repeatMode, volume, playbackSpeed, now],
        }]);
        return jsonResp({ success: true }, 200, env);
      }

      // ── GET /api/most-played ────────────────────────────────
      if (url.pathname === '/api/most-played' && request.method === 'GET') {
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
        const results = await turso(env, [{
          sql: 'SELECT track_id, play_count, total_seconds_listened FROM track_stats ORDER BY play_count DESC LIMIT ?',
          args: [limit],
        }]);
        return jsonResp({ top: results[0].rows || [] }, 200, env);
      }

      return jsonResp({ error: 'not found' }, 404, env);

    } catch (err) {
      console.error('Worker error: ' + String(err));
      return jsonResp({ error: 'server error', detail: String(err) }, 500, env);
    }
  },
};
