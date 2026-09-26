require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const { spawn }  = require('child_process');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  pingTimeout: 25000,
  pingInterval: 8000,
  transports: ['websocket', 'polling'],
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));

const JWT_SECRET = process.env.JWT_SECRET || 'maevemom_v5_9Tz4Rp2X';
const PORT = process.env.PORT || 3000;
const MEDIA_BUDGET_BYTES = Number(process.env.MEDIA_BUDGET_BYTES || (12 * 1024 * 1024 * 1024));
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || (20 * 1024 * 1024 * 1024));
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const VIDEO_EXTENSIONS = new Set(['.mp4','.m4v','.webm','.mkv','.mov','.avi','.ogv','.ogg','.mpg','.mpeg','.m2ts','.mts','.ts','.wmv','.flv','.3gp','.3g2','.asf','.divx','.f4v','.vob','.rm','.rmvb']);
const NATIVE_VIDEO_EXTENSIONS = new Set(['.mp4','.m4v','.webm','.ogv']);

// ── Uploads ────────────────────────────────────────────────────────────────────
const storageRoot = process.env.STORAGE_DIR || '';
const uploadsDir = process.env.MEDIA_DIR || (storageRoot ? path.join(storageRoot, 'uploads') : path.join(__dirname, '../public/uploads'));
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const dataDir = process.env.DATA_DIR || storageRoot || path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const libraryFile = path.join(dataDir, 'libraries.json');
const alertContactsFile = path.join(dataDir, 'alert-contacts.json');
const profileFile = path.join(dataDir, 'profiles.json');
const deviceSessionsFile = path.join(dataDir, 'device-sessions.json');

const mkStore = pfx => multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadsDir),
  filename:    (_, f, cb) => cb(null, (pfx||'')+uuidv4()+path.extname(f.originalname).toLowerCase())
});
const uploadVideo  = multer({
  storage: mkStore(),
  limits:{ fileSize: MAX_UPLOAD_BYTES },
  fileFilter:(_,f,cb)=>{
    const extension = path.extname(f.originalname).toLowerCase();
    cb(null, VIDEO_EXTENSIONS.has(extension) || String(f.mimetype || '').startsWith('video/'));
  }
});
const uploadAvatar = multer({ storage: mkStore('av_'), limits:{ fileSize: 8*1024*1024 }, fileFilter:(_,f,cb)=>cb(null,f.mimetype.startsWith('image/')) });
const uploadChunkDir = path.join(uploadsDir, '.uploading');
if (!fs.existsSync(uploadChunkDir)) fs.mkdirSync(uploadChunkDir, { recursive:true });
const uploadSessions = new Map();
const MAX_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
for (const file of fs.readdirSync(uploadChunkDir)) {
  const filePath = path.join(uploadChunkDir, file);
  try { if (file.endsWith('.part')) fs.unlinkSync(filePath); } catch {}
}
const uploadCleanupTimer = setInterval(() => {
  const expiredBefore = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, session] of uploadSessions) {
    if (session.busy || session.updatedAt > expiredBefore) continue;
    uploadSessions.delete(id);
    fs.promises.unlink(session.tempPath).catch(() => {});
  }
}, 30 * 60 * 1000);
uploadCleanupTimer.unref?.();

// ── Stores ─────────────────────────────────────────────────────────────────────
const users    = new Map(); // id → User
const rooms    = new Map(); // id → Room
const sessions = new Map(); // socketId → {userId, roomId}
const uSocks   = new Map(); // userId → Set of socketIds (handles multiple tabs)
const libraries = new Map(); // userId → saved media playlist
const alertContacts = new Map(); // userId → private saved alert contacts
const alertSendTimes = new Map();
const userProfiles = new Map();
const deviceSessions = new Map();
const profilePinFailures = new Map();

function readJsonMap(file) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : {}; }
  catch (error) { console.error(`Failed to load ${path.basename(file)}:`,error.message); return {}; }
}
function saveProfiles() { fs.writeFileSync(profileFile,JSON.stringify(Object.fromEntries(userProfiles),null,2),'utf8'); }
function saveDeviceSessions() { fs.writeFileSync(deviceSessionsFile,JSON.stringify(Object.fromEntries(deviceSessions),null,2),'utf8'); }
function disconnectDeviceSession(sessionId) {
  deviceSessions.delete(sessionId);
  for(const socket of io.sockets.sockets.values()) if(socket.userData?.sid===sessionId) socket.disconnect(true);
}
const safeProfileColor = value => /^#[0-9a-f]{6}$/i.test(String(value||'')) ? String(value) : '#e50914';
const safeAvatarKey = value => /^(?:classic-(?:0[1-9]|1[0-5])|show-(?:0[1-9]|1[0-4]))$/.test(String(value||'')) ? String(value) : 'classic-01';
function ensureUserProfiles(userId) {
  const user=users.get(userId); if(!user) return [];
  if(!userProfiles.has(userId) || !userProfiles.get(userId).length) {
    const restored=readJsonMap(profileFile)[userId];
    const list=Array.isArray(restored) ? restored : [];
    if(!list.length) list.push({id:'profile_'+uuidv4().replace(/-/g,'').slice(0,12),name:user.displayName,avatarKey:'classic-01',avatarColor:user.avatarColor,avatarUrl:user.avatarUrl||null,pinHash:null,createdAt:Date.now()});
    userProfiles.set(userId,list); saveProfiles();
  }
  return userProfiles.get(userId);
}
function publicProfile(profile) {
  const avatarKey=safeAvatarKey(profile.avatarKey);
  const avatarUrl=profile.avatarUrl || (avatarKey.startsWith('show-')?`/images/profile-avatars/${avatarKey}.png`:avatarKey.startsWith('classic-')?`/images/avatar/avatar-${avatarKey.slice(-2)}.png`:null);
  return {id:profile.id,name:profile.name,avatarKey,avatarColor:safeProfileColor(profile.avatarColor),avatarUrl,locked:!!profile.pinHash,createdAt:profile.createdAt};
}
function profileUser(userId,profileId) {
  const user=users.get(userId); if(!user) return null;
  const profile=ensureUserProfiles(userId).find(item=>item.id===profileId) || ensureUserProfiles(userId)[0];
  const emoji=String(profile.avatarEmoji||'');
  const avatarKey=safeAvatarKey(profile.avatarKey),avatarUrl=profile.avatarUrl || (avatarKey.startsWith('show-')?`/images/profile-avatars/${avatarKey}.png`:avatarKey.startsWith('classic-')?`/images/avatar/avatar-${avatarKey.slice(-2)}.png`:user.avatarUrl || null);
  return {...uPub(user),profileId:profile.id,profileAvatarKey:avatarKey,displayName:profile.name,avatar:emoji.length<=8&&!/[<>&"'`]/.test(emoji)?emoji:user.avatar,avatarColor:safeProfileColor(profile.avatarColor),avatarUrl};
}
function createSessionToken(userId,profileId,req,sessionId=null) {
  const id=sessionId || uuidv4();
  const existing=deviceSessions.get(id);
  deviceSessions.set(id,{id,userId,profileId,createdAt:existing?.createdAt || Date.now(),lastActive:Date.now(),userAgent:String(req.headers['user-agent'] || 'Unknown device').slice(0,240)});
  saveDeviceSessions();
  return jwt.sign({userId,profileId,sid:id},JWT_SECRET,{expiresIn:'30d'});
}
for (const [id,record] of Object.entries(readJsonMap(deviceSessionsFile))) if(record?.userId) deviceSessions.set(id,{...record,id});
for (const [id,list] of Object.entries(readJsonMap(profileFile))) if(Array.isArray(list)) userProfiles.set(id,list);

function loadAlertContacts() {
  try {
    if (!fs.existsSync(alertContactsFile)) return;
    const raw = JSON.parse(fs.readFileSync(alertContactsFile, 'utf8'));
    for (const [userId, contacts] of Object.entries(raw || {}))
      alertContacts.set(userId, Array.isArray(contacts) ? contacts : []);
  } catch (error) { console.error('Failed to load alert contacts:', error.message); }
}
function saveAlertContacts() {
  const output = Object.fromEntries(alertContacts);
  fs.writeFileSync(alertContactsFile, JSON.stringify(output, null, 2), 'utf8');
}
function getAlertContacts(userId) {
  if (!alertContacts.has(userId)) alertContacts.set(userId, []);
  return alertContacts.get(userId);
}
function normalizeAlertPhone(value) {
  const raw = String(value || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (!/^\+?[\d\s().-]+$/.test(raw)) return null;
  let normalized = digits;
  if (!raw.startsWith('+') && digits.length === 10) normalized = '91' + digits;
  if (normalized.length < 8 || normalized.length > 15 || normalized[0] === '0') return null;
  return '+' + normalized;
}
// Messaging adapters plug in here. No provider is configured by default.
async function sendAlertWithProvider() {
  if (process.env.WHATSAPP_PROVIDER_URL && process.env.WHATSAPP_PROVIDER_TOKEN)
    return { configured:false, provider:'whatsapp', error:'WhatsApp adapter is not installed.' };
  if (process.env.SMS_PROVIDER_URL && process.env.SMS_PROVIDER_TOKEN)
    return { configured:false, provider:'sms', error:'SMS adapter is not installed.' };
  return { configured:false, provider:null };
}

// ── Seed ───────────────────────────────────────────────────────────────────────
(async () => {
  const mk = async (id, uname, dname, color, bio, pw) =>
    users.set(id, { id, username:uname, displayName:dname, avatar:dname[0].toUpperCase(),
      avatarColor:color, avatarUrl:null, bio, passwordHash:await bcrypt.hash(pw,10), createdAt:Date.now() });
  await mk('user_ashish','ashish','Ashish',   '#e50914','The Owner \uD83C\uDFAC','ashish123');
  await mk('user_disha', 'disha', 'Disha \u2728','#ff6b9d','The Co-star \uD83D\uDC95','disha123');
  console.log('\u2705 ashish/ashish123 | disha/disha123');
})();

function loadLibraries() {
  try {
    if (!fs.existsSync(libraryFile)) return;
    const raw = JSON.parse(fs.readFileSync(libraryFile, 'utf8'));
    for (const [userId, items] of Object.entries(raw || {})) {
      libraries.set(userId, Array.isArray(items) ? items.map((item, idx) => ({
        id: item.id || uuidv4().slice(0, 8),
        ownerId: item.ownerId || userId,
        filename: item.filename,
        originalName: item.originalName || item.filename || 'Video',
        url: item.url || (item.filename ? '/uploads/' + item.filename : ''),
        size: Number(item.size) || 0,
        uploadedAt: Number(item.uploadedAt) || Date.now(),
        order: Number.isFinite(item.order) ? item.order : idx,
      })) : []);
    }
  } catch (e) {
    console.error('Failed to load media libraries:', e.message);
  }
}
function saveLibraries() {
  const out = {};
  for (const [userId, items] of libraries) out[userId] = items;
  const tempFile = libraryFile + '.tmp';
  try {
    fs.writeFileSync(tempFile, JSON.stringify(out, null, 2), 'utf8');
    fs.renameSync(tempFile, libraryFile);
  } catch (error) {
    try { fs.unlinkSync(tempFile); } catch {}
    throw error;
  }
}
function ensureLibrary(userId) {
  if (!libraries.has(userId)) libraries.set(userId, []);
  return libraries.get(userId);
}
function normalizeOrders(items) {
  items.forEach((item, idx) => { item.order = idx; });
}
function totalLibraryBytes() {
  let total = 0;
  for (const items of libraries.values()) total += items.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
  return total;
}
function budgetSummary(userId = null) {
  const used = totalLibraryBytes();
  const mine = userId ? ensureLibrary(userId).reduce((sum, item) => sum + (Number(item.size) || 0), 0) : 0;
  return {
    used,
    mine,
    total: MEDIA_BUDGET_BYTES,
    remaining: Math.max(0, MEDIA_BUDGET_BYTES - used),
    percent: MEDIA_BUDGET_BYTES ? Math.min(100, Math.round((used / MEDIA_BUDGET_BYTES) * 100)) : 0,
  };
}
function pubMediaItem(item) {
  const owner = users.get(item.ownerId);
  return {
    id: item.id,
    ownerId: item.ownerId,
    ownerName: owner ? owner.displayName : 'Unknown',
    ownerAvatar: owner ? owner.avatar : '?',
    ownerAvatarColor: owner ? owner.avatarColor : '#444',
    filename: item.filename,
    originalName: item.originalName,
    url: '/api/media/' + item.id + '/stream',
    compatibleUrl: '/api/media/' + item.id + '/stream?variant=compatible',
    requiresCompatibility: !NATIVE_VIDEO_EXTENSIONS.has(path.extname(item.filename || '').toLowerCase()),
    available: !!item.filename && fs.existsSync(path.join(uploadsDir, item.filename)),
    size: item.size,
    uploadedAt: item.uploadedAt,
    order: item.order,
  };
}

const transcodes = new Map();
function compatibleFilename(item) {
  return item.filename + '.compatible.mp4';
}
function findMediaItem(mediaId) {
  for (const items of libraries.values()) {
    const item = items.find(entry => entry.id === mediaId);
    if (item) return item;
  }
  return null;
}
function compatiblePath(item) {
  return path.join(uploadsDir, compatibleFilename(item));
}
function compatibleTempPath(item) {
  return path.join(uploadsDir, item.filename + '.converting.mp4');
}
function compatibleStatus(item) {
  if (!item) return { status:'missing' };
  const active = transcodes.get(item.id);
  if (active && active.status !== 'ready') return active;
  if (fs.existsSync(compatiblePath(item))) return { status:'ready' };
  return active || { status:'idle' };
}
function startCompatibleTranscode(item, { forceEncode = false } = {}) {
  const existing = transcodes.get(item.id);
  if (existing?.status === 'processing') return existing;
  if (!forceEncode) {
    const current = compatibleStatus(item);
    if (current.status !== 'idle') return current;
  }
  const source = path.join(uploadsDir, item.filename);
  if (!fs.existsSync(source)) return { status:'missing' };

  const state = { status:'processing', mode:forceEncode ? 'encode' : 'remux' };
  transcodes.set(item.id, state);
  const run = encode => {
    const output = compatibleTempPath(item);
    try { if (fs.existsSync(output)) fs.unlinkSync(output); } catch {}
    const args = encode
      ? ['-y','-i',source,'-map','0:v:0?','-map','0:a?','-c:v','libx264','-preset','veryfast','-crf','23','-c:a','aac','-b:a','160k','-movflags','+faststart',output]
      : ['-y','-i',source,'-map','0:v:0?','-map','0:a?','-c','copy','-movflags','+faststart',output];
    let child, spawnFailed = false;
    state.mode = encode ? 'encode' : 'remux';
    try { child = spawn(FFMPEG_PATH, args, { windowsHide:true, stdio:['ignore','ignore','ignore'] }); }
    catch (error) {
      state.status = 'unavailable'; state.error = error.message; return;
    }
    child.once('error', error => {
      spawnFailed = true;
      state.status = 'unavailable';
      state.error = error.message;
      try { if (fs.existsSync(output)) fs.unlinkSync(output); } catch {}
    });
    child.once('close', code => {
      if (spawnFailed) return;
      if (code === 0 && fs.existsSync(output)) {
        try {
          fs.renameSync(output, compatiblePath(item));
          transcodes.set(item.id, { status:'ready', mode:encode ? 'encode' : 'remux' });
        } catch (error) {
          transcodes.set(item.id, { status:'failed', error:'Could not save the converted video. Check server storage.' });
          try { if (fs.existsSync(output)) fs.unlinkSync(output); } catch {}
        }
      } else if (!encode) {
        try { if (fs.existsSync(output)) fs.unlinkSync(output); } catch {}
        run(true);
      } else {
        transcodes.set(item.id, { status:'failed', error:'FFmpeg could not convert this video.' });
        try { if (fs.existsSync(output)) fs.unlinkSync(output); } catch {}
      }
    });
  };
  run(forceEncode);
  return state;
}
function normalizeMediaDisplayName(rawName, fallbackName) {
  const fallback = String(fallbackName || 'Video').trim() || 'Video';
  const cleaned = String(rawName || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}
function renameLibraryItemForUser(userId, mediaId, nextName) {
  const library = ensureLibrary(userId);
  const item = library.find(entry => entry.id === mediaId);
  if (!item) return null;
  item.originalName = normalizeMediaDisplayName(nextName, item.originalName || item.filename);
  saveLibraries();
  refreshRoomsForUser(userId);
  return {
    ok:true,
    items: library.slice().sort((a,b)=>a.order-b.order).map(pubMediaItem),
    usage: budgetSummary(userId),
  };
}
function combinedRoomMedia(room) {
  const userIds = [room.ownerId, room.guestId].filter((id, idx, arr) => id && arr.indexOf(id) === idx);
  return userIds.flatMap((userId, slot) =>
    ensureLibrary(userId)
      .slice()
      .sort((a, b) => (a.order - b.order) || (a.uploadedAt - b.uploadedAt))
      .map((item, idx) => ({ ...pubMediaItem(item), roomSlot: slot, roomOrder: idx }))
  ).sort((a, b) => (a.roomSlot - b.roomSlot) || (a.roomOrder - b.roomOrder) || (a.uploadedAt - b.uploadedAt));
}
function emitRoomMedia(room) {
  io.to(room.id).emit('uploaded_videos_list', {
    items: combinedRoomMedia(room),
    usage: budgetSummary(),
  });
}
function refreshRoomsForUser(userId) {
  for (const room of rooms.values()) {
    if (room.ownerId === userId || room.guestId === userId) {
      emitRoomMedia(room);
      bcastRoom(room);
    }
  }
}
function activeRoomMediaForUser(userId) {
  for (const room of rooms.values()) {
    const isMember = room.ownerId === userId || room.guestId === userId;
    const isConnected = [...sessions.values()].some(session => session.userId === userId && session.roomId === room.id);
    if (isMember && isConnected) return combinedRoomMedia(room);
  }
  return null;
}
loadLibraries();
loadAlertContacts();

// ── Helpers ────────────────────────────────────────────────────────────────────
const uPub = u => ({ id:u.id, username:u.username, displayName:u.displayName,
  avatar:u.avatar, avatarColor:u.avatarColor, avatarUrl:u.avatarUrl||null, bio:u.bio });

// BUG FIX #5: rPub now always uses correct owner/guest from room state.
// The bug was: if guestId was set but the guest user object not found, it showed owner twice.
const rPub = (room, viewerId) => {
  const owner = users.get(room.ownerId);
  // FIX: only include guest if guestId is different from ownerId
  const guestId = room.guestId && room.guestId !== room.ownerId ? room.guestId : null;
  const guest   = guestId ? users.get(guestId) : null;
  return {
    id: room.id, name: room.name, isPrivate: room.isPrivate,
    owner: owner ? uPub(owner) : null,
    guest: guest ? uPub(guest) : null,
    isOwner: room.ownerId === viewerId,
    video:   room.video,
    sync:    room.sync,
    // BUG FIX #4: onlineUsers is now a de-duped array of unique userIds
    onlineUsers: [...new Set(room.onlineUsers)],
    uploadedVideos: combinedRoomMedia(room),
    mediaBudget: budgetSummary(viewerId),
    createdAt: room.createdAt
  };
};

// BUG FIX #4: Broadcast room_update with correct per-socket perspective
// Called AFTER socket.join() so all recipients are already in the IO room
function bcastRoom(room) {
  const seen = new Set();
  for (const [sid, sess] of sessions) {
    if (sess.roomId === room.id && !seen.has(sess.userId)) {
      seen.add(sess.userId);
      io.to(sid).emit('room_update', { room: rPub(room, sess.userId) });
    }
  }
}

function currentTime(room) {
  const s = room.sync;
  if (!s || !s.playing) return { playing:false, time: s ? s.time : 0 };
  return { playing:true,  time: s.time + (Date.now()-s.serverTs)/1000 };
}
function hasActiveRoomSocket(roomId, userId, ignoreSocketId = null) {
  for (const [sid, sess] of sessions) {
    if (sid === ignoreSocketId) continue;
    if (sess.roomId === roomId && sess.userId === userId) return true;
  }
  return false;
}
function releaseRoomSeat(room, userId, { intendedLeave = false, socketId = null } = {}) {
  room.onlineUsers = room.onlineUsers.filter(id => id !== userId);
  if (room.guestId === userId && intendedLeave) {
    room.guestId = null;
  }
  if (room.ownerId === userId && intendedLeave && room.onlineUsers.length) promoteOwner(room);
}
function pruneRoomMembership(room) {
  if (room.guestId === room.ownerId) room.guestId = null;
}

function promoteOwner(room) {
  if (room.onlineUsers.includes(room.ownerId)) return;
  const next = room.onlineUsers.find(id => id !== room.ownerId);
  if (!next) return;
  room.ownerId = next;
  const u = users.get(next);
  io.to(room.id).emit('owner_changed', { newOwnerId:next, user:uPub(u) });
  bcastRoom(room);
}

// ── Auth ───────────────────────────────────────────────────────────────────────
function authMw(req,res,next){
  const tok=req.headers.authorization?.split(' ')[1];
  if(!tok) return res.status(401).json({error:'No token'});
  try {
    req.user=jwt.verify(tok,JWT_SECRET);
    if(!req.user.sid) {
      const profileId=req.user.profileId || ensureUserProfiles(req.user.userId)[0]?.id;
      const sid=uuidv4(),replacement=createSessionToken(req.user.userId,profileId,req,sid);
      req.user={...req.user,sid,profileId};
      res.setHeader('X-Auth-Token',replacement);
    }
    if(req.user.sid) {
      const session=deviceSessions.get(req.user.sid);
      if(!session || session.userId!==req.user.userId) return res.status(401).json({error:'This session has been signed out'});
      if(Date.now()-session.lastActive>60000){session.lastActive=Date.now();saveDeviceSessions();}
    }
    next();
  }
  catch { res.status(401).json({error:'Invalid token'}); }
}

// ── Routes ─────────────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req,res) => {
  try {
    const {username,displayName,email,password}=req.body;
    if(!username||!displayName||!email||!password) return res.status(400).json({error:'All fields required'});
    if(password.length<6) return res.status(400).json({error:'Password 6+ chars'});
    if(!/^[a-z0-9_]{2,20}$/i.test(username)) return res.status(400).json({error:'Username: 2-20 chars (a-z 0-9 _)'});
    if([...users.values()].find(u=>u.username.toLowerCase()===username.toLowerCase())) return res.status(409).json({error:'Username taken'});
    const normalizedEmail=String(email).trim().toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizedEmail)) return res.status(400).json({error:'Enter a valid email address'});
    if([...users.values()].find(u=>u.email?.toLowerCase()===normalizedEmail)) return res.status(409).json({error:'Email address already in use'});
    const clrs=['#e50914','#ff6b9d','#f59e0b','#10b981','#6366f1','#ec4899','#06b6d4','#84cc16'];
    const id='user_'+uuidv4().replace(/-/g,'').slice(0,10);
    const user={id,username:username.toLowerCase(),email:normalizedEmail,displayName:displayName.trim(),
      avatar:displayName.trim()[0].toUpperCase(),
      avatarColor:clrs[Math.floor(Math.random()*clrs.length)],
      avatarUrl:null,bio:'Movie lover',
      passwordHash:await bcrypt.hash(password,10),createdAt:Date.now()};
    users.set(id,user);
    const profile=ensureUserProfiles(id)[0];
    const token=createSessionToken(id,profile.id,req);
    res.json({token,user:profileUser(id,profile.id)});
  } catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/auth/login', async (req,res) => {
  try {
    const {username,password}=req.body;
    if(!username||!password) return res.status(400).json({error:'Username and password required'});
    const user=[...users.values()].find(u=>u.username.toLowerCase()===username.toLowerCase());
    if(!user) return res.status(401).json({error:'User not found'});
    if(!await bcrypt.compare(password,user.passwordHash)) return res.status(401).json({error:'Wrong password'});
    const profile=ensureUserProfiles(user.id)[0];
    const token=createSessionToken(user.id,profile.id,req);
    res.json({token,user:profileUser(user.id,profile.id)});
  } catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/auth/me', authMw, (req,res) => {
  const u=users.get(req.user.userId);
  if(!u) return res.status(404).json({error:'Not found'});
  res.json({user:profileUser(u.id,req.user.profileId)});
});
app.get('/api/auth/account',authMw,(req,res)=>{
  const user=users.get(req.user.userId);
  if(!user)return res.status(404).json({error:'Not found'});
  res.json({username:user.username,email:user.email||null});
});
app.post('/api/auth/logout',authMw,(req,res)=>{
  if(req.user.sid){disconnectDeviceSession(req.user.sid);saveDeviceSessions();}
  res.json({ok:true});
});

app.get('/api/profiles',authMw,(req,res)=>res.json({profiles:ensureUserProfiles(req.user.userId).map(publicProfile),activeProfileId:req.user.profileId || null}));
app.post('/api/profiles',authMw,async(req,res)=>{
  const name=String(req.body.name||'').trim().replace(/\s+/g,' ').slice(0,24);
  const avatarKey=safeAvatarKey(req.body.avatarKey);
  const pin=String(req.body.pin||'');
  if(!name) return res.status(400).json({error:'Enter a profile name'});
  if(pin && !/^\d{4}$/.test(pin)) return res.status(400).json({error:'Profile PIN must be exactly 4 digits'});
  const profiles=ensureUserProfiles(req.user.userId);
  if(profiles.length>=10) return res.status(400).json({error:'You can create up to 10 profiles'});
  const profile={id:'profile_'+uuidv4().replace(/-/g,'').slice(0,12),name,avatarKey,avatarColor:safeProfileColor(req.body.avatarColor),avatarEmoji:String(req.body.avatarEmoji||'').slice(0,8),pinHash:pin ? await bcrypt.hash(pin,10) : null,createdAt:Date.now()};
  profiles.push(profile); saveProfiles(); res.json({profile:publicProfile(profile)});
});
app.post('/api/profiles/:id/activate',authMw,async(req,res)=>{
  const profile=ensureUserProfiles(req.user.userId).find(item=>item.id===req.params.id);
  if(!profile) return res.status(404).json({error:'Profile not found'});
  const attemptKey=`${req.user.userId}:${req.user.sid||'legacy'}:${profile.id}`,attempt=profilePinFailures.get(attemptKey);
  if(attempt?.lockedUntil>Date.now()) return res.status(429).json({error:'Too many incorrect PIN attempts. Try again in a minute.'});
  if(profile.pinHash && !await bcrypt.compare(String(req.body.pin||''),profile.pinHash)) {
    const failures=attempt?.lockedUntil>Date.now()?attempt.failures:attempt?.failures||0;
    profilePinFailures.set(attemptKey,{failures:failures+1,lockedUntil:failures+1>=5?Date.now()+60000:0});
    return res.status(401).json({error:'Incorrect PIN'});
  }
  profilePinFailures.delete(attemptKey);
  const token=createSessionToken(req.user.userId,profile.id,req,req.user.sid || null);
  res.json({token,user:profileUser(req.user.userId,profile.id)});
});
app.patch('/api/profiles/:id',authMw,async(req,res)=>{
  const profile=ensureUserProfiles(req.user.userId).find(item=>item.id===req.params.id);
  if(!profile) return res.status(404).json({error:'Profile not found'});
  if(req.body.name!==undefined){const name=String(req.body.name).trim().replace(/\s+/g,' ').slice(0,24);if(!name)return res.status(400).json({error:'Enter a profile name'});profile.name=name;}
  if(req.body.avatarKey!==undefined){const nextAvatarKey=safeAvatarKey(req.body.avatarKey);if(nextAvatarKey!==profile.avatarKey)profile.avatarUrl=null;profile.avatarKey=nextAvatarKey;}
  if(req.body.avatarColor!==undefined && /^#[0-9a-f]{6}$/i.test(String(req.body.avatarColor))) profile.avatarColor=String(req.body.avatarColor);
  if(req.body.avatarEmoji!==undefined) profile.avatarEmoji=String(req.body.avatarEmoji).slice(0,8);
  if(req.body.pin!==undefined){const pin=String(req.body.pin);if(pin && !/^\d{4}$/.test(pin))return res.status(400).json({error:'Profile PIN must be exactly 4 digits'});profile.pinHash=pin?await bcrypt.hash(pin,10):null;}
  saveProfiles(); res.json({profile:publicProfile(profile)});
});
app.delete('/api/profiles/:id',authMw,(req,res)=>{
  const profiles=ensureUserProfiles(req.user.userId);
  if(profiles.length<=1) return res.status(400).json({error:'Keep at least one profile on this account'});
  const index=profiles.findIndex(item=>item.id===req.params.id);
  if(index<0)return res.status(404).json({error:'Profile not found'});
  profiles.splice(index,1);saveProfiles();
  const active=profiles.find(item=>item.id===req.user.profileId)||profiles[0];
  const sessionId=req.user.profileId===req.params.id && req.user.sid ? req.user.sid : null;
  const token=sessionId?createSessionToken(req.user.userId,active.id,req,sessionId):null;
  res.json({profiles:profiles.map(publicProfile),activeProfileId:active.id,token,user:profileUser(req.user.userId,active.id)});
});
app.post('/api/account/password',authMw,async(req,res)=>{
  const user=users.get(req.user.userId),current=String(req.body.currentPassword||''),next=String(req.body.newPassword||'');
  if(!current||!next)return res.status(400).json({error:'Enter your current and new password'});
  if(next.length<6)return res.status(400).json({error:'New password must be at least 6 characters'});
  if(!await bcrypt.compare(current,user.passwordHash))return res.status(401).json({error:'Current password is incorrect'});
  user.passwordHash=await bcrypt.hash(next,10);
  for(const [id,session] of deviceSessions)if(session.userId===user.id&&id!==req.user.sid)disconnectDeviceSession(id);
  saveDeviceSessions();res.json({ok:true});
});
app.get('/api/account/sessions',authMw,(req,res)=>res.json({sessions:[...deviceSessions.values()].filter(session=>session.userId===req.user.userId).map(session=>({id:session.id,userAgent:session.userAgent,createdAt:session.createdAt,lastActive:session.lastActive,current:session.id===req.user.sid}))}));
app.delete('/api/account/sessions/:id',authMw,(req,res)=>{
  const session=deviceSessions.get(req.params.id);
  if(!session||session.userId!==req.user.userId)return res.status(404).json({error:'Session not found'});
  disconnectDeviceSession(req.params.id);saveDeviceSessions();res.json({ok:true,current:req.params.id===req.user.sid});
});

app.get('/api/alerts/contacts', authMw, (req,res) => {
  const contacts = getAlertContacts(req.user.userId).map(contact => {
    const recipient = contact.recipientUserId ? users.get(contact.recipientUserId) : null;
    if (contact.recipientUserId && !recipient) return null;
    return {...contact, name:contact.name || recipient?.displayName || contact.username || 'Contact',
      displayName:contact.name || recipient?.displayName || contact.username || 'Contact',
      username:recipient?.username || null, avatar:recipient?.avatar || (contact.name || 'C')[0].toUpperCase(),
      avatarColor:recipient?.avatarColor || contact.avatarColor || '#59656a', avatarUrl:recipient?.avatarUrl || null};
  }).filter(Boolean);
  res.json({contacts, delivery:{configured:false,provider:null}});
});
app.post('/api/alerts/contacts', authMw, (req,res) => {
  const name = String(req.body.name || '').trim().replace(/\s+/g,' ').slice(0,40);
  const phoneNumber = normalizeAlertPhone(req.body.phoneNumber);
  if (!name) return res.status(400).json({error:'Enter a name for this contact'});
  if (!phoneNumber) return res.status(400).json({error:'Enter a valid phone number with country code'});
  const contacts = getAlertContacts(req.user.userId);
  if (contacts.some(item => item.phoneNumber === phoneNumber)) return res.status(409).json({error:'This phone number is already saved'});
  if (contacts.length >= 50) return res.status(400).json({error:'You can save up to 50 people'});
  const contact = {id:uuidv4(),name,phoneNumber,addedAt:Date.now()};
  contacts.push(contact); saveAlertContacts();
  res.json({contact:{...contact,displayName:name,avatar:name[0].toUpperCase(),avatarColor:'#59656a',avatarUrl:null}});
});
app.patch('/api/alerts/contacts/:id', authMw, (req,res) => {
  const name = String(req.body.name || '').trim().replace(/\s+/g,' ').slice(0,40);
  const phoneNumber = normalizeAlertPhone(req.body.phoneNumber);
  if (!name) return res.status(400).json({error:'Enter a name for this contact'});
  if (!phoneNumber) return res.status(400).json({error:'Enter a valid phone number with country code'});
  const contacts = getAlertContacts(req.user.userId);
  if (contacts.some(item => item.phoneNumber === phoneNumber && item.id !== req.params.id)) return res.status(409).json({error:'This phone number is already saved'});
  const contact = contacts.find(item => item.id === req.params.id);
  if (!contact) return res.status(404).json({error:'Alert contact not found'});
  Object.assign(contact,{name,phoneNumber}); delete contact.recipientUserId; delete contact.username; saveAlertContacts();
  res.json({contact:{...contact,displayName:name,avatar:name[0].toUpperCase(),avatarColor:'#59656a',avatarUrl:null}});
});
app.delete('/api/alerts/contacts/:id', authMw, (req,res) => {
  const contacts = getAlertContacts(req.user.userId), index = contacts.findIndex(item => item.id === req.params.id);
  if (index < 0) return res.status(404).json({error:'Alert contact not found'});
  contacts.splice(index,1); saveAlertContacts(); res.json({ok:true});
});
app.post('/api/alerts/send', authMw, async (req,res) => {
  const message = "Hey! im on our website and i m looking for you";
  const ids = [...new Set(Array.isArray(req.body.contactIds) ? req.body.contactIds.map(String) : [])];
  if (!ids.length || ids.length > 50) return res.status(400).json({error:'Select between 1 and 50 saved people'});
  const now = Date.now(), last = alertSendTimes.get(req.user.userId) || 0;
  if (now - last < 60000) return res.status(429).json({error:'Please wait a minute before sending another alert'});
  const contacts = getAlertContacts(req.user.userId).filter(item => ids.includes(item.id));
  if (contacts.length !== ids.length) return res.status(400).json({error:'One or more selected people are unavailable'});
  alertSendTimes.set(req.user.userId, now);
  const delivery = await sendAlertWithProvider();
  if (!delivery.configured) return res.status(503).json({error:'Messaging is not configured yet. Your alert was not sent.',status:'pending',provider:delivery.provider});
  res.status(503).json({error:'Messaging provider is not available.',status:'pending'});
});

app.get('/api/library', authMw, (req,res) => {
  const userId = req.user.userId;
  res.json({
    items: ensureLibrary(userId)
      .slice()
      .sort((a, b) => (a.order - b.order) || (a.uploadedAt - b.uploadedAt))
      .map(pubMediaItem),
    usage: budgetSummary(userId),
  });
});

app.patch('/api/auth/profile', authMw, uploadAvatar.single('avatar'), async (req,res) => {
  try {
    const u=users.get(req.user.userId);
    if(!u) return res.status(404).json({error:'Not found'});
    const profiles=ensureUserProfiles(u.id),activeProfile=profiles.find(profile=>profile.id===req.user.profileId)||profiles[0];
    if(req.body.displayName){const name=req.body.displayName.trim().slice(0,30);if(name){activeProfile.name=name;if(activeProfile.id===profiles[0].id){u.displayName=name;u.avatar=name[0].toUpperCase();}}}
    if(req.body.bio!==undefined) u.bio=String(req.body.bio).slice(0,80);
    if(req.body.avatarColor && /^#[0-9a-f]{6}$/i.test(req.body.avatarColor)){activeProfile.avatarColor=req.body.avatarColor;if(activeProfile.id===profiles[0].id)u.avatarColor=req.body.avatarColor;}
    if(req.file){activeProfile.avatarUrl='/uploads/'+req.file.filename;if(activeProfile.id===profiles[0].id)u.avatarUrl=activeProfile.avatarUrl;}
    if(req.body.password?.length>=6) u.passwordHash=await bcrypt.hash(req.body.password,10);
    saveProfiles();
    res.json({user:profileUser(u.id,activeProfile.id)});
  } catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/rooms', authMw, (req,res) => {
  try {
    const {name,isPrivate,password}=req.body;
    const u=users.get(req.user.userId);
    if(!u) return res.status(401).json({error:'Unauthorized'});
    const id=uuidv4().replace(/-/g,'').slice(0,8).toUpperCase();
    const room={
      id, name:(name||`${u.displayName}'s Room`).slice(0,40),
      ownerId:u.id, guestId:null,
      isPrivate:!!isPrivate,
      passwordHash:(isPrivate&&password)?bcrypt.hashSync(password,8):null,
      video:null,
      sync:{playing:false,time:0,serverTs:Date.now()},
      messages:[],
      onlineUsers:[],
      createdAt:Date.now()
    };
    rooms.set(id,room);
    res.json({room:rPub(room,u.id)});
  } catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/rooms/:id', authMw, async (req,res) => {
  try {
    const room=rooms.get(req.params.id.toUpperCase());
    if(!room) return res.status(404).json({error:'Room not found'});
    const pw=req.query.password;
    if(room.isPrivate){
      if(!pw) return res.json({room:{id:room.id,name:room.name,isPrivate:true,needsPassword:true}});
      if(!await bcrypt.compare(pw,room.passwordHash)) return res.status(403).json({error:'Wrong password'});
    }
    res.json({room:rPub(room,req.user.userId)});
  } catch(e){res.status(500).json({error:e.message});}
});

// Large media uses small sequential chunks so a multi-gigabyte file does not
// depend on one long request surviving every proxy and server timeout.
app.post('/api/library/upload/start', authMw, (req,res) => {
  const size = Number(req.body?.size);
  const originalName = path.basename(String(req.body?.name || 'video').replace(/\\/g, '/')).slice(0, 240);
  const extension = path.extname(originalName).toLowerCase();
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_UPLOAD_BYTES)
    return res.status(413).json({ error:`Video size must be between 1 byte and ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024 / 1024)} GB.` });
  if (!VIDEO_EXTENSIONS.has(extension)) return res.status(400).json({ error:'Choose a supported video file.' });
  const reservedBytes = [...uploadSessions.values()].reduce((sum, item) => sum + item.size, 0);
  if (totalLibraryBytes() + reservedBytes + size > MEDIA_BUDGET_BYTES)
    return res.status(413).json({ error:'Server media budget full. Delete old files before uploading more.' });
  const id = uuidv4();
  const tempPath = path.join(uploadChunkDir, id + '.part');
  try {
    fs.closeSync(fs.openSync(tempPath, 'wx'));
    const now = Date.now();
    uploadSessions.set(id, { id, userId:req.user.userId, originalName, extension, size, received:0, tempPath, busy:false, createdAt:now, updatedAt:now });
    res.json({ uploadId:id, chunkSize:MAX_UPLOAD_CHUNK_BYTES });
  } catch (error) { res.status(500).json({ error:'Could not start the upload. Check server storage and try again.' }); }
});

app.put('/api/library/upload/:uploadId/chunk', authMw, express.raw({ type:'application/octet-stream', limit:MAX_UPLOAD_CHUNK_BYTES }), async (req,res) => {
  const session = uploadSessions.get(req.params.uploadId);
  if (!session || session.userId !== req.user.userId) return res.status(404).json({ error:'Upload session expired. Start the upload again.' });
  const offset = Number(req.get('Upload-Offset'));
  const chunk = req.body;
  if (session.busy) return res.status(409).json({ error:'A previous chunk is still being saved. Retry shortly.' });
  if (!Buffer.isBuffer(chunk) || !chunk.length || chunk.length > MAX_UPLOAD_CHUNK_BYTES || offset !== session.received || offset + chunk.length > session.size)
    return res.status(400).json({ error:'Upload chunk is out of sequence. Retry the upload.' });
  session.busy = true;
  try {
    await fs.promises.appendFile(session.tempPath, chunk);
    session.received += chunk.length;
    session.updatedAt = Date.now();
    res.json({ received:session.received, total:session.size });
  } catch (error) { res.status(507).json({ error:'Could not save this upload chunk. Check server storage.' }); }
  finally { session.busy = false; }
});

app.get('/api/library/upload/:uploadId', authMw, (req,res) => {
  const session = uploadSessions.get(req.params.uploadId);
  if (!session || session.userId !== req.user.userId) return res.status(404).json({ error:'Upload session expired. Start the upload again.' });
  res.json({ received:session.received, total:session.size });
});

app.post('/api/library/upload/:uploadId/complete', authMw, async (req,res) => {
  const session = uploadSessions.get(req.params.uploadId);
  if (!session || session.userId !== req.user.userId) return res.status(404).json({ error:'Upload session expired. Start the upload again.' });
  if (session.busy || session.received !== session.size) return res.status(409).json({ error:`Upload is incomplete (${session.received} of ${session.size} bytes received).` });
  const filename = uuidv4() + session.extension;
  const finalPath = path.join(uploadsDir, filename);
  try {
    await fs.promises.rename(session.tempPath, finalPath);
    const userId = session.userId;
    const library = ensureLibrary(userId);
    const entry = { id:uuidv4().slice(0,8), ownerId:userId, filename, originalName:normalizeMediaDisplayName('', session.originalName), url:'', size:session.size, uploadedAt:Date.now(), order:library.length };
    entry.url = '/api/media/' + entry.id + '/stream';
    library.push(entry);
    try { saveLibraries(); }
    catch (error) {
      library.pop();
      await fs.promises.rename(finalPath, session.tempPath).catch(() => {});
      throw error;
    }
    uploadSessions.delete(session.id);
    refreshRoomsForUser(userId);
    const roomItems = activeRoomMediaForUser(userId);
    const needsCompatibility = !NATIVE_VIDEO_EXTENSIONS.has(path.extname(filename).toLowerCase());
    res.json({ video:pubMediaItem(entry), items:library.slice().sort((a,b)=>a.order-b.order).map(pubMediaItem), usage:budgetSummary(userId), roomItems, compatibility:needsCompatibility?{status:'queued'}:{status:'not-needed'} });
    if (needsCompatibility) setImmediate(() => startCompatibleTranscode(entry));
  } catch (error) {
    console.error('Could not finalize library upload:', error);
    res.status(500).json({ error:'The video arrived but could not be added to your library. Check server storage and retry Save.' });
  }
});

app.delete('/api/library/upload/:uploadId', authMw, async (req,res) => {
  const session = uploadSessions.get(req.params.uploadId);
  if (!session || session.userId !== req.user.userId) return res.json({ ok:true });
  uploadSessions.delete(session.id);
  try { await fs.promises.unlink(session.tempPath); } catch {}
  res.json({ ok:true });
});

app.post('/api/library/upload', authMw, uploadVideo.single('video'), (req,res) => {
  try {
    if(!req.file) return res.status(400).json({error:'No supported video file was received.'});
    const currentUsage = totalLibraryBytes();
    if (currentUsage + req.file.size > MEDIA_BUDGET_BYTES) {
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(413).json({error:'Server media budget full. Delete old files before uploading more.'});
    }
    const userId = req.user.userId;
    const library = ensureLibrary(userId);
    const displayName = normalizeMediaDisplayName(req.body?.customName, req.file.originalname);
    const entry={id:uuidv4().slice(0,8),ownerId:userId,filename:req.file.filename,
      originalName:displayName,url:'',
      size:req.file.size,uploadedAt:Date.now(),order:library.length};
    entry.url = '/api/media/' + entry.id + '/stream';
    library.push(entry);
    try {
      saveLibraries();
    } catch (error) {
      library.pop();
      try { fs.unlinkSync(req.file.path); } catch {}
      throw new Error('Could not save this video to the library. Please try again.');
    }
    refreshRoomsForUser(userId);
    const roomItems = activeRoomMediaForUser(userId);
    const needsCompatibility = !NATIVE_VIDEO_EXTENSIONS.has(path.extname(entry.filename).toLowerCase());
    res.json({
      video: pubMediaItem(entry),
      items: library.slice().sort((a,b)=>a.order-b.order).map(pubMediaItem),
      usage: budgetSummary(userId),
      roomItems,
      compatibility: needsCompatibility ? { status:'queued' } : { status:'not-needed' },
    });
    if (needsCompatibility) setImmediate(() => startCompatibleTranscode(entry));
  } catch(e){res.status(500).json({error:e.message});}
});

app.patch('/api/library/order', authMw, (req,res) => {
  try {
    const userId = req.user.userId;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    const library = ensureLibrary(userId);
    if (ids.length !== library.length) return res.status(400).json({error:'Invalid playlist order'});
    const byId = new Map(library.map(item => [item.id, item]));
    if (ids.some(id => !byId.has(id))) return res.status(400).json({error:'Invalid playlist order'});
    libraries.set(userId, ids.map((id, idx) => ({ ...byId.get(id), order: idx })));
    saveLibraries();
    refreshRoomsForUser(userId);
    res.json({
      items: ensureLibrary(userId).slice().sort((a,b)=>a.order-b.order).map(pubMediaItem),
      usage: budgetSummary(userId),
    });
  } catch(e){res.status(500).json({error:e.message});}
});

app.patch('/api/library/:mediaId', authMw, (req,res) => {
  try {
    const userId = req.user.userId;
    const payload = renameLibraryItemForUser(userId, req.params.mediaId, req.body?.name);
    if (!payload) return res.status(404).json({error:'Media not found'});
    res.json(payload);
  } catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/library/:mediaId/rename', authMw, (req,res) => {
  try {
    const userId = req.user.userId;
    const payload = renameLibraryItemForUser(userId, req.params.mediaId, req.body?.name);
    if (!payload) return res.status(404).json({error:'Media not found'});
    res.json(payload);
  } catch(e){res.status(500).json({error:e.message});}
});

app.delete('/api/library/:mediaId', authMw, (req,res) => {
  try {
    const userId = req.user.userId;
    const library = ensureLibrary(userId);
    const idx = library.findIndex(item => item.id === req.params.mediaId);
    if (idx === -1) return res.status(404).json({error:'Media not found'});
    const [entry] = library.splice(idx, 1);
    normalizeOrders(library);
    saveLibraries();
    if (entry?.filename) {
      try { fs.unlinkSync(path.join(uploadsDir, entry.filename)); } catch {}
      try { fs.unlinkSync(compatiblePath(entry)); } catch {}
      try { fs.unlinkSync(compatibleTempPath(entry)); } catch {}
    }
    refreshRoomsForUser(userId);
    res.json({
      ok:true,
      items: library.slice().sort((a,b)=>a.order-b.order).map(pubMediaItem),
      usage: budgetSummary(userId),
    });
  } catch(e){res.status(500).json({error:e.message});}
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error:`Video is too large. Maximum upload size is ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024 / 1024)} GB.` });
  }
  if (error) return res.status(400).json({ error:error.message || 'Upload failed' });
  next();
});

const mediaContentTypes = {
  '.mp4':'video/mp4', '.m4v':'video/mp4', '.webm':'video/webm', '.ogv':'video/ogg',
  '.ogg':'video/ogg', '.mov':'video/quicktime', '.mkv':'video/x-matroska', '.avi':'video/x-msvideo',
  '.ts':'video/mp2t', '.m2ts':'video/mp2t', '.wmv':'video/x-ms-wmv', '.flv':'video/x-flv',
};
function streamMediaFile(req, res, filePath) {
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) return res.status(404).json({ error:'Video file not found' });
    const total = stats.size;
    const range = req.headers.range;
    const contentType = mediaContentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Type', contentType);
    if (!range) {
      res.setHeader('Content-Length', total);
      return fs.createReadStream(filePath).pipe(res);
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) return res.status(416).set('Content-Range', `bytes */${total}`).end();
    const start = match[1] === '' ? Math.max(0, total - Number(match[2])) : Number(match[1]);
    const end = match[2] === '' ? total - 1 : Math.min(Number(match[2]), total - 1);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
      return res.status(416).set('Content-Range', `bytes */${total}`).end();
    }
    res.status(206).set({
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': end - start + 1,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  });
}
app.get('/api/media/:mediaId/stream', (req,res) => {
  const item = findMediaItem(req.params.mediaId);
  if (!item) return res.status(404).json({ error:'Video not found' });
  const useCompatible = req.query.variant === 'compatible';
  const filePath = path.join(uploadsDir, useCompatible ? compatibleFilename(item) : item.filename);
  if (!fs.existsSync(filePath)) return res.status(410).json({ error:useCompatible ? 'Converted video is not available yet.' : 'This video file is missing from server storage. Upload it again from a persistent storage volume.' });
  streamMediaFile(req, res, filePath);
});
app.post('/api/library/:mediaId/compatible', authMw, (req,res) => {
  const item = findMediaItem(req.params.mediaId);
  if (!item) return res.status(404).json({ error:'Video not found' });
  if (!fs.existsSync(path.join(uploadsDir, item.filename)))
    return res.status(410).json({ status:'missing', error:'The original video is missing from server storage. Upload it again from a persistent storage volume.' });
  const status = startCompatibleTranscode(item, { forceEncode:req.body?.forceEncode === true });
  if (status.status === 'missing') return res.status(410).json({ status:'missing', error:'The original video is missing from server storage. Upload it again from a persistent storage volume.' });
  const encodedQuery = status.mode === 'encode' ? '&encoding=h264' : '';
  res.json({ ...status, url: status.status === 'ready' ? '/api/media/' + item.id + '/stream?variant=compatible' + encodedQuery : null });
});

app.use('/uploads', express.static(uploadsDir));
app.get('*',(_,res)=>res.sendFile(path.join(__dirname,'../public/index.html')));

// ── Socket ─────────────────────────────────────────────────────────────────────
io.use((socket,next)=>{
  const tok=socket.handshake.auth.token;
  if(!tok) return next(new Error('No token'));
  try{
    socket.userData=jwt.verify(tok,JWT_SECRET);
    if(socket.userData.sid && deviceSessions.get(socket.userData.sid)?.userId!==socket.userData.userId) return next(new Error('This session has been signed out'));
    next();
  }
  catch{next(new Error('Invalid token'));}
});

io.on('connection', socket => {
  const userId=socket.userData.userId;
  const user=profileUser(userId,socket.userData.profileId)||users.get(userId);
  if(!user){socket.disconnect();return;}

  // Track socket sets per user (multiple tabs support)
  if(!uSocks.has(userId)) uSocks.set(userId,new Set());
  uSocks.get(userId).add(socket.id);

  // ── join_room ──────────────────────────────────────────────────────────────
  socket.on('join_room', async ({roomId,password},cb) => {
    const rId=roomId?.toUpperCase();
    const room=rooms.get(rId);
    if(!room) return cb?.({error:'Room not found'});
    pruneRoomMembership(room);

    if(room.isPrivate&&room.passwordHash){
      if(!password) return cb?.({error:'Password required'});
      if(!await bcrypt.compare(password,room.passwordHash)) return cb?.({error:'Wrong password'});
    }

    // BUG FIX #5: strict identity assignment
    const isOwner  = room.ownerId===userId;
    const isGuest  = room.guestId===userId;
    const isMember = isOwner||isGuest;

    if(!isMember && room.guestId!==null) return cb?.({error:'Room full (max 2)'});
    // Only assign guestId if this user is neither owner nor already guest
    if(!isMember) room.guestId=userId;

    // Leave previous room if different
    const prev=sessions.get(socket.id);
    if(prev&&prev.roomId!==rId){
      socket.leave(prev.roomId);
      const pr=rooms.get(prev.roomId);
      if(pr){
        pr.onlineUsers=pr.onlineUsers.filter(id=>id!==userId);
        promoteOwner(pr);
        bcastRoom(pr);
      }
    }

    // BUG FIX #4: join IO room BEFORE adding to onlineUsers and calling bcastRoom
    await socket.join(rId);
    sessions.set(socket.id,{userId,roomId:rId});

    // De-dup: only add if not already present
    if(!room.onlineUsers.includes(userId)) room.onlineUsers.push(userId);

    // Send initial data to this socket
    socket.emit('chat_history',room.messages.slice(-100));
    socket.emit('uploaded_videos_list',{items:combinedRoomMedia(room),usage:budgetSummary(userId)});
    socket.emit('sync_init',currentTime(room));
    if(room.video) socket.emit('video_changed',{video:room.video});

    // Notify others
    socket.to(rId).emit('user_joined',{user:uPub(user)});

    // Respond with room data for this user
    cb?.({room:rPub(room,userId)});

    // BUG FIX #4: bcastRoom AFTER join + onlineUsers update = correct count
    bcastRoom(room);
  });

  // ── owner_sync: heartbeat + events ────────────────────────────────────────
  socket.on('media_upload_progress', ({ roomId, fileName, fileSize, percent, status } = {}) => {
    const room = rooms.get(String(roomId || '').toUpperCase());
    const session = sessions.get(socket.id);
    if (!room || !session || session.roomId !== room.id) return;
    const safeStatus = ['uploading', 'saving', 'complete', 'failed'].includes(status) ? status : 'uploading';
    socket.to(room.id).emit('media_upload_progress', {
      user:uPub(user),
      fileName:String(fileName || 'Video').replace(/[\r\n]/g, ' ').trim().slice(0, 120) || 'Video',
      fileSize:Math.max(0, Number(fileSize) || 0),
      percent:Math.max(0, Math.min(100, Number(percent) || 0)),
      status:safeStatus,
    });
  });

  socket.on('owner_sync',({roomId,playing,time,isSeeked})=>{
    const room=rooms.get(roomId);
    if(!room||room.ownerId!==userId) return;
    room.sync={playing,time:Number(time)||0,serverTs:Date.now()};
    // Send to all OTHER sockets in room (not back to owner)
    socket.to(roomId).emit('sync_update',{
      playing,time:room.sync.time,serverTs:room.sync.serverTs,isSeeked:!!isSeeked
    });
  });

  // ── request_sync ──────────────────────────────────────────────────────────
  socket.on('request_sync',({roomId})=>{
    const room=rooms.get(roomId);
    if(room) socket.emit('sync_init',currentTime(room));
  });

  // ── transfer_ownership ────────────────────────────────────────────────────
  socket.on('transfer_ownership',({roomId,toUserId})=>{
    const room=rooms.get(roomId);
    if(!room||room.ownerId!==userId) return;
    const target=users.get(toUserId);
    if(!target||!room.onlineUsers.includes(toUserId)) return;
    room.ownerId=toUserId;
    io.to(roomId).emit('owner_changed',{newOwnerId:toUserId,user:uPub(target)});
    bcastRoom(room);
  });

  socket.on('leave_room',({roomId})=>{
    const room=rooms.get(roomId);
    if(!room) return;
    releaseRoomSeat(room, userId, { intendedLeave:true, socketId:socket.id });
    socket.leave(roomId);
    sessions.delete(socket.id);
    socket.to(roomId).emit('user_left',{user:uPub(user)});
    // Immediately broadcast updated room state so partner sees correct count
    bcastRoom(room);
    promoteOwner(room);
  });

  // ── set_video: BUG FIX #1 ─────────────────────────────────────────────────
  // Emit video_changed to ALL (io.to) so sender also gets clean confirmation.
  // Sender client deduplicates using S.vid.url check.
  socket.on('set_video',({roomId,video})=>{
    const room=rooms.get(roomId);
    if(!room) return;
    room.video={...video,setBy:userId,setAt:Date.now()};
    room.sync={playing:false,time:0,serverTs:Date.now()};
    // BUG FIX #1: use io.to (not socket.to) so ALL users get video_changed
    io.to(roomId).emit('video_changed',{video:room.video});
    const msg={id:uuidv4().slice(0,12),type:'system',
      text:`${user.displayName} loaded "${video.title||'a video'}"`,at:Date.now()};
    room.messages.push(msg);
    io.to(roomId).emit('chat_message',msg);
  });

  socket.on('clear_video',({roomId})=>{
    const room=rooms.get(roomId);
    if(!room||room.ownerId!==userId) return;
    room.video=null;
    room.sync={playing:false,time:0,serverTs:Date.now()};
    io.to(roomId).emit('video_cleared');
    const msg={id:uuidv4().slice(0,12),type:'system',
      text:`${user.displayName} cleared the current content`,at:Date.now()};
    room.messages.push(msg);
    io.to(roomId).emit('chat_message',msg);
    bcastRoom(room);
  });

  // ── chat ──────────────────────────────────────────────────────────────────
  socket.on('chat_message',payload=>{
    const { roomId, text, type, stickerData, stickerName } = payload || {};
    const room=rooms.get(roomId);
    if(!room) return;
    let msg;
    if (type === 'sticker') {
      const data = String(stickerData || '');
      if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/i.test(data)) return;
      msg = {
        id:uuidv4().slice(0,12),
        userId,
        user:uPub(user),
        type:'sticker',
        stickerData:data.slice(0, 400000),
        stickerName:String(stickerName || 'Sticker').trim().slice(0, 40) || 'Sticker',
        at:Date.now()
      };
    } else {
      if(!text?.trim()) return;
      msg = {
        id:uuidv4().slice(0,12),
        userId,
        user:uPub(user),
        text:text.trim().slice(0,500),
        type:'text',
        at:Date.now()
      };
    }
    room.messages.push(msg);
    if(room.messages.length>300) room.messages.shift();
    io.to(roomId).emit('chat_message',msg);
  });

  socket.on('typing',({roomId,isTyping})=>socket.to(roomId).emit('typing',{user:uPub(user),isTyping}));
  socket.on('emoji_reaction',({roomId,emoji})=>io.to(roomId).emit('emoji_reaction',{emoji,user:uPub(user)}));

  // BUG FIX #8: Mute status broadcast
  socket.on('mute_status',({roomId,muted})=>{
    socket.to(roomId).emit('partner_mute',{userId,user:uPub(user),muted});
  });

  // WebRTC relay (pure pass-through)
  socket.on('rtc_offer',  ({roomId,offer})     =>socket.to(roomId).emit('rtc_offer',  {offer,  from:userId}));
  socket.on('rtc_answer', ({roomId,answer})    =>socket.to(roomId).emit('rtc_answer', {answer, from:userId}));
  socket.on('rtc_ice',    ({roomId,candidate}) =>socket.to(roomId).emit('rtc_ice',    {candidate,from:userId}));
  socket.on('rtc_hangup', ({roomId})           =>socket.to(roomId).emit('rtc_hangup', {from:userId}));

  // ── disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', ()=>{
    const sSet=uSocks.get(userId);
    if(sSet){sSet.delete(socket.id); if(sSet.size===0)uSocks.delete(userId);}

    const sess=sessions.get(socket.id);
    if(sess){
      const room=rooms.get(sess.roomId);
      if(room){
        // Only mark offline if user has no other sockets in this room
        const hasOtherSocket=[...sessions.values()].some(s=>s.userId===userId&&s.roomId===sess.roomId&&s!==sess);
        if(!hasOtherSocket){
          releaseRoomSeat(room, userId, { intendedLeave:false, socketId:socket.id });
          io.to(sess.roomId).emit('user_left',{user:uPub(user)});
          promoteOwner(room);
        }
        // Always broadcast immediately so partner count updates instantly
        bcastRoom(room);
      }
      sessions.delete(socket.id);
    }
  });
});

server.listen(PORT,()=>{
  console.log(`\nMaeve'mom v5  →  http://localhost:${PORT}`);
  console.log('ashish/ashish123  |  disha/disha123\n');
});
