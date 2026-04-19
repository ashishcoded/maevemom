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

// ── Uploads ────────────────────────────────────────────────────────────────────
const uploadsDir = path.join(__dirname, '../public/uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const libraryFile = path.join(dataDir, 'libraries.json');

const mkStore = pfx => multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadsDir),
  filename:    (_, f, cb) => cb(null, (pfx||'')+uuidv4()+path.extname(f.originalname).toLowerCase())
});
const uploadVideo  = multer({ storage: mkStore(),     limits:{ fileSize: 4*1024*1024*1024 }, fileFilter:(_,f,cb)=>cb(null,['.mp4','.webm','.mkv','.mov','.avi','.m4v','.ogv'].includes(path.extname(f.originalname).toLowerCase())) });
const uploadAvatar = multer({ storage: mkStore('av_'), limits:{ fileSize: 8*1024*1024 }, fileFilter:(_,f,cb)=>cb(null,f.mimetype.startsWith('image/')) });

// ── Stores ─────────────────────────────────────────────────────────────────────
const users    = new Map(); // id → User
const rooms    = new Map(); // id → Room
const sessions = new Map(); // socketId → {userId, roomId}
const uSocks   = new Map(); // userId → Set of socketIds (handles multiple tabs)
const libraries = new Map(); // userId → saved media playlist

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
  fs.writeFileSync(libraryFile, JSON.stringify(out, null, 2), 'utf8');
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
    url: item.url,
    size: item.size,
    uploadedAt: item.uploadedAt,
    order: item.order,
  };
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
loadLibraries();

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
  try { req.user=jwt.verify(tok,JWT_SECRET); next(); }
  catch { res.status(401).json({error:'Invalid token'}); }
}

// ── Routes ─────────────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req,res) => {
  try {
    const {username,displayName,password}=req.body;
    if(!username||!displayName||!password) return res.status(400).json({error:'All fields required'});
    if(password.length<6) return res.status(400).json({error:'Password 6+ chars'});
    if(!/^[a-z0-9_]{2,20}$/i.test(username)) return res.status(400).json({error:'Username: 2-20 chars (a-z 0-9 _)'});
    if([...users.values()].find(u=>u.username.toLowerCase()===username.toLowerCase())) return res.status(409).json({error:'Username taken'});
    const clrs=['#e50914','#ff6b9d','#f59e0b','#10b981','#6366f1','#ec4899','#06b6d4','#84cc16'];
    const id='user_'+uuidv4().replace(/-/g,'').slice(0,10);
    const user={id,username:username.toLowerCase(),displayName:displayName.trim(),
      avatar:displayName.trim()[0].toUpperCase(),
      avatarColor:clrs[Math.floor(Math.random()*clrs.length)],
      avatarUrl:null,bio:'Movie lover',
      passwordHash:await bcrypt.hash(password,10),createdAt:Date.now()};
    users.set(id,user);
    const token=jwt.sign({userId:id},JWT_SECRET,{expiresIn:'30d'});
    res.json({token,user:uPub(user)});
  } catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/auth/login', async (req,res) => {
  try {
    const {username,password}=req.body;
    if(!username||!password) return res.status(400).json({error:'Username and password required'});
    const user=[...users.values()].find(u=>u.username.toLowerCase()===username.toLowerCase());
    if(!user) return res.status(401).json({error:'User not found'});
    if(!await bcrypt.compare(password,user.passwordHash)) return res.status(401).json({error:'Wrong password'});
    const token=jwt.sign({userId:user.id},JWT_SECRET,{expiresIn:'30d'});
    res.json({token,user:uPub(user)});
  } catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/auth/me', authMw, (req,res) => {
  const u=users.get(req.user.userId);
  if(!u) return res.status(404).json({error:'Not found'});
  res.json({user:uPub(u)});
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
    if(req.body.displayName){u.displayName=req.body.displayName.trim().slice(0,30);u.avatar=u.displayName[0].toUpperCase();}
    if(req.body.bio!==undefined) u.bio=String(req.body.bio).slice(0,80);
    if(req.body.avatarColor) u.avatarColor=req.body.avatarColor;
    if(req.file) u.avatarUrl='/uploads/'+req.file.filename;
    if(req.body.password?.length>=6) u.passwordHash=await bcrypt.hash(req.body.password,10);
    res.json({user:uPub(u)});
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

app.post('/api/library/upload', authMw, uploadVideo.single('video'), (req,res) => {
  try {
    if(!req.file) return res.status(400).json({error:'No file'});
    const currentUsage = totalLibraryBytes();
    if (currentUsage + req.file.size > MEDIA_BUDGET_BYTES) {
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(413).json({error:'Server media budget full. Delete old files before uploading more.'});
    }
    const userId = req.user.userId;
    const library = ensureLibrary(userId);
    const displayName = normalizeMediaDisplayName(req.body?.customName, req.file.originalname);
    const entry={id:uuidv4().slice(0,8),ownerId:userId,filename:req.file.filename,
      originalName:displayName,url:'/uploads/'+req.file.filename,
      size:req.file.size,uploadedAt:Date.now(),order:library.length};
    library.push(entry);
    saveLibraries();
    refreshRoomsForUser(userId);
    res.json({
      video: pubMediaItem(entry),
      items: library.slice().sort((a,b)=>a.order-b.order).map(pubMediaItem),
      usage: budgetSummary(userId),
    });
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
    }
    refreshRoomsForUser(userId);
    res.json({
      ok:true,
      items: library.slice().sort((a,b)=>a.order-b.order).map(pubMediaItem),
      usage: budgetSummary(userId),
    });
  } catch(e){res.status(500).json({error:e.message});}
});

app.use('/uploads', express.static(uploadsDir));
app.get('*',(_,res)=>res.sendFile(path.join(__dirname,'../public/index.html')));

// ── Socket ─────────────────────────────────────────────────────────────────────
io.use((socket,next)=>{
  const tok=socket.handshake.auth.token;
  if(!tok) return next(new Error('No token'));
  try{socket.userData=jwt.verify(tok,JWT_SECRET);next();}
  catch{next(new Error('Invalid token'));}
});

io.on('connection', socket => {
  const userId=socket.userData.userId;
  const user=users.get(userId);
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
