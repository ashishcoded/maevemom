# 🎬 Maeve'mom v2 — Private Watch Party App

## Quick Start

```bash
cd maevemom
npm install
npm start
# → http://localhost:3000
```

---

## 🔑 Pre-seeded Accounts

| User    | Username | Password   | Color |
|---------|----------|------------|-------|
| Ashish  | ashish   | ashish123  | 🔴 Red |
| Disha   | disha    | disha123   | 🌸 Pink |

Click **Quick Login** buttons for instant 1-click sign in.

---

## 🧪 Testing Both Users Locally (Two-Tab Method)

**You don't need two computers!** Use two browser tabs (or two browsers):

### Method 1: Two Browser Tabs (Same Browser)
```
Tab 1: http://localhost:3000  → Login as ashish → Create Room → Copy Room ID
Tab 2: http://localhost:3000  → Login as disha  → Join Room  → Paste Room ID
```

### Method 2: Two Different Browsers
```
Chrome:  Login as ashish → Create Room
Firefox: Login as disha  → Join Room (paste the ID)
```

### Method 3: Incognito + Normal
```
Normal tab:    Login as ashish → Create Room
Incognito tab: Login as disha  → Join Room
```

> **Why it works:** Each tab has its own localStorage, so both users can be logged in simultaneously.

---

## ✅ All Features & Status

### Auth
- ✅ Login with username + password
- ✅ Register new accounts (username, display name, password)
- ✅ Quick login buttons (Ashish & Disha)
- ✅ JWT sessions (30-day tokens)
- ✅ Persistent login across page refresh
- ✅ Sign out

### Profile
- ✅ Edit display name
- ✅ Edit bio
- ✅ Upload profile photo (image file)
- ✅ Pick avatar color (6 color choices)
- ✅ Change password

### Rooms
- ✅ Create room (public or password-protected private)
- ✅ Join room by ID
- ✅ Shareable invite link (?room=ROOMID)
- ✅ Auto-join from invite link after login
- ✅ Copy Room ID / invite link / password
- ✅ Max 2 users enforced
- ✅ Leave room

### Video
- ✅ Load Vidking embed (movies + TV shows with season/episode)
- ✅ Load YouTube URLs (auto-converts to embed)
- ✅ Load Vimeo URLs (auto-converts to embed)
- ✅ Load any iframe-embeddable URL
- ✅ Load direct video files (.mp4, .webm, .mkv, .m4v, etc.)
- ✅ Numeric ID → auto Vidking movie embed
- ✅ 6 quick picks (Money Heist, Hail Mary, Breaking Bad, Squid Game, Rick & Morty, Avengers)
- ✅ Quick pick auto-fills correct season/episode URLs
- ✅ URL preview with title/source before loading
- ✅ Video loads for BOTH users simultaneously

### Upload
- ✅ Upload video files from your computer in sequential 8 MiB chunks (server limit 20 GiB; library budget 12 GiB by default)
- ✅ Real-time upload progress bar
- ✅ Uploaded videos listed in Media tab
- ✅ Click any uploaded video to play it for both users
- ✅ Broadcast to partner when new video is uploaded

### Sync
- ✅ Play/pause sync (native video files)
- ✅ Seek sync (native video files)
- ✅ PostMessage sync for iframe embeds (Vidking)
- ✅ YouTube iframe API sync events
- ✅ Auto-sync newcomer to current video + sync state on join

### Chat
- ✅ Real-time messages
- ✅ Typing indicators
- ✅ Chat history preserved (last 100 messages)
- ✅ System messages (join/leave/video change)
- ✅ No duplicate messages (deduplication fixed)
- ✅ Enter to send, Shift+Enter for newline
- ✅ Auto-resize textarea

### Emoji Reactions
- ✅ 8 emoji buttons (❤️ 😂 😍 😮 🔥 👏 🍿 💕)
- ✅ Float-up animation for both users
- ✅ Real-time sync to partner

### Connection
- ✅ Auto-reconnect on disconnect
- ✅ Rejoin room after reconnect
- ✅ Online/offline status dots update in real-time
- ✅ User count (X/2) live updates

---

## 🐛 Bugs Fixed in v2

1. **room_update wrong isHost** — Was sending disconnecting user's perspective to remaining user. Fixed: server now sends individual updates to each socket.
2. **TV show URLs wrong** — Quick picks had `/tv/46952` missing season/episode. Fixed: `/tv/46952/1/1`.
3. **togglePwField broken** — Password toggle had broken regex. Fixed: direct checkbox onchange handler.
4. **Duplicate chat messages** — Server broadcasts to all, client rendered optimistic + server echo = 2 messages. Fixed: own echoes skipped by userId check.
5. **Private room join loop** — Fetching room without password crashed. Fixed: server returns `needsPassword: true` without 4xx.
6. **seenMsgIds not cleared** — On room rejoin, old IDs blocked fresh messages. Fixed: cleared in enterRoom().
7. **onlineUsers duplicates** — Reconnect added userId twice. Fixed: includes() check before push.
8. **Username "aryan"** — Changed to "ashish" as requested.
9. **Host-only video load** — Removed restriction, both users can load video.
10. **No upload feature** — Added full video upload with XHR progress.
11. **No profile edit** — Full profile editing with avatar photo upload.
12. **No YouTube/Vimeo** — URL resolver now handles YouTube, Vimeo, direct files.
13. **No local testing guide** — Added two-tab method above.

---

## 🌐 Deploy Free

### Render.com
1. Push to GitHub
2. New Web Service → connect repo  
3. Build: `npm install` | Start: `npm start`
4. Done — share the URL!

### Railway.app  
Same — connect GitHub, auto-deploy.

### Environment Variables (optional)
```
JWT_SECRET=your_random_secret_here
PORT=3000
MAX_UPLOAD_BYTES=21474836480
MEDIA_BUDGET_BYTES=12884901888
FFMPEG_PATH=ffmpeg
STORAGE_DIR=/var/data
```

### Large files and movie formats

Uploads support common movie containers such as MP4, MKV, HEVC/H.265 files, AVI, MOV, M4V, TS/M2TS, WMV, FLV, MPEG and 3GP. Files are served with HTTP range requests, so playback seeks and buffers in chunks instead of downloading the whole movie first.

Browsers do not natively decode every codec (notably many MKV, HEVC/H.265 and AVI downloads). Install [FFmpeg](https://ffmpeg.org/download.html) on the server and ensure `ffmpeg` is on `PATH`, or set `FFMPEG_PATH` to its executable. The app then creates a browser-compatible H.264/AAC MP4 stream automatically when the original cannot play. Conversion runs after upload and can take time for very large movies; upload progress remains separate from conversion progress.

For hosted installs, mount a persistent volume and set `STORAGE_DIR` to its mount path. The video files and library index are stored there. Without a persistent volume, the platform may erase uploads on restart or redeploy, and platform-level upload/disk limits may be lower than the app limits above.

---

Made with ♥ — Maeve'mom
