/* ==========================================================================
   Geetmala — app.js
   Single-file client logic. No build step, no backend. Organised top to
   bottom the way it runs: config → state → utils → auth → data → queue →
   audio engine → rendering → media session → shortcuts → boot.
   ========================================================================== */
(() => {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* 1. CONFIG                                                          */
  /* ------------------------------------------------------------------ */
  const CONFIG = {
    // Password: pavneet
    PASSWORD_HASH: '74d332f35f91c3fa8261160a0b14bb1a3b1d745fa2df8a5476b96ef873013235',
    CSV_PATH: 'data/songs.csv',
    PAGE_SIZE: 80,
    AUTOSAVE_MS: 3000,
    SEEK_STEP_KEY: 5,      // keyboard ← / → per the spec
    SEEK_STEP_BTN: 10,     // ⏪ / ⏩ buttons per the spec
    VOLUME_STEP: 0.05,
    API_BASE: 'https://geetmala.pavneet1804.workers.dev',
    API_KEY: 'geetmala_secret_key_2026',
  };

  const KEYS = {
    AUTH: 'geetmala_auth',
    PLAYED: 'geetmala_played_ids',
    LAST_TRACK: 'geetmala_last_track_id',
    LAST_TIME: 'geetmala_last_time',
    VOLUME: 'geetmala_volume',
    SHUFFLE: 'geetmala_shuffle_enabled',
    REPEAT: 'geetmala_repeat_mode',
    SPEED: 'geetmala_speed',
    DEVICE_ID: 'geetmala_device_id',
    FAVORITES: 'geetmala_favorites',
    TRACK_STATS: 'geetmala_track_stats',
  };

  /* ------------------------------------------------------------------ */
  /* 2. DOM refs                                                        */
  /* ------------------------------------------------------------------ */
  const $ = (id) => document.getElementById(id);

  const dom = {
    gate: $('gate'), gateForm: $('gateForm'), gatePassword: $('gatePassword'), gateError: $('gateError'),
    app: $('app'), logoutBtn: $('logoutBtn'), libraryStatus: $('libraryStatus'),

    disc: $('vinylDisc'), discInitial: $('discInitial'), tonearm: $('tonearm'),
    trackYearAlbum: $('trackYearAlbum'), trackTitle: $('trackTitle'), trackArtist: $('trackArtist'), likeBtn: $('likeBtn'),

    seekbar: $('seekbar'), timeCurrent: $('timeCurrent'), timeDuration: $('timeDuration'),

    shuffleBtn: $('shuffleBtn'), prevBtn: $('prevBtn'), rewindBtn: $('rewindBtn'),
    playBtn: $('playBtn'), iconPlay: $('iconPlay'), iconPause: $('iconPause'),
    forwardBtn: $('forwardBtn'), nextBtn: $('nextBtn'),
    repeatBtn: $('repeatBtn'), repeatOneDot: $('repeatOneDot'),

    muteBtn: $('muteBtn'), iconVolUp: $('iconVolUp'), iconVolMute: $('iconVolMute'),
    volumeSlider: $('volumeSlider'), speedSelect: $('speedSelect'),
    queueStatus: $('queueStatus'),

    searchInput: $('searchInput'), listTabs: $('listTabs'), listCount: $('listCount'),
    listScroll: $('listScroll'), listRows: $('listRows'), listEmpty: $('listEmpty'), listSentinel: $('listSentinel'),

    toastHost: $('toastHost'),
  };

  const audio = new Audio();
  audio.preload = 'metadata';

  const nextAudio = new Audio();
  nextAudio.preload = 'auto';

  let nextPreloadedTrack = null;
  let currentTrackFullyLoaded = false;

  /* ------------------------------------------------------------------ */
  /* 3. STATE                                                           */
  /* ------------------------------------------------------------------ */
  const state = {
    allTracks: [],          // full parsed library, in CSV order
    byId: new Map(),        // id -> track
    filtered: [],           // current search result (or allTracks)
    renderCount: 0,         // how many filtered rows are rendered so far

    currentTrack: null,
    isPlaying: false,

    playedIds: new Set(),   // ids heard since the last full cycle
    history: [],            // ids, in the order actually played this session
    historyPointer: -1,

    shuffle: false,
    repeatMode: 'off',      // 'off' | 'one' | 'all'
    lastSaveAt: 0,

    favorites: new Set(),   // track IDs favorited
    trackStats: new Map(),  // track_id -> { play_count, total_seconds }
    currentView: 'all',     // 'all' | 'favorites' | 'top'
    sessionListenedSec: 0,  // listened seconds accumulator for active track
    lastTimeupdateSec: 0,
  };

  /* ------------------------------------------------------------------ */
  /* 4. UTILS                                                           */
  /* ------------------------------------------------------------------ */
  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '00:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // Accepts "mm:ss", "h:mm:ss" or a raw seconds number from the CSV.
  function parseDurationToSeconds(raw) {
    if (raw == null || raw === '') return 0;
    if (!isNaN(raw)) return Number(raw);
    const parts = String(raw).split(':').map(Number);
    if (parts.some(isNaN)) return 0;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  function sha256SyncFallback(ascii) {
    const mathPow = Math.pow;
    let result = '';
    const words = [];
    const asciiLength = ascii.length * 8;
    let i, j;
    let hash = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ];
    const k = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    for (i = 0; i < ascii.length; i++) {
      j = ascii.charCodeAt(i);
      words[i >> 2] |= j << ((3 - i % 4) * 8);
    }
    words[asciiLength >> 5] |= 0x80 << (24 - asciiLength % 32);
    words[((asciiLength + 64 >> 9) << 4) + 15] = asciiLength;
    const w = [];
    for (i = 0; i < words.length; i += 16) {
      const oldHash = hash.slice(0);
      for (j = 0; j < 64; j++) {
        const wJ = j < 16 ? words[i + j] : (
          w[j - 2] = (
            (w[j - 2] >>> 17 | w[j - 2] << 15) ^
            (w[j - 2] >>> 19 | w[j - 2] << 13) ^
            (w[j - 2] >>> 10)
          ) + (
            (w[j - 15] >>> 7 | w[j - 15] << 25) ^
            (w[j - 15] >>> 18 | w[j - 15] << 14) ^
            (w[j - 15] >>> 3)
          ) + w[j - 7] + w[j - 16]
        );
        const s1 = (hash[4] >>> 6 | hash[4] << 26) ^ (hash[4] >>> 11 | hash[4] << 21) ^ (hash[4] >>> 25 | hash[4] << 7);
        const ch = (hash[4] & hash[5]) ^ (~hash[4] & hash[6]);
        const temp1 = hash[7] + s1 + ch + k[j] + (wJ | 0);
        const s0 = (hash[0] >>> 2 | hash[0] << 30) ^ (hash[0] >>> 13 | hash[0] << 19) ^ (hash[0] >>> 22 | hash[0] << 10);
        const maj = (hash[0] & hash[1]) ^ (hash[0] & hash[2]) ^ (hash[1] & hash[2]);
        const temp2 = s0 + maj;
        hash[7] = hash[6];
        hash[6] = hash[5];
        hash[5] = hash[4];
        hash[4] = (hash[3] + temp1) | 0;
        hash[3] = hash[2];
        hash[2] = hash[1];
        hash[1] = hash[0];
        hash[0] = (temp1 + temp2) | 0;
      }
      for (j = 0; j < 8; j++) {
        hash[j] = (hash[j] + oldHash[j]) | 0;
      }
    }
    for (i = 0; i < 8; i++) {
      for (j = 3; j >= 0; j--) {
        const b = (hash[i] >> (j * 8)) & 255;
        result += (b < 16 ? '0' : '') + b.toString(16);
      }
    }
    return result;
  }

  async function sha256Hex(text) {
    if (window.isSecureContext && window.crypto?.subtle) {
      try {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
      } catch { /* fallback below */ }
    }
    return sha256SyncFallback(text);
  }

  function getDeviceId() {
    let id = safeGet(KEYS.DEVICE_ID);
    if (!id) {
      id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'dev_' + Math.random().toString(36).substring(2, 15);
      safeSet(KEYS.DEVICE_ID, id);
    }
    return id;
  }

  async function apiCall(path, options = {}) {
    if (!CONFIG.API_BASE) return null;
    try {
      const res = await fetch(CONFIG.API_BASE + path, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          'X-Geetmala-Key': CONFIG.API_KEY,
          ...(options.headers || {}),
        },
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  function showToast({ message, actions = [], timeout = 6000 }) {
    const el = document.createElement('div');
    el.className = 'toast';
    const p = document.createElement('p');
    p.innerHTML = message; // message is built from our own strings only, see call sites
    el.appendChild(p);
    if (actions.length) {
      const wrap = document.createElement('div');
      wrap.className = 'toast__actions';
      actions.forEach((a) => {
        const btn = document.createElement('button');
        btn.className = 'toast__btn' + (a.primary ? ' toast__btn--primary' : '');
        btn.textContent = a.label;
        btn.addEventListener('click', () => { dismiss(); a.onClick?.(); });
        wrap.appendChild(btn);
      });
      el.appendChild(wrap);
    }
    dom.toastHost.appendChild(el);
    function dismiss() {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 260);
    }
    if (timeout) setTimeout(dismiss, timeout);
    return dismiss;
  }

  /* ------------------------------------------------------------------ */
  /* 5. AUTH                                                            */
  /* ------------------------------------------------------------------ */
  function isAuthed() { return safeGet(KEYS.AUTH) === 'true'; }

  function unlock() {
    safeSet(KEYS.AUTH, 'true');
    dom.gate.classList.add('hidden');
    dom.app.classList.remove('hidden');
    bootLibrary();
  }

  function logout() {
    safeRemove(KEYS.AUTH);
    audio.pause();
    location.reload();
  }

  dom.gateForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    dom.gateError.textContent = '';
    const value = dom.gatePassword.value;
    try {
      const hash = await sha256Hex(value);
      if (hash === CONFIG.PASSWORD_HASH) {
        unlock();
      } else {
        dom.gateError.textContent = 'गलत पासवर्ड। दोबारा कोशिश करें।';
        dom.gateError.classList.remove('shake'); void dom.gateError.offsetWidth; dom.gateError.classList.add('shake');
        dom.gatePassword.value = '';
        dom.gatePassword.focus();
      }
    } catch {
      dom.gateError.textContent = 'ब्राउज़र में सुरक्षित सत्यापन उपलब्ध नहीं है (https या localhost पर खोलें)।';
    }
  });

  dom.logoutBtn.addEventListener('click', logout);

  /* ------------------------------------------------------------------ */
  /* 6. DATA LOADING                                                    */
  /* ------------------------------------------------------------------ */
  function bootLibrary() {
    dom.libraryStatus.textContent = 'लाइब्रेरी लोड हो रही है…';
    Papa.parse(CONFIG.CSV_PATH, {
      download: true,
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const rows = results.data || [];
        state.allTracks = rows
          .filter((r) => r.title && r.url)
          .map((r, i) => ({
            id: String(r.id ?? i),
            title: r.title.trim(),
            album: (r.album || '').trim(),
            artist: (r.artist || '').trim(),
            year: (r.year || '').trim(),
            duration: (r.duration || '').trim(),
            durationSeconds: parseDurationToSeconds(r.duration),
            url: r.url.trim(),
          }));
        state.allTracks.forEach((t) => state.byId.set(t.id, t));
        state.filtered = state.allTracks;

        dom.libraryStatus.textContent = `${state.allTracks.length} गीत उपलब्ध`;
        restorePreferences();
        restorePlayedIds();
        restoreFavorites();
        restoreTrackStats();
        renderList(true);
        maybeOfferResume();
        syncBackendState();
      },
      error: () => {
        dom.libraryStatus.textContent = 'songs.csv लोड नहीं हो सका';
        showToast({ message: `<strong>data/songs.csv</strong> नहीं मिली या पढ़ी नहीं जा सकी। कृपया फ़ाइल जांचें।`, timeout: 0, actions: [{ label: 'ठीक है' }] });
      },
    });
  }

  /* ------------------------------------------------------------------ */
  /* 7. PREFERENCES / PERSISTENCE                                       */
  /* ------------------------------------------------------------------ */
  function restorePreferences() {
    const vol = parseFloat(safeGet(KEYS.VOLUME));
    audio.volume = isNaN(vol) ? 0.8 : Math.min(1, Math.max(0, vol));
    dom.volumeSlider.value = String(audio.volume);
    updateVolumeUI();

    state.shuffle = safeGet(KEYS.SHUFFLE) === 'true';
    dom.shuffleBtn.setAttribute('aria-pressed', String(state.shuffle));

    state.repeatMode = safeGet(KEYS.REPEAT) || 'off';
    applyRepeatUI();

    const speed = parseFloat(safeGet(KEYS.SPEED));
    audio.playbackRate = isNaN(speed) ? 1 : speed;
    dom.speedSelect.value = String(audio.playbackRate);
  }

  function restorePlayedIds() {
    try {
      const arr = JSON.parse(safeGet(KEYS.PLAYED) || '[]');
      state.playedIds = new Set(arr.filter((id) => state.byId.has(id)));
    } catch {
      state.playedIds = new Set();
    }
    updateQueueStatus();
  }

  function restoreFavorites() {
    try {
      const arr = JSON.parse(safeGet(KEYS.FAVORITES) || '[]');
      state.favorites = new Set(arr.filter((id) => state.byId.has(id)));
    } catch {
      state.favorites = new Set();
    }
  }

  function persistFavorites() {
    safeSet(KEYS.FAVORITES, JSON.stringify([...state.favorites]));
  }

  function toggleFavorite(trackId) {
    if (!trackId) return;
    const isFav = state.favorites.has(trackId);
    if (isFav) {
      state.favorites.delete(trackId);
    } else {
      state.favorites.add(trackId);
    }
    persistFavorites();
    updateLikeUI();
    updateRowLikes(trackId);

    apiCall('/api/favorite', {
      method: 'POST',
      body: JSON.stringify({
        device_id: getDeviceId(),
        track_id: trackId,
        favorite: !isFav,
      }),
    });

    if (state.currentView === 'favorites') {
      applySearch(dom.searchInput.value);
    }
  }

  function restoreTrackStats() {
    try {
      const obj = JSON.parse(safeGet(KEYS.TRACK_STATS) || '{}');
      state.trackStats = new Map(Object.entries(obj));
    } catch {
      state.trackStats = new Map();
    }
  }

  function persistTrackStats() {
    const obj = {};
    state.trackStats.forEach((val, key) => { obj[key] = val; });
    safeSet(KEYS.TRACK_STATS, JSON.stringify(obj));
  }

  function flushPlayEvent({ completed = false, source = 'manual' } = {}) {
    if (!state.currentTrack || state.sessionListenedSec < 0.5) return;

    const trackId = state.currentTrack.id;
    const listenedSec = state.sessionListenedSec;
    state.sessionListenedSec = 0;

    if (listenedSec >= 5) {
      const stat = state.trackStats.get(trackId) || { play_count: 0, total_seconds: 0 };
      stat.play_count = (stat.play_count || 0) + 1;
      stat.total_seconds = (stat.total_seconds || 0) + listenedSec;
      state.trackStats.set(trackId, stat);
      persistTrackStats();
    }

    apiCall('/api/play-event', {
      method: 'POST',
      body: JSON.stringify({
        device_id: getDeviceId(),
        track_id: trackId,
        played_seconds: listenedSec,
        completed: completed ? 1 : 0,
        source: source,
      }),
    });
  }

  async function syncBackendState() {
    const data = await apiCall(`/api/state?device_id=${getDeviceId()}`);
    if (!data) return;
    if (Array.isArray(data.favorites)) {
      data.favorites.forEach((id) => state.favorites.add(id));
      persistFavorites();
      updateLikeUI();
      if (state.currentView === 'favorites') applySearch(dom.searchInput.value);
    }
    if (Array.isArray(data.top)) {
      data.top.forEach((item) => {
        if (item.track_id) {
          const stat = state.trackStats.get(item.track_id) || { play_count: 0, total_seconds: 0 };
          stat.play_count = Math.max(stat.play_count, item.play_count || 0);
          state.trackStats.set(item.track_id, stat);
        }
      });
      persistTrackStats();
    }
  }

  function persistPlaybackPosition() {
    if (!state.currentTrack) return;
    safeSet(KEYS.LAST_TRACK, state.currentTrack.id);
    safeSet(KEYS.LAST_TIME, String(audio.currentTime || 0));
  }

  function maybeOfferResume() {
    const lastId = safeGet(KEYS.LAST_TRACK);
    const lastTime = parseFloat(safeGet(KEYS.LAST_TIME));
    if (!lastId || !state.byId.has(lastId) || isNaN(lastTime) || lastTime < 3) return;

    const track = state.byId.get(lastId);
    showToast({
      timeout: 0,
      message: `पिछला गीत <strong>${escapeHtml(track.title)}</strong> ${formatTime(lastTime)} पर छोड़ा गया था।`,
      actions: [
        { label: 'Start Fresh', onClick: () => {} },
        {
          label: 'Resume Playback', primary: true,
          onClick: () => loadTrack(track, { resumeAt: lastTime, autoplay: true, pushHistory: true }),
        },
      ],
    });
  }

  /* ------------------------------------------------------------------ */
  /* 8. QUEUE / NO-REPEAT SHUFFLE LOGIC                                  */
  /* ------------------------------------------------------------------ */
  function remainingQueue() {
    return state.allTracks.filter((t) => !state.playedIds.has(t.id));
  }

  function markPlayed(track) {
    state.playedIds.add(track.id);
    persistPlayedIds();
    updateQueueStatus();
  }

  function updateQueueStatus() {
    dom.queueStatus.textContent = `${state.playedIds.size} / ${state.allTracks.length} गीत सुने गए`;
  }

  function pickRandomUnplayed({ peek = false } = {}) {
    let pool = remainingQueue();
    if (pool.length === 0) {
      if (peek) return state.allTracks[0] || null;
      state.playedIds.clear();
      persistPlayedIds();
      updateQueueStatus();
      showToast({ message: 'आपने सभी गीत सुन लिए हैं! प्ले-हिस्ट्री रीसेट की जा रही है।' });
      pool = state.allTracks;
    }
    // Don't hand back the track that's currently playing if there's a choice.
    const choices = pool.length > 1 && state.currentTrack
      ? pool.filter((t) => t.id !== state.currentTrack.id)
      : pool;
    return choices[Math.floor(Math.random() * choices.length)];
  }

  function pickNextSequential() {
    const list = state.allTracks;
    if (!list.length) return null;
    const idx = state.currentTrack ? list.findIndex((t) => t.id === state.currentTrack.id) : -1;
    if (idx === -1) return list[0];
    if (idx + 1 < list.length) return list[idx + 1];
    return state.repeatMode === 'all' ? list[0] : null; // null = reached the end, stop
  }

  function pickPrevSequential() {
    const list = state.allTracks;
    if (!list.length) return null;
    const idx = state.currentTrack ? list.findIndex((t) => t.id === state.currentTrack.id) : -1;
    if (idx <= 0) return state.repeatMode === 'all' ? list[list.length - 1] : list[0];
    return list[idx - 1];
  }

  /* ------------------------------------------------------------------ */
  /* PRELOAD ENGINE                                                     */
  /* ------------------------------------------------------------------ */
  function peekNextTrack() {
    if (!state.allTracks.length) return null;
    if (state.historyPointer < state.history.length - 1) {
      return state.byId.get(state.history[state.historyPointer + 1]);
    }
    if (state.repeatMode === 'one') {
      return state.currentTrack;
    }
    return state.shuffle ? pickRandomUnplayed({ peek: true }) : pickNextSequential();
  }

  function preloadNextTrack() {
    const next = peekNextTrack();
    if (!next) return;
    if (nextPreloadedTrack && nextPreloadedTrack.id === next.id) return;

    nextPreloadedTrack = next;
    nextAudio.src = next.url;
    nextAudio.load();
  }

  function checkCurrentTrackFullyLoaded() {
    if (currentTrackFullyLoaded || !state.currentTrack) return;

    let isFullyBuffered = audio.readyState === 4;
    if (!isFullyBuffered && audio.duration > 0 && audio.buffered && audio.buffered.length > 0) {
      const end = audio.buffered.end(audio.buffered.length - 1);
      if (end >= audio.duration - 1.5) {
        isFullyBuffered = true;
      }
    }

    if (isFullyBuffered) {
      currentTrackFullyLoaded = true;
      preloadNextTrack();
    }
  }

  /* ------------------------------------------------------------------ */
  /* 9. AUDIO ENGINE                                                     */
  /* ------------------------------------------------------------------ */
  function loadTrack(track, { resumeAt = 0, autoplay = false, pushHistory = false } = {}) {
    if (!track) return;

    if (state.currentTrack) {
      flushPlayEvent({ completed: false, source: 'change' });
    }

    const isPreloaded = nextPreloadedTrack && nextPreloadedTrack.id === track.id;

    state.currentTrack = track;
    currentTrackFullyLoaded = false;
    nextPreloadedTrack = null;
    state.sessionListenedSec = 0;
    state.lastTimeupdateSec = resumeAt || 0;

    if (isPreloaded && nextAudio.src) {
      audio.src = track.url;
      audio.currentTime = resumeAt || 0;
    } else {
      audio.src = track.url;
      audio.currentTime = resumeAt || 0;
    }

    nextAudio.pause();
    nextAudio.removeAttribute('src');
    nextAudio.load();

    if (pushHistory) {
      state.history = state.history.slice(0, state.historyPointer + 1);
      state.history.push(track.id);
      state.historyPointer = state.history.length - 1;
    }

    renderNowPlaying();
    updateLikeUI();
    updateActiveRowIndicator();
    updateMediaSessionMetadata();

    if (autoplay) {
      audio.play().catch(() => { /* needs a user gesture; UI stays paused */ });
    }
  }

  function playPause() {
    if (!state.currentTrack) {
      const first = state.shuffle ? pickRandomUnplayed() : state.allTracks[0];
      loadTrack(first, { autoplay: true, pushHistory: true });
      return;
    }
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  }

  function goNext({ auto = false } = {}) {
    if (!state.allTracks.length) return;
    // Step forward through history first (user had gone back earlier).
    if (state.historyPointer < state.history.length - 1) {
      state.historyPointer += 1;
      const t = state.byId.get(state.history[state.historyPointer]);
      loadTrack(t, { autoplay: true });
      return;
    }

    let next = null;
    if (nextPreloadedTrack) {
      next = nextPreloadedTrack;
    } else {
      next = state.shuffle ? pickRandomUnplayed() : pickNextSequential();
    }

    if (!next) { audio.pause(); return; } // end of library, repeat is off
    loadTrack(next, { autoplay: true, pushHistory: true });
  }

  function goPrev() {
    if (!state.allTracks.length) return;
    if (state.historyPointer > 0) {
      state.historyPointer -= 1;
      const t = state.byId.get(state.history[state.historyPointer]);
      loadTrack(t, { autoplay: true });
      return;
    }
    const prev = state.shuffle ? pickRandomUnplayed() : pickPrevSequential();
    if (prev) loadTrack(prev, { autoplay: true, pushHistory: true });
  }

  function seekBy(deltaSeconds) {
    if (!state.currentTrack) return;
    audio.currentTime = Math.min(Math.max(0, audio.currentTime + deltaSeconds), audio.duration || Infinity);
  }

  function setVolume(v) {
    audio.volume = Math.min(1, Math.max(0, v));
    audio.muted = false;
    safeSet(KEYS.VOLUME, String(audio.volume));
    updateVolumeUI();
  }

  function toggleMute() {
    audio.muted = !audio.muted;
    updateVolumeUI();
  }

  function toggleShuffle() {
    state.shuffle = !state.shuffle;
    safeSet(KEYS.SHUFFLE, String(state.shuffle));
    dom.shuffleBtn.setAttribute('aria-pressed', String(state.shuffle));
    if (currentTrackFullyLoaded) {
      nextPreloadedTrack = null;
      preloadNextTrack();
    }
  }

  function cycleRepeat() {
    state.repeatMode = { off: 'all', all: 'one', one: 'off' }[state.repeatMode];
    safeSet(KEYS.REPEAT, state.repeatMode);
    applyRepeatUI();
    if (currentTrackFullyLoaded) {
      nextPreloadedTrack = null;
      preloadNextTrack();
    }
  }

  function applyRepeatUI() {
    dom.repeatBtn.dataset.mode = state.repeatMode;
    dom.repeatBtn.setAttribute('aria-pressed', String(state.repeatMode !== 'off'));
    dom.repeatOneDot.classList.toggle('hidden', state.repeatMode !== 'one');
  }

  function setSpeed(v) {
    audio.playbackRate = v;
    safeSet(KEYS.SPEED, String(v));
  }

  // --- audio element events ---
  audio.addEventListener('canplaythrough', checkCurrentTrackFullyLoaded);
  audio.addEventListener('progress', checkCurrentTrackFullyLoaded);

  audio.addEventListener('play', () => {
    state.isPlaying = true;
    dom.iconPlay.classList.add('hidden');
    dom.iconPause.classList.remove('hidden');
    dom.disc.classList.add('spinning');
    dom.tonearm.classList.add('dropped');
    updateActiveRowIndicator();
    navigator.mediaSession && (navigator.mediaSession.playbackState = 'playing');
  });

  audio.addEventListener('pause', () => {
    state.isPlaying = false;
    dom.iconPlay.classList.remove('hidden');
    dom.iconPause.classList.add('hidden');
    dom.disc.classList.remove('spinning');
    dom.tonearm.classList.remove('dropped');
    persistPlaybackPosition();
    updateActiveRowIndicator();
    navigator.mediaSession && (navigator.mediaSession.playbackState = 'paused');
  });

  audio.addEventListener('loadedmetadata', () => {
    dom.timeDuration.textContent = formatTime(audio.duration);
    dom.seekbar.max = String(audio.duration || 0);
    updateMediaSessionPosition();
  });

  audio.addEventListener('timeupdate', () => {
    if (!isScrubbing) {
      dom.seekbar.value = String(audio.currentTime || 0);
      const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
      dom.seekbar.style.setProperty('--pct', pct + '%');
    }
    dom.timeCurrent.textContent = formatTime(audio.currentTime);

    if (state.isPlaying && audio.currentTime > state.lastTimeupdateSec) {
      const delta = audio.currentTime - state.lastTimeupdateSec;
      if (delta > 0 && delta < 2) {
        state.sessionListenedSec += delta;
      }
    }
    state.lastTimeupdateSec = audio.currentTime;

    const now = Date.now();
    if (now - state.lastSaveAt > CONFIG.AUTOSAVE_MS) {
      state.lastSaveAt = now;
      persistPlaybackPosition();
      apiCall('/api/state-sync', {
        method: 'POST',
        body: JSON.stringify({
          device_id: getDeviceId(),
          last_track_id: state.currentTrack?.id || null,
          last_position_sec: audio.currentTime || 0,
          shuffle_enabled: state.shuffle ? 1 : 0,
          repeat_mode: state.repeatMode,
          volume: audio.volume,
          playback_speed: audio.playbackRate,
        }),
      });
    }
  });

  audio.addEventListener('ended', () => {
    if (state.currentTrack) {
      markPlayed(state.currentTrack);
      flushPlayEvent({ completed: true, source: 'auto' });
    }
    if (state.repeatMode === 'one') {
      audio.currentTime = 0;
      audio.play().catch(() => {});
      return;
    }
    goNext({ auto: true });
  });

  window.addEventListener('beforeunload', persistPlaybackPosition);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) persistPlaybackPosition();
  });

  let isScrubbing = false;
  dom.seekbar.addEventListener('input', () => {
    isScrubbing = true;
    const pct = audio.duration ? (dom.seekbar.value / audio.duration) * 100 : 0;
    dom.seekbar.style.setProperty('--pct', pct + '%');
    dom.timeCurrent.textContent = formatTime(Number(dom.seekbar.value));
  });
  dom.seekbar.addEventListener('change', () => {
    audio.currentTime = Number(dom.seekbar.value);
    isScrubbing = false;
  });

  function updateVolumeUI() {
    dom.volumeSlider.value = String(audio.volume);
    dom.volumeSlider.style.setProperty('--vpct', (audio.volume * 100) + '%');
    const muted = audio.muted || audio.volume === 0;
    dom.iconVolUp.classList.toggle('hidden', muted);
    dom.iconVolMute.classList.toggle('hidden', !muted);
  }

  /* ------------------------------------------------------------------ */
  /* 10. NOW-PLAYING RENDER                                              */
  /* ------------------------------------------------------------------ */
  function renderNowPlaying() {
    const t = state.currentTrack;
    if (!t) return;
    dom.trackTitle.textContent = t.title;
    dom.trackArtist.textContent = t.artist || 'अज्ञात गायक';
    dom.trackYearAlbum.textContent = [t.album, t.year].filter(Boolean).join(' · ') || '—';
    dom.discInitial.textContent = (t.title || '?').trim().charAt(0).toUpperCase() || '?';
    dom.timeDuration.textContent = t.duration ? formatTime(t.durationSeconds) : '00:00';
  }

  /* ------------------------------------------------------------------ */
  /* 11. PLAYLIST RENDER (search + incremental "virtual-ish" scroll)     */
  /* ------------------------------------------------------------------ */
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function applySearch(query) {
    const q = (query || dom.searchInput.value || '').trim().toLowerCase();
    let baseList = state.allTracks;

    if (state.currentView === 'favorites') {
      baseList = state.allTracks.filter((t) => state.favorites.has(t.id));
    } else if (state.currentView === 'top') {
      baseList = [...state.allTracks].sort((a, b) => {
        const countA = state.trackStats.get(a.id)?.play_count || 0;
        const countB = state.trackStats.get(b.id)?.play_count || 0;
        return countB - countA;
      });
    }

    state.filtered = !q ? baseList : baseList.filter((t) =>
      t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q) || t.album.toLowerCase().includes(q));
    renderList(true);
  }

  function updateLikeUI() {
    const isLiked = !!(state.currentTrack && state.favorites.has(state.currentTrack.id));
    if (dom.likeBtn) dom.likeBtn.setAttribute('aria-pressed', String(isLiked));
  }

  function updateRowLikes(trackId) {
    const rows = dom.listRows.children;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.dataset.id === trackId) {
        const likeBtn = row.querySelector('.row__like');
        if (likeBtn) likeBtn.classList.toggle('liked', state.favorites.has(trackId));
      }
    }
  }

  function renderList(reset = false) {
    if (reset) {
      dom.listRows.innerHTML = '';
      state.renderCount = 0;
    }
    dom.listCount.textContent = `${state.filtered.length} गीत`;
    dom.listEmpty.classList.toggle('hidden', state.filtered.length !== 0);

    const nextSlice = state.filtered.slice(state.renderCount, state.renderCount + CONFIG.PAGE_SIZE);
    const frag = document.createDocumentFragment();
    nextSlice.forEach((track, i) => frag.appendChild(buildRow(track, state.renderCount + i)));
    dom.listRows.appendChild(frag);
    state.renderCount += nextSlice.length;
  }

  function buildRow(track, index) {
    const row = document.createElement('div');
    row.className = 'row' + (state.currentTrack && state.currentTrack.id === track.id ? ' active' : '');
    row.setAttribute('role', 'listitem');
    row.dataset.id = track.id;

    const idxCell = document.createElement('div');
    idxCell.className = 'row__index';
    if (state.currentTrack && state.currentTrack.id === track.id && state.isPlaying) {
      idxCell.innerHTML = '<span class="eq"><span></span><span></span><span></span></span>';
    } else {
      idxCell.textContent = String(index + 1);
    }

    const main = document.createElement('div');
    main.className = 'row__main';
    const title = document.createElement('p');
    title.className = 'row__title';
    title.textContent = track.title;
    const sub = document.createElement('p');
    sub.className = 'row__sub';
    sub.textContent = [track.artist, track.album].filter(Boolean).join(' — ');
    main.append(title, sub);

    const year = document.createElement('div');
    year.className = 'row__year';
    year.textContent = track.year || '';

    const dur = document.createElement('div');
    dur.className = 'row__duration';
    dur.textContent = track.duration || '';

    const likeBtn = document.createElement('button');
    likeBtn.className = 'row__like' + (state.favorites.has(track.id) ? ' liked' : '');
    likeBtn.type = 'button';
    likeBtn.title = 'पसंदीदा';
    likeBtn.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 17.25s-6.25-4-7.5-7.25c-1-2.6.5-5.5 3.25-6 2.25-.4 3.75 1 4.25 1.75C10.5 5 12 3.6 14.25 4c2.75.5 4.25 3.4 3.25 6-1.25 3.25-7.5 7.25-7.5 7.25Z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/></svg>';
    likeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavorite(track.id);
    });

    row.append(idxCell, main, year, dur, likeBtn);
    return row;
  }

  // Updates just the previously/currently active rows already in the DOM —
  // avoids re-rendering the whole (possibly long) list on every play/pause.
  function updateActiveRowIndicator() {
    const rows = dom.listRows.children;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const isActive = !!(state.currentTrack && row.dataset.id === state.currentTrack.id);
      const wasActive = row.classList.contains('active');
      if (!isActive && !wasActive) continue; // nothing to touch on this row
      row.classList.toggle('active', isActive);
      const idxCell = row.querySelector('.row__index');
      if (!idxCell) continue;
      if (isActive && state.isPlaying) {
        idxCell.innerHTML = '<span class="eq"><span></span><span></span><span></span></span>';
      } else {
        idxCell.textContent = String(i + 1);
      }
    }
  }

  dom.listRows.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    const track = state.byId.get(row.dataset.id);
    if (track) loadTrack(track, { autoplay: true, pushHistory: true });
  });

  dom.searchInput.addEventListener('input', debounce((e) => applySearch(e.target.value), 150));

  // Poor-man's virtual scroll: grow the rendered slice as the sentinel
  // nears the viewport, instead of paginating thousands of DOM rows at once.
  const io = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && state.renderCount < state.filtered.length) renderList(false);
  }, { root: null, rootMargin: '200px' });
  io.observe(dom.listSentinel);

  /* ------------------------------------------------------------------ */
  /* 12. MEDIA SESSION (lock screen / notification controls)             */
  /* ------------------------------------------------------------------ */
  function updateMediaSessionMetadata() {
    if (!('mediaSession' in navigator) || !state.currentTrack) return;
    const t = state.currentTrack;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist || 'Geetmala', album: t.album || 'Geetmala',
    });
  }

  function updateMediaSessionPosition() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    if (!isFinite(audio.duration) || audio.duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: audio.duration, playbackRate: audio.playbackRate, position: audio.currentTime,
      });
    } catch { /* some browsers reject edge-case values */ }
  }

  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', () => audio.play().catch(() => {}));
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('previoustrack', goPrev);
    navigator.mediaSession.setActionHandler('nexttrack', () => goNext());
    navigator.mediaSession.setActionHandler('seekbackward', () => seekBy(-CONFIG.SEEK_STEP_BTN));
    navigator.mediaSession.setActionHandler('seekforward', () => seekBy(CONFIG.SEEK_STEP_BTN));
  }

  /* ------------------------------------------------------------------ */
  /* 13. BUTTON BINDINGS                                                 */
  /* ------------------------------------------------------------------ */
  dom.playBtn.addEventListener('click', playPause);
  dom.nextBtn.addEventListener('click', () => goNext());
  dom.prevBtn.addEventListener('click', goPrev);
  dom.forwardBtn.addEventListener('click', () => seekBy(CONFIG.SEEK_STEP_BTN));
  dom.rewindBtn.addEventListener('click', () => seekBy(-CONFIG.SEEK_STEP_BTN));
  dom.shuffleBtn.addEventListener('click', toggleShuffle);
  dom.repeatBtn.addEventListener('click', cycleRepeat);
  dom.muteBtn.addEventListener('click', toggleMute);
  dom.volumeSlider.addEventListener('input', (e) => setVolume(Number(e.target.value)));
  dom.speedSelect.addEventListener('change', (e) => setSpeed(Number(e.target.value)));
  dom.likeBtn?.addEventListener('click', () => {
    if (state.currentTrack) toggleFavorite(state.currentTrack.id);
  });

  dom.listTabs?.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    const view = btn.dataset.view;
    if (view === state.currentView) return;
    state.currentView = view;
    Array.from(dom.listTabs.children).forEach((b) => b.classList.toggle('tab--active', b === btn));
    applySearch(dom.searchInput.value);
  });

  /* ------------------------------------------------------------------ */
  /* 14. KEYBOARD SHORTCUTS                                              */
  /* ------------------------------------------------------------------ */
  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (dom.app.classList.contains('hidden')) return;

    switch (e.key) {
      case ' ': e.preventDefault(); playPause(); break;
      case 'ArrowLeft': seekBy(-CONFIG.SEEK_STEP_KEY); break;
      case 'ArrowRight': seekBy(CONFIG.SEEK_STEP_KEY); break;
      case 'ArrowUp': e.preventDefault(); setVolume(audio.volume + CONFIG.VOLUME_STEP); break;
      case 'ArrowDown': e.preventDefault(); setVolume(audio.volume - CONFIG.VOLUME_STEP); break;
      case 'm': case 'M': toggleMute(); break;
      case 'l': case 'L': if (state.currentTrack) toggleFavorite(state.currentTrack.id); break;
      case 'n': case 'N': goNext(); break;
      case 's': case 'S': toggleShuffle(); break;
      case 'r': case 'R': cycleRepeat(); break;
      default: break;
    }
  });

  /* ------------------------------------------------------------------ */
  /* 15. BOOT                                                            */
  /* ------------------------------------------------------------------ */
  if (isAuthed()) {
    dom.gate.classList.add('hidden');
    dom.app.classList.remove('hidden');
    bootLibrary();
  } else {
    dom.gatePassword.focus();
  }
})();
