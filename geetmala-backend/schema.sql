-- Turso database schema for Geetmala backend

-- One row per browser/device
CREATE TABLE IF NOT EXISTS devices (
  device_id     TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

-- Liked songs
CREATE TABLE IF NOT EXISTS favorites (
  device_id     TEXT NOT NULL,
  track_id      TEXT NOT NULL,
  favorited_at  INTEGER NOT NULL,
  PRIMARY KEY (device_id, track_id)
);

-- One row per play attempt
CREATE TABLE IF NOT EXISTS play_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id      TEXT NOT NULL,
  track_id       TEXT NOT NULL,
  played_at      INTEGER NOT NULL,   -- unix ms when playback started
  played_seconds REAL NOT NULL,      -- how long listened
  completed      INTEGER NOT NULL DEFAULT 0,  -- 1 if played to end
  source         TEXT                -- 'manual' | 'auto' | 'shuffle' | 'change'
);
CREATE INDEX IF NOT EXISTS idx_play_events_device ON play_events(device_id, played_at DESC);
CREATE INDEX IF NOT EXISTS idx_play_events_track  ON play_events(track_id);

-- Aggregate counters updated per play_event
CREATE TABLE IF NOT EXISTS track_stats (
  track_id              TEXT PRIMARY KEY,
  play_count            INTEGER NOT NULL DEFAULT 0,
  skip_count            INTEGER NOT NULL DEFAULT 0,
  total_seconds_listened REAL NOT NULL DEFAULT 0,
  last_played_at        INTEGER
);

-- Per device state and preferences
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
