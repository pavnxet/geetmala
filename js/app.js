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
  };

  /* ------------------------------------------------------------------ */
  /* 2. DOM refs                                                        */
  /* ------------------------------------------------------------------ */
  const $ = (id) => document.getElementById(id);

  const dom = {
    gate: $('gate'), gateForm: $('gateForm'), gatePassword: $('gatePassword'), gateError: $('gateError'),
    app: $('app'), logoutBtn: $('logoutBtn'), libraryStatus: $('libraryStatus'),

    disc: $('vinylDisc'), discInitial: $('discInitial'), tonearm: $('tonearm'),
    trackYearAlbum: $('trackYearAlbum'), trackTitle: $('trackTitle'), trackArtist: $('trackArtist'),

    seekbar: $('seekbar'), timeCurrent: $('timeCurrent'), timeDuration: $('timeDuration'),

    shuffleBtn: $('shuffleBtn'), prevBtn: $('prevBtn'), rewindBtn: $('rewindBtn'),
    playBtn: $('playBtn'), iconPlay: $('iconPlay'), iconPause: $('iconPause'),
    forwardBtn: $('forwardBtn'), nextBtn: $('nextBtn'),
    repeatBtn: $('repeatBtn'), repeatOneDot: $('repeatOneDot'),

    muteBtn: $('muteBtn'), iconVolUp: $('iconVolUp'), iconVolMute: $('iconVolMute'),
    volumeSlider: $('volumeSlider'), speedSelect: $('speedSelect'),
    queueStatus: $('queueStatus'),

    searchInput: $('searchInput'), listCount: $('listCount'),
    listScroll: $('listScroll'), listRows: $('listRows'), listEmpty: $('listEmpty'), listSentinel: $('listSentinel'),

    toastHost: $('toastHost'),
  };

  const audio = new Audio();
  audio.preload = 'metadata';

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

  async function sha256Hex(text) {
    if (!window.isSecureContext || !window.crypto?.subtle) {
      throw new Error('insecure-context');
    }
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function safeGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
  function safeSet(key, val) { try { localStorage.setItem(key, val); } catch { /* storage full/blocked */ } }
  function safeRemove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } }

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
        renderList(true);
        maybeOfferResume();
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

  function persistPlayedIds() {
    safeSet(KEYS.PLAYED, JSON.stringify([...state.playedIds]));
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

  function pickRandomUnplayed() {
    let pool = remainingQueue();
    if (pool.length === 0) {
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
  /* 9. AUDIO ENGINE                                                     */
  /* ------------------------------------------------------------------ */
  function loadTrack(track, { resumeAt = 0, autoplay = false, pushHistory = false } = {}) {
    if (!track) return;
    state.currentTrack = track;
    audio.src = track.url;
    audio.currentTime = resumeAt || 0;

    if (pushHistory) {
      state.history = state.history.slice(0, state.historyPointer + 1);
      state.history.push(track.id);
      state.historyPointer = state.history.length - 1;
    }

    renderNowPlaying();
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
    const next = state.shuffle ? pickRandomUnplayed() : pickNextSequential();
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
  }

  function cycleRepeat() {
    state.repeatMode = { off: 'all', all: 'one', one: 'off' }[state.repeatMode];
    safeSet(KEYS.REPEAT, state.repeatMode);
    applyRepeatUI();
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

    const now = Date.now();
    if (now - state.lastSaveAt > CONFIG.AUTOSAVE_MS) {
      state.lastSaveAt = now;
      persistPlaybackPosition();
    }
  });

  audio.addEventListener('ended', () => {
    if (state.currentTrack) markPlayed(state.currentTrack);
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
    const q = query.trim().toLowerCase();
    state.filtered = !q ? state.allTracks : state.allTracks.filter((t) =>
      t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q) || t.album.toLowerCase().includes(q));
    renderList(true);
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

    row.append(idxCell, main, year, dur);
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
