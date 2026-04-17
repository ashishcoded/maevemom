# 🚀 Free Deployment Guide — Maeve'mom

## TL;DR — Best Options Ranked

| Method | Cost | Difficulty | Persistent URL | Best For |
|--------|------|------------|----------------|----------|
| **Render.com** | Free | ⭐ Easy | ✅ Yes | Best overall |
| **Railway.app** | Free tier | ⭐ Easy | ✅ Yes | Fast deploy |
| **Cloudflare Tunnel** | Free | ⭐⭐ Medium | ✅ Yes | Local → public |
| **ngrok** | Free tier | ⭐ Easiest | ❌ Changes each time | Quick testing |

---

## Option 1 — Render.com (RECOMMENDED — fully free)

**Best for:** Permanent deployment you share with your partner.

```bash
# 1. Push to GitHub (one time setup)
git init
git add .
git commit -m "Maeve'mom"
git remote add origin https://github.com/YOURNAME/maevemom.git
git push -u origin main

# 2. Go to https://render.com → New → Web Service
# 3. Connect your GitHub repo
# 4. Settings:
#    - Build Command: npm install
#    - Start Command: npm start
#    - Environment: Node
# 5. Click Deploy
# 6. You get a URL like: https://maevemom.onrender.com
```

**Free tier limits:** Sleeps after 15 min inactivity (wakes in ~30s). For always-on: keep a browser tab open or use UptimeRobot to ping it every 10 min.

---

## Option 2 — Railway.app (Free $5 credit/month)

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login and deploy
railway login
railway init
railway up

# Get your URL
railway domain
```

---

## Option 3 — Cloudflare Tunnel (FREE + permanent URL from localhost)

**Best for:** Running on YOUR computer and exposing it to the internet permanently.

```bash
# 1. Install cloudflared
# Windows: winget install --id Cloudflare.cloudflared
# Mac:     brew install cloudflare/cloudflare/cloudflared
# Linux:   Download from https://github.com/cloudflare/cloudflared/releases

# 2. Login (free Cloudflare account needed)
cloudflared tunnel login

# 3. Create a tunnel (one time)
cloudflared tunnel create maevemom

# 4. Create config file: ~/.cloudflared/config.yml
# url: http://localhost:3000
# tunnel: YOUR_TUNNEL_ID
# credentials-file: /path/to/.cloudflared/TUNNEL_ID.json

# 5. Start your app + tunnel
npm start &
cloudflared tunnel run maevemom

# You get a permanent URL like: https://maevemom.example.cloudflare.com
```

**Why Cloudflare Tunnel is great:**
- Completely free
- Permanent HTTPS URL (not random like ngrok free tier)
- Works through NAT/firewall — no port forwarding needed
- Low latency since traffic goes through Cloudflare's edge

---

## Option 4 — ngrok (Quickest for testing)

```bash
# 1. Download ngrok: https://ngrok.com/download
# 2. Sign up free (get authtoken)
ngrok authtoken YOUR_TOKEN

# 3. Start app and expose
npm start &
ngrok http 3000

# You get a URL like: https://abc123.ngrok-free.app
# ⚠️ URL changes every session on free tier
```

---

## Testing Locally (Two Users on Same Machine)

No deployment needed! Just:

```bash
npm start
# Open Chrome (normal): login as ashish → Create Room
# Open Chrome (Incognito): login as disha → Join Room with Room ID
```

Each tab has separate localStorage so both sessions work independently.

---

## Environment Variables (for deployment)

Create a `.env` file or set in your hosting dashboard:

```
JWT_SECRET=your_random_secret_here_make_it_long
PORT=3000
```

---

## Quick Start

```bash
cd maevemom2
npm install
npm start
# → http://localhost:3000
```

**Accounts:** ashish/ashish123 · disha/disha123
