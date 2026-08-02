# Geetmala — Vintage Web Music Player

A lightweight, 100% client-side web music player with a dark brass/amber glassmorphic UI. Parses track libraries from CSV metadata, streams directly from public audio URLs (such as Archive.org), and features smart non-repeating shuffle, background pre-buffering, favorites/likes, and optional Cloudflare Worker + Turso DB cloud synchronization.

> ⚠️ **Disclaimer:** This project only indexes publicly available data and links. It does **not** host, store, or upload any audio files or copyrighted content on this repository or server. All audio media is streamed directly from external, publicly accessible third-party sources (such as Archive.org).

Made with 💖 by [pavnxet](https://github.com/pavnxet)

---

## 🌟 Live Demo

- **Live Application**: [https://pavnxet.github.io/geetmala/](https://pavnxet.github.io/geetmala/)
- **Unlock Password**: `pavneet`

---

## ✨ Features

- 🔐 **Password Gate**: Soft client-side entry gate using SHA-256 password verification with automatic Web Crypto / JavaScript fallback.
- 🔀 **Smart Non-Repeating Shuffle**: Plays through your entire song library without repeating any song until every track has been played.
- ⚡ **Seamless Background Preloader**: Monitors active audio buffering and pre-loads the upcoming song in the background *only when* the current song finishes downloading—delivering 0-pause playback.
- 💖 **Favorites & Likes**: Heart toggle buttons in both the Now Playing panel and playlist rows.
- 📊 **Playlist Filtering & Most-Played View**: Tab filters for `[ All ]`, `[ Favorites ]`, and `[ Most Played ]` (ranks songs by your actual listening time).
- ☁️ **Cloud Synchronization**: Optional backend sync via Cloudflare Workers and Turso (libSQL) database for multi-device favorites, stats, and playback state.
- 📶 **100% Offline / Local Fallback**: Graceful degradation—if offline or if the backend API is unreachable, the app functions flawlessly using `localStorage`.
- 📱 **Media Session API**: Full mobile lock screen and notification shade playback controls.
- ⌨️ **Keyboard Shortcuts**:
  - `Space` — Play / Pause
  - `←` / `→` — Seek 5 seconds back / forward
  - `↑` / `↓` — Adjust volume
  - `M` — Mute / Unmute
  - `L` — Toggle Favorite / Liked status
  - `N` — Next track
  - `S` — Toggle Smart Shuffle
  - `R` — Cycle Repeat Mode (Off → All → One)
- 💾 **State Auto-Save**: Automatically remembers last played track, time position, volume, playback speed (0.75x–2.0x), and queue history.

---

## 📁 Repository Structure

```
geetmala/
├── index.html                  # Main application layout & password gate UI
├── css/style.css               # Dark glassmorphic vintage theme (Lora & Sora fonts)
├── js/app.js                   # Client logic (Audio engine, preloader, search, sync)
├── data/songs.csv              # Track library database (ID, Title, Album, Artist, Year, Duration, URL)
├── geetmala-backend/           # Cloudflare Worker & Turso Database Backend
│   ├── src/index.js            # Zero-dependency native fetch REST API worker
│   ├── schema.sql              # Turso database SQL schema
│   ├── wrangler.toml           # Cloudflare Worker configuration
│   └── package.json            # Dependencies configuration
└── README.md                   # Documentation
```

---

## ⚙️ Configuration & Customization

### 1. Adding Your Own Songs
Update [`data/songs.csv`](file:///e:/Codes/geetmala/data/songs.csv) using the following CSV column format:

```csv
id,title,album,artist,year,duration,url
1,"Jane Na Nazar","Geetmala Vol 01","Lata Mangeshkar",1951,"03:15","https://archive.org/download/.../0101.mp3"
```

### 2. Changing the Password
To change the unlock password, generate a SHA-256 hash of your desired password and update `CONFIG.PASSWORD_HASH` in [`js/app.js`](file:///e:/Codes/geetmala/js/app.js):

**Using Python:**
```bash
python -c "import hashlib; print(hashlib.sha256(b'YOUR_NEW_PASSWORD').hexdigest())"
```

Then update line 15 in `js/app.js`:
```javascript
PASSWORD_HASH: 'YOUR_GENERATED_SHA256_HASH',
```

---

## 🚀 Cloudflare Worker & Turso Backend Setup

If you want multi-device cloud synchronization for favorites and play counts:

1. **Turso Database**: Create a database on [turso.tech](https://turso.tech), run `geetmala-backend/schema.sql` in the SQL Editor, and copy your Database URL and Auth Token.
2. **Cloudflare Worker**: Create a Worker on [dash.cloudflare.com](https://dash.cloudflare.com), paste the code from [`geetmala-backend/src/index.js`](file:///e:/Codes/geetmala/geetmala-backend/src/index.js), and set your secrets (`API_KEY`, `TURSO_AUTH_TOKEN`, `TURSO_DATABASE_URL`).
3. **Connect Frontend**: Set your Worker URL in `CONFIG.API_BASE` in [`js/app.js`](file:///e:/Codes/geetmala/js/app.js).

---

## 📄 License

This project is open-source and free to use for personal and non-commercial music library management.
