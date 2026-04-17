/* ══════════════════════════════════════════════════════════════
   Maeve'mom v5 — All bugs fixed
   
   BUG FIXES:
   #1 Content sync: qPick sets S.vid + url; doLoadVid uses S.vid
      correctly; server uses io.to (not socket.to) for set_video
   #2 Iframe play/pause sync: owner heartbeat every 2s + clock
   #3 Universal embed: postMessage for Vidking, YouTube, generic
   #4 User count: server joins IO room BEFORE bcastRoom
   #5 Owner/Guest name: server guards guestId !== ownerId
   #6 Emoji: Twemoji SVGs + 4 extra emojis (11 total)
   #7 RTC stability: timeout, ICE restart, state machine
   #8 Mute visibility: socket event + viewer bar + call bar
   #9 Font: Bebas Neue (cinematic) + Oswald + Space Grotesk
   #10 No regressions
══════════════════════════════════════════════════════════════ */

// ── Emoji rendering ───────────────────────────────────────────────────────────
const TW_BASE = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/';
const IOS_EMOJI_BASE = 'https://cdn.jsdelivr.net/npm/emoji-datasource-apple/img/apple/64/';
function tw(text) {
  if (!window.twemoji) return text;
  return twemoji.parse(text, { folder:'svg', ext:'.svg', base:TW_BASE });
}
function twEl(el) {
  if (window.twemoji) twemoji.parse(el, { folder:'svg', ext:'.svg', base:TW_BASE });
}
function emojiCode(emoji) {
  return Array.from(emoji, ch => ch.codePointAt(0).toString(16)).join('-');
}
function reactionEmoji(emoji, cls = '') {
  const klass = ['emoji-ios', cls].filter(Boolean).join(' ');
  return `<img class="${klass}" src="${IOS_EMOJI_BASE}${emojiCode(emoji)}.png" alt="${emoji}" draggable="false">`;
}

// ── State ─────────────────────────────────────────────────────────────────────
const S = {
  token:   localStorage.getItem('mm_tok') || null,
  user:    (() => { try { return JSON.parse(localStorage.getItem('mm_usr')||'null'); } catch { return null; } })(),
  room:    null,
  socket:  null,
  isOwner: false,
  library: { items:[], usage:null },
  typing:  { timer:null, active:false },
  vid:     { url:null, title:'', meta:'', type:'embed' },
  msgIds:  new Set(),
  pendingClr: null,
  pendingAvFile: null,
  sidebarOpen: true,
  // Owner clock for iframe sync
  _clock:  { playing:false, time:0, ts:Date.now() },
  _nativeVid: null,
  _heartbeatTimer: null,
  _guestTimer: null,
  _frameProvider: null,
  _frameBindTimer: null,
  _guestFrameClock: { playing:false, time:0, ts:Date.now() },
  _lastIframeState: null,
  // WebRTC
  rtc: { pc:null, stream:null, inCall:false, muted:false, state:'idle', _connectTimer:null },
};

// ── API ───────────────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const h = { 'Content-Type':'application/json' };
  if (S.token) h.Authorization = 'Bearer ' + S.token;
  const r = await fetch('/api'+path, { method, headers:h, body:body?JSON.stringify(body):undefined });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Request failed');
  return d;
}
async function apiUpload(path, file, progIds) {
  return await new Promise((resolve, reject) => {
    const prog = progIds?.prog ? $(progIds.prog) : null;
    const fill = progIds?.fill ? $(progIds.fill) : null;
    const lbl = progIds?.label ? $(progIds.label) : null;
    if (prog) prog.classList.remove('hidden');
    if (fill) fill.style.width = '0%';
    if (lbl) lbl.textContent = `Uploading ${file.name}…`;
    const form = new FormData();
    form.append('video', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api'+path);
    if (S.token) xhr.setRequestHeader('Authorization', 'Bearer ' + S.token);
    xhr.upload.onprogress = e => {
      if (!e.lengthComputable) return;
      const p = Math.round(e.loaded / e.total * 100);
      if (fill) fill.style.width = p + '%';
      if (lbl) lbl.textContent = `Uploading… ${p}%`;
    };
    xhr.onload = () => {
      if (prog) prog.classList.add('hidden');
      try {
        const d = JSON.parse(xhr.responseText || '{}');
        if (xhr.status >= 200 && xhr.status < 300) resolve(d);
        else reject(new Error(d.error || 'Upload failed'));
      } catch {
        reject(new Error('Upload failed'));
      }
    };
    xhr.onerror = () => {
      if (prog) prog.classList.add('hidden');
      reject(new Error('Upload failed'));
    };
    xhr.send(form);
  });
}
const $  = id => document.getElementById(id);
const $$ = s  => document.querySelectorAll(s);
const ROOM_SESSION_KEY = 'mm_room_session';
function saveRoomSession(room, password='') {
  if (!room?.id) return;
  localStorage.setItem(ROOM_SESSION_KEY, JSON.stringify({ roomId:room.id, password:password||'', savedAt:Date.now() }));
}
function getRoomSession() {
  try { return JSON.parse(localStorage.getItem(ROOM_SESSION_KEY)||'null'); } catch { return null; }
}
function clearRoomSession() {
  localStorage.removeItem(ROOM_SESSION_KEY);
}
function setPlayerConnecting(show, text='Connecting room…', sub='Restoring synced playback') {
  const el = $('player-connect');
  if (!el) return;
  el.classList.toggle('hidden', !show);
  if ($('player-connect-sub')) $('player-connect-sub').textContent = sub;
  const txt = el.querySelector('.pc-loader-text');
  if (txt) txt.textContent = text;
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Auth tabs
  $$('.atab').forEach(b => b.addEventListener('click', () => {
    $$('.atab').forEach(x=>x.classList.remove('active'));
    $$('.aform').forEach(x=>x.classList.add('hidden'));
    b.classList.add('active');
    $('f-'+b.dataset.tab).classList.remove('hidden');
  }));
  $$('.overlay').forEach(o => o.addEventListener('click', e => { if(e.target===o) o.classList.add('hidden'); }));
  document.addEventListener('keydown', e => { if(e.key==='Escape') $$('.overlay').forEach(o=>o.classList.add('hidden')); });

  // Noise canvas on auth
  drawNoise();

  // Build emoji strips (after Twemoji may have loaded)
  const buildEmoji = () => buildEmojiStrips();
  if (window.twemoji) buildEmoji();
  else window.addEventListener('load', buildEmoji);

  // URL params
  const p = new URLSearchParams(location.search);
  const invRoom = p.get('room'), invPw = p.get('pw');

  if (S.token && S.user) {
    try {
      const { user } = await api('GET', '/auth/me');
      persist(user, S.token);
      const roomSession = getRoomSession();
      if (roomSession?.roomId) {
        try {
          const res = await api('GET', `/rooms/${roomSession.roomId}${roomSession.password ? '?password='+encodeURIComponent(roomSession.password) : ''}`);
          if (res.room?.id) {
            enterRoom(res.room, roomSession.password || '');
          } else {
            clearRoomSession();
            goHome();
          }
        } catch {
          clearRoomSession();
          goHome();
        }
      } else {
        goHome();
      }
      if (invRoom) setTimeout(()=>{ $('j-id').value=invRoom; if(invPw) $('j-pw').value=invPw; openJoinModal(); }, 200);
    } catch { clearSession(); goAuth(); }
  } else {
    goAuth();
    if (invRoom) window._inv = { room:invRoom, pw:invPw };
  }

  $('v-url').addEventListener('input', e => onVidUrl(e.target));
});

// ── Noise canvas ──────────────────────────────────────────────────────────────
function drawNoise() {
  const c = $('noise-canvas'); if (!c) return;
  const ctx = c.getContext('2d');
  c.width = 256; c.height = 256;
  const img = ctx.createImageData(256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255;
    img.data[i] = img.data[i+1] = img.data[i+2] = v;
    img.data[i+3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

// ── Emoji strips — BUG FIX #6 (11 emojis, Twemoji SVG) ───────────────────────
const EMOJIS = ['❤️','😂','😍','😮','🔥','👏','🍿','💕','😭','✨','🎬'];

function buildEmojiStrips() {
  buildStrip('emj-strip',  EMOJIS, em => sendEmoji(em));
  buildStrip('fc-emj',     EMOJIS, em => sendEmoji(em));
}
function buildStrip(id, emojis, handler) {
  const el = $(id); if (!el) return;
  el.innerHTML = '';
  emojis.forEach(em => {
    const btn = document.createElement('button');
    btn.className = 'ej'; btn.title = em;
    btn.innerHTML = reactionEmoji(em, 'emoji-reaction-btn');
    btn.onclick = () => handler(em);
    el.appendChild(btn);
  });
}

// ── Session ───────────────────────────────────────────────────────────────────
function persist(u, tok) { S.user=u; S.token=tok; localStorage.setItem('mm_tok',tok); localStorage.setItem('mm_usr',JSON.stringify(u)); }
function clearSession() { S.user=null; S.token=null; localStorage.removeItem('mm_tok'); localStorage.removeItem('mm_usr'); }

// ── Screens ───────────────────────────────────────────────────────────────────
function goAuth() { setScreen('auth'); }
function goRoom() { setScreen('room'); }
function goHome() {
  setScreen('home');
  if (!S.user) return;
  const av = $('hn-av');
  av.style.background = S.user.avatarColor;
  av.innerHTML = S.user.avatarUrl ? `<img src="${S.user.avatarUrl}" alt="">` : S.user.avatar;
  $('hn-nm').textContent = S.user.displayName;
  $('h-greet').textContent = `${S.user.displayName}'s cinema is ready`;
  buildHomeCards();
  loadLibrary(true);
  history.replaceState({},'','/');
}
function setScreen(n) {
  ['auth','home','room'].forEach(s => {
    const el=$('s-'+s);
    el.classList.toggle('active', s===n);
    el.classList.toggle('hidden', s!==n);
  });
}
function buildHomeCards() {
  const u = S.user; if (!u) return;
  const avA = $('hpa-av');
  avA.style.background = u.avatarColor;
  avA.innerHTML = u.avatarUrl ? `<img src="${u.avatarUrl}" alt="" style="width:100%;height:100%;object-fit:cover">` : u.avatar;
  $('hpa-name').textContent = u.displayName;
  $('hpa-bio').textContent  = u.bio || 'The Owner 🎬';
  $('hpa-glow').style.background = `radial-gradient(ellipse at 50% 0%,${u.avatarColor}28,transparent 65%)`;
  const iDisha = u.username === 'disha';
  $('hpb-name').textContent = iDisha ? 'Ashish' : 'Disha';
  $('hpb-bio').textContent  = iDisha ? 'The Owner 🎬' : 'The Co-star 💕';
  const bAv = $('hpb-av');
  bAv.style.background = iDisha ? '#e50914' : '#ff6b9d';
  bAv.textContent = iDisha ? 'A' : 'D';
}
function resetPlayerUI() {
  stopAllTimers();
  if(S._nativeVid){S._nativeVid.remove();S._nativeVid=null;}
  const fr=$('vframe'), pempty=$('pempty');
  if(fr){fr.src='';fr.style.display='none';}
  if(pempty)pempty.style.display='flex';
  S.vid={url:null,title:'',meta:'',type:'embed'};
  S._clock={playing:false,time:0,ts:Date.now()};
  S._guestFrameClock={playing:false,time:0,ts:Date.now()};
  S._frameProvider=null;
  S._lastIframeState=null;
  if($('r-sub')) $('r-sub').textContent='';
  if($('clear-content-btn')) $('clear-content-btn').classList.add('hidden');
  setSyncStatus(S.isOwner?'hosting':'synced', S.isOwner?'Ready to load':'Waiting for content');
}
function setLibraryState(items, usage) {
  S.library.items = Array.isArray(items) ? items : [];
  S.library.usage = usage || S.library.usage;
  renderLibraryList();
  renderBudgetUI();
}
async function loadLibrary(silent=false) {
  if (!S.token) return;
  try {
    const { items, usage } = await api('GET', '/library');
    setLibraryState(items, usage);
  } catch (ex) {
    if (!silent) toast(ex.message);
  }
}
function renderBudgetUI() {
  const usage = S.library.usage;
  if (!usage) return;
  const txt = `${fmtSz(usage.used)} / ${fmtSz(usage.total)}`;
  const note = usage.remaining > 0
    ? `${fmtSz(usage.remaining)} remaining in configured server budget.`
    : 'Storage budget is full. Delete something before uploading.';
  [['home-budget-text','home-budget-fill','home-budget-note'],['lib-budget-text','lib-budget-fill','lib-budget-note'],['room-budget-text','room-budget-fill','room-budget-note']].forEach(([tid,fid,nid])=>{
    if($(tid)) $(tid).textContent = txt;
    if($(fid)) $(fid).style.width = `${usage.percent || 0}%`;
    if($(nid)) $(nid).textContent = note;
  });
}
function renderLibraryList() {
  renderUserLibraryList('home-media-list', S.library.items, true);
}
function renderUserLibraryList(id, items, editable) {
  const list = $(id); if (!list) return;
  list.innerHTML = '';
  if (!items?.length) {
    list.innerHTML = '<div class="media-mt"><div style="font-size:2rem;opacity:.2">🎞</div><p>No saved media yet</p></div>';
    return;
  }
  items.forEach((item, idx) => list.appendChild(makeMediaItem(item, { editable, showOwner:false, index:idx })));
}

// ── Auth ──────────────────────────────────────────────────────────────────────
window.quickLogin = async (u,p) => { $('l-user').value=u; $('l-pass').value=p; await doLogin(); };
window.doLogin = async () => {
  const u=$('l-user').value.trim(), p=$('l-pass').value, e=$('l-err'); e.textContent='';
  if(!u||!p){e.textContent='Fill in all fields';return;}
  try {
    const{token,user}=await api('POST','/auth/login',{username:u,password:p});
    persist(user,token); goHome();
    if(window._inv){const i=window._inv;window._inv=null;setTimeout(()=>{$('j-id').value=i.room;if(i.pw)$('j-pw').value=i.pw;openJoinModal();},200);}
  } catch(ex){e.textContent=ex.message;}
};
window.doRegister = async () => {
  const u=$('r-user').value.trim(),n=$('r-name').value.trim(),p=$('r-pass').value,e=$('r-err');e.textContent='';
  if(!u||!n||!p){e.textContent='Fill in all fields';return;}
  if(p.length<6){e.textContent='Password 6+ chars';return;}
  try{const{token,user}=await api('POST','/auth/register',{username:u,displayName:n,password:p});persist(user,token);goHome();}catch(ex){e.textContent=ex.message;}
};
window.signOut = () => { endCall(); stopAllTimers(); clearRoomSession(); if(S.socket){S.socket.disconnect();S.socket=null;} S.room=null; S.library={items:[],usage:null}; $$('.overlay').forEach(o=>o.classList.add('hidden')); clearSession(); goAuth(); };

// ── Modals ────────────────────────────────────────────────────────────────────
window.openCreateModal  = () => { $('c-name').value='';$('c-pw').value='';$('c-err').textContent='';$('c-priv').checked=false;$('c-pw-w').classList.add('hidden');$('m-create').classList.remove('hidden');setTimeout(()=>$('c-name').focus(),50); };
window.openJoinModal    = () => { $('j-err').textContent='';$('j-pw-w').classList.add('hidden');$('m-join').classList.remove('hidden');setTimeout(()=>{if(!$('j-id').value)$('j-id').focus();},50); };
window.openVideoModal   = () => { $('v-url').value='';$('v-err').textContent='';$('sel-prev').classList.add('hidden');$('v-load-btn').disabled=true;S.vid={url:null,title:'',meta:'',type:'embed'};$('m-video').classList.remove('hidden'); };
window.openLibraryModal = () => { $('m-library').classList.remove('hidden'); loadLibrary(true); };
window.openInvitePanel  = () => sbTab('room');
window.openProfileModal = () => { if(!S.user)return;$('pf-nm').value=S.user.displayName||'';$('pf-bio').value=S.user.bio||'';$('pf-pw').value='';$('pf-err').textContent='';S.pendingClr=null;S.pendingAvFile=null;renderProfAv($('prof-av'),S.user);$('m-prof').classList.remove('hidden'); };
window.closeModal = id => $(id).classList.add('hidden');

// ── Create/Join ───────────────────────────────────────────────────────────────
window.doCreate = async () => {
  const name=$('c-name').value.trim()||'Movie Night 🎬',isPrivate=$('c-priv').checked,password=$('c-pw').value.trim(),e=$('c-err');e.textContent='';
  if(isPrivate&&!password){e.textContent='Enter a password';return;}
  try{const{room}=await api('POST','/rooms',{name,isPrivate,password});closeModal('m-create');enterRoom(room,password);}catch(ex){e.textContent=ex.message;}
};
window.doJoin = async () => {
  const rid=$('j-id').value.trim().toUpperCase(),pw=$('j-pw').value.trim(),e=$('j-err');e.textContent='';
  if(!rid){e.textContent='Enter a Room ID';return;}
  try {
    const res=await api('GET',`/rooms/${rid}${pw?'?password='+encodeURIComponent(pw):''}`);
    if(res.room?.needsPassword){$('j-pw-w').classList.remove('hidden');e.textContent='Room requires a password';$('j-pw').focus();return;}
    closeModal('m-join');enterRoom(res.room,pw);
  } catch(ex) {
    if(ex.message==='Wrong password'||ex.message==='Password required'){$('j-pw-w').classList.remove('hidden');e.textContent='Wrong password — try again';$('j-pw').focus();}
    else e.textContent=ex.message;
  }
};

// ── Enter room ────────────────────────────────────────────────────────────────
function enterRoom(room, password) {
  S.room=room; S.isOwner=room.isOwner; S.msgIds.clear();
  S.sidebarOpen=true;
  saveRoomSession(room, password);
  resetPlayerUI();
  setPlayerConnecting(true, 'Connecting room…', 'Joining and restoring sync');

  goRoom(); updateRoomUI(room);

  // Reset UI
  $('chat-box').innerHTML='<div class="chat-mt"><div class="cmt-icon">💬</div><p>Say hello!</p></div>';
  $('fc-msgs').innerHTML='';
  $('media-list').innerHTML='<div class="media-mt"><div style="font-size:2rem;opacity:.2">📁</div><p>No uploads yet</p></div>';
  setSidebar(true); sbTab('chat');
  buildEmojiStrips(); // rebuild after DOM is ready
  connectSocket(room, password);
}

// ── Socket ────────────────────────────────────────────────────────────────────
function connectSocket(room, password) {
  if(S.socket) S.socket.disconnect();
  S.socket = io({ auth:{token:S.token}, reconnection:true, reconnectionDelay:1000, reconnectionAttempts:20 });

  S.socket.on('connect', () => {
    setPlayerConnecting(true, 'Connecting room…', 'Syncing room state');
    S.socket.emit('join_room',{roomId:room.id,password},res=>{
      if(res?.error){toast('Error: '+res.error);leaveRoom();return;}
      if(res?.room){S.room=res.room;S.isOwner=res.room.isOwner;saveRoomSession(res.room, password||'');updateRoomUI(res.room);}
      startSyncTimers();
      setPlayerConnecting(false);
    });
  });

  S.socket.on('disconnect', ()=>{setSyncStatus('offline','Disconnected');stopAllTimers();setPlayerConnecting(true,'Reconnecting…','Keeping you inside the room');});
  S.socket.on('reconnect',  ()=>{
    sysMsg('Reconnected!');
    setPlayerConnecting(true,'Reconnecting…','Restoring synced playback');
    S.socket.emit('join_room',{roomId:room.id,password},res=>{
      if(res?.error){toast('Reconnect issue: '+res.error);return;}
      if(res?.room){S.room=res.room;S.isOwner=res.room.isOwner;saveRoomSession(res.room, password||'');updateRoomUI(res.room);startSyncTimers();setPlayerConnecting(false);}
    });
  });

  S.socket.on('room_update',({room:r})=>{
    const was=S.isOwner; S.room=r; S.isOwner=r.isOwner;
    if(S.isOwner&&!was){toast('You are now the Owner ★');sysMsg('You became the owner');}
    updateRoomUI(r);
    startSyncTimers();
  });

  S.socket.on('owner_changed',({user})=>{sysMsg(`${user.displayName} is now the owner ★`);toast(`${user.displayName} is now the owner`);});
  S.socket.on('user_joined', ({user})=>{sysMsg(`${user.displayName} joined ✨`);toast(`${user.displayName} is here!`);if(S.isOwner)sendHeartbeat();});
  S.socket.on('user_left',   ({user})=>sysMsg(`${user.displayName} left`));

  // ── BUG FIX #2/#3: Sync ───────────────────────────────────────────────────
  S.socket.on('sync_init',({playing,time})=>{
    if(S.isOwner) return;
    applySync(playing,time,false);
    setSyncStatus('synced','Synced');
  });
  S.socket.on('sync_update',({playing,time,serverTs,isSeeked})=>{
    if(S.isOwner) return;
    const age = serverTs ? (Date.now()-serverTs)/1000 : 0;
    applySync(playing, playing?time+age:time, isSeeked);
    setSyncStatus('synced','Synced');
  });

  // ── BUG FIX #1: video_changed now fires for ALL users from server ──────────
  // Client only loads if URL changed (dedup)
  S.socket.on('video_changed',({video})=>{
    if(video.url !== S.vid.url) {
      loadVidUrl(video.url, video.title, video.meta, video.type);
    }
    startSyncTimers();
  });
  S.socket.on('video_cleared',()=>{
    resetPlayerUI();
    if(S.room){S.room.video=null;updateRoomUI(S.room);}
  });

  S.socket.on('chat_history', msgs=>{msgs.forEach(m=>renderMsg(m,true));scrollChat();});
  S.socket.on('chat_message', msg=>{if(!S.msgIds.has(msg.id))renderMsg(msg);});
  S.socket.on('typing',({user,isTyping})=>{$('typing-bar').classList.toggle('hidden',!isTyping);$('t-who').textContent=user.displayName;});
  S.socket.on('emoji_reaction',({emoji})=>spawnEmoji(emoji));
  S.socket.on('uploaded_videos_list',payload=>{
    const items = Array.isArray(payload) ? payload : (payload?.items || []);
    renderMediaList(items);
    if (payload?.usage) {
      S.library.usage = payload.usage;
      renderBudgetUI();
    }
  });

  // BUG FIX #8: partner mute
  S.socket.on('partner_mute',({user,muted})=>setPartnerMuteUI(user,muted));

  // WebRTC
  S.socket.on('rtc_offer',  ({offer})   =>handleRtcOffer(offer));
  S.socket.on('rtc_answer', ({answer})  =>handleRtcAnswer(answer));
  S.socket.on('rtc_ice',    ({candidate})=>handleRtcIce(candidate));
  S.socket.on('rtc_hangup', ()          =>handleRtcHangup());
}

// ── Room UI update — BUG FIX #4 #5 ──────────────────────────────────────────
function updateRoomUI(room) {
  S.room=room; S.isOwner=room.isOwner;
  const owner=room.owner, guest=room.guest;

  $('r-title').textContent=room.name;
  // BUG FIX #4: de-dup count
  $('op-n').textContent=[...new Set(room.onlineUsers||[])].length;
  $('owner-ctrl-badge').classList.toggle('hidden',!S.isOwner);
  $('clear-content-btn')?.classList.toggle('hidden',!S.isOwner||!room.video);

  // BUG FIX #5: owner and guest are always distinct from server
  if(owner){ renderVwAv($('vwh-av'),owner); $('vwh-nm').textContent=owner.displayName; $('vwh-s').className='vw-s '+(room.onlineUsers?.includes(owner.id)?'online':'offline'); }
  if(guest){ renderVwAv($('vwg-av'),guest); $('vwg-nm').textContent=guest.displayName; $('vwg-s').className='vw-s '+(room.onlineUsers?.includes(guest.id)?'online':'offline'); }
  else { $('vwg-av').textContent='?';$('vwg-av').style.background='#333';$('vwg-nm').textContent='Waiting…';$('vwg-s').className='vw-s offline'; }

  $('ss-right').textContent = S.isOwner?'You control playback':(owner?`${owner.displayName} controls`:'');

  $('ri-name').textContent=room.name;$('ri-id').textContent=room.id;
  $('ri-priv').textContent=room.isPrivate?'Yes 🔒':'No';
  $('ri-role').textContent=room.isOwner?'Owner ★':'Guest';
  $('inv-link').value=`${location.origin}/?room=${room.id}`;
  $('inv-id').value=room.id;
  if(room.isPrivate){$('inv-pw-r').classList.remove('hidden');$('inv-pw').value='(set on create)';}

  const hasGuest=guest&&room.onlineUsers?.includes(guest.id);
  $('xfer-blk').classList.toggle('hidden',!S.isOwner||!hasGuest);
  if(hasGuest&&$('btn-xfer')) $('btn-xfer').textContent=`Transfer to ${guest.displayName} →`;

  if (room.mediaBudget) {
    S.library.usage = room.mediaBudget;
    renderBudgetUI();
  }
  renderMediaList(room.uploadedVideos || []);
  if(room.video&&room.video.url!==S.vid.url) loadVidUrl(room.video.url,room.video.title,room.video.meta,room.video.type);
  if(!room.video && S.vid.url) resetPlayerUI();
}

function renderVwAv(el,u){el.style.background=u.avatarColor;el.innerHTML=u.avatarUrl?`<img src="${u.avatarUrl}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`:u.avatar;}
function renderProfAv(el,u){el.style.background=u.avatarColor;el.innerHTML=u.avatarUrl?`<img src="${u.avatarUrl}" alt="">`:u.avatar;}

// ── BUG FIX #8: Partner mute visibility ──────────────────────────────────────
function setPartnerMuteUI(user, muted) {
  const isOwnerUser = S.room?.owner?.id === user.id;
  // Viewer bar mute icon
  const muteEl = isOwnerUser ? $('vwh-mute') : $('vwg-mute');
  if (muteEl) muteEl.classList.toggle('hidden', !muted);
  // Call bar partner mute notice
  const pm = $('cb-partner-mute');
  if (pm) {
    pm.classList.toggle('hidden', !muted);
    $('cb-partner-name').textContent = user.displayName;
  }
}

// ── Sidebar toggle ────────────────────────────────────────────────────────────
window.toggleSidebar = () => setSidebar(!S.sidebarOpen);
function setSidebar(open) {
  S.sidebarOpen=open;
  $('sidebar').classList.toggle('collapsed',!open);
  $('float-chat').classList.toggle('hidden',open);
  $('sb-toggle-btn').classList.toggle('sb-hidden-mode',!open);
}

window.leaveRoom = () => {
  endCall(); stopAllTimers();
  clearRoomSession();
  if(S.socket&&S.room){try{S.socket.emit('leave_room',{roomId:S.room.id});}catch{}}
  if(S.socket){setTimeout(()=>{if(S.socket){S.socket.disconnect();S.socket=null;}},60);}
  resetPlayerUI();
  S.room=null;S.isOwner=false;
  history.replaceState({},'','/'); goHome();
};
window.clearCurrentContent = () => {
  if(!S.socket||!S.room||!S.isOwner) return;
  S.socket.emit('clear_video',{roomId:S.room.id});
  resetPlayerUI();
  if(S.room) S.room.video=null;
  toast('Content cleared');
};

window.sbTab = name => {
  $$('.sbt').forEach(b=>b.classList.toggle('active',b.dataset.p===name));
  $$('.sb-panel').forEach(p=>{p.classList.add('hidden');p.classList.remove('active');});
  $('p-'+name).classList.remove('hidden');$('p-'+name).classList.add('active');
};

window.cp = (id,msg) => { const el=$(id);navigator.clipboard.writeText(el.value).then(()=>toast(msg)).catch(()=>{el.select();document.execCommand('copy');toast(msg);}); };

window.transferOwnership = () => {
  if(!S.isOwner||!S.socket||!S.room)return;
  const gId=S.room.guest?.id; if(!gId){toast('No guest online');return;}
  S.socket.emit('transfer_ownership',{roomId:S.room.id,toUserId:gId});
  toast('Ownership transferred!');
};

// ── BUG FIX #1: Video URL resolver ───────────────────────────────────────────
function resolveUrl(raw) {
  if(!raw||!raw.trim()) return null;
  raw=raw.trim();
  if(raw.includes('vidking.net/embed'))         return {url:normalizeEmbedUrl(addClr(raw)),type:'embed',title:vkTitle(raw),meta:'Vidking'};
  const vkP=raw.match(/vidking\.net\/(movie|tv)\/(\d+)/);
  if(vkP)                                        return {url:normalizeEmbedUrl(`https://www.vidking.net/embed/${vkP[1]}/${vkP[2]}?color=e50914`),type:'embed',title:`${vkP[1]} #${vkP[2]}`,meta:'Vidking'};
  const yt=raw.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if(yt)                                         return {url:normalizeEmbedUrl(`https://www.youtube.com/embed/${yt[1]}?rel=0&enablejsapi=1`),type:'embed',title:'YouTube Video',meta:'youtube.com'};
  if(raw.includes('youtube.com/embed/'))         return {url:normalizeEmbedUrl(raw),type:'embed',title:'YouTube',meta:'youtube.com'};
  const vim=raw.match(/vimeo\.com\/(\d+)/);
  if(vim)                                        return {url:normalizeEmbedUrl(`https://player.vimeo.com/video/${vim[1]}`),type:'embed',title:'Vimeo Video',meta:'vimeo.com'};
  if(raw.includes('player.vimeo.com'))           return {url:normalizeEmbedUrl(raw),type:'embed',title:'Vimeo',meta:'vimeo.com'};
  if(/\.(mp4|webm|mkv|m3u8|ogv|m4v)(\?|$)/i.test(raw)) return {url:raw,type:'direct',title:raw.split('/').pop().split('?')[0],meta:'Local file'};
  if(/^\d{4,8}$/.test(raw))                     return {url:normalizeEmbedUrl(`https://www.vidking.net/embed/movie/${raw}?color=e50914`),type:'embed',title:`Movie #${raw}`,meta:'Vidking'};
  if(raw.startsWith('http')){
    let host='';try{host=new URL(raw).hostname.replace('www.','')}catch{}
    return {url:normalizeEmbedUrl(raw),type:'embed',title:host||'Video',meta:host};
  }
  return null;
}
const addClr=url=>url.includes('color=')?url:url+(url.includes('?')?'&':'?')+'color=e50914';
const vkTitle=url=>{const m=url.match(/\/(?:movie|tv)\/(\d+)/);return m?`Content #${m[1]}`:'Video';};
function embedProvider(url=''){
  try{
    const host=new URL(url,location.href).hostname.toLowerCase();
    if(host.includes('youtube.com')||host.includes('youtu.be')) return 'youtube';
    if(host.includes('player.vimeo.com')||host==='vimeo.com'||host.endsWith('.vimeo.com')) return 'vimeo';
    if(host.includes('vidking.net')) return 'vidking';
  }catch{}
  return 'generic';
}
function normalizeEmbedUrl(url=''){
  const p=embedProvider(url);
  try{
    const u=new URL(url,location.href);
    if(p==='youtube'){
      u.searchParams.set('enablejsapi','1');
      u.searchParams.set('playsinline','1');
      u.searchParams.set('rel','0');
      u.searchParams.set('origin',location.origin);
    }else if(p==='vimeo'){
      u.searchParams.set('api','1');
      u.searchParams.set('player_id','vframe');
      u.searchParams.set('autopause','0');
    }else if(p==='vidking'){
      u.searchParams.set('color','e50914');
    }
    return u.toString();
  }catch{return url;}
}
function parseFrameMsg(data){
  if(!data) return null;
  if(typeof data==='string'){try{return JSON.parse(data);}catch{return null;}}
  return typeof data==='object' ? data : null;
}
function framePost(payload){
  const fr=$('vframe');
  if(!fr?.contentWindow) return;
  try{fr.contentWindow.postMessage(payload,'*');}catch{}
}
function scheduleFrameBinding(){
  if(S._frameBindTimer){clearTimeout(S._frameBindTimer);S._frameBindTimer=null;}
  let tries=0;
  const bind=()=>{
    const fr=$('vframe');
    if(!fr||!fr.src||fr.src==='about:blank') return;
    S._frameProvider=embedProvider(fr.src);
    if(S._frameProvider==='youtube'){
      framePost(JSON.stringify({event:'listening',id:'vframe',channel:'widget'}));
      framePost(JSON.stringify({event:'command',func:'addEventListener',args:['onStateChange']}));
      framePost(JSON.stringify({event:'command',func:'addEventListener',args:['onReady']}));
    }else if(S._frameProvider==='vimeo'){
      ['play','pause','seeked','timeupdate'].forEach(ev=>framePost(JSON.stringify({method:'addEventListener',value:ev})));
    }else if(S._frameProvider==='vidking'){
      framePost({action:'listen'});
    }
    if(tries++<5) S._frameBindTimer=setTimeout(bind,tries<3?450:900);
  };
  bind();
}
function guestFrameTick(playing,time){S._guestFrameClock={playing,time:Number(time)||0,ts:Date.now()};}
function guestFrameNow(){
  const c=S._guestFrameClock;
  if(!c.playing) return c.time;
  return c.time+(Date.now()-c.ts)/1000;
}

window.onVidUrl = el => {
  const r=resolveUrl(el.value.trim());
  $('v-load-btn').disabled=!r;
  if(r){S.vid={url:r.url,title:r.title,meta:r.meta,type:r.type};showVP('🎬',r.title,r.meta);}
  else $('sel-prev').classList.add('hidden');
};

// BUG FIX #1: qPick correctly sets both S.vid and the input value
window.qPick = (url,ico,title,meta) => {
  const safe=normalizeEmbedUrl(url);
  S.vid={url:safe,title,meta,type:'embed'};
  $('v-url').value=safe;            // keep input in sync for resolveUrl fallback
  $('v-load-btn').disabled=false;
  showVP(ico,title,meta);
};
window.clearVid = () => {S.vid={url:null,title:'',meta:'',type:'embed'};$('v-url').value='';$('sel-prev').classList.add('hidden');$('v-load-btn').disabled=true;};
function showVP(ico,ti,me){$('sel-ico').textContent=ico;$('sel-ti').textContent=ti;$('sel-me').textContent=me;$('sel-prev').classList.remove('hidden');}

// BUG FIX #1: doLoadVid uses S.vid first, falls back to URL input
window.doLoadVid = () => {
  // Priority: S.vid.url (set by qPick) > resolve URL input
  let res = S.vid.url ? S.vid : resolveUrl($('v-url').value.trim());
  if(!res||!res.url){$('v-err').textContent='Enter a valid URL or pick a title above';return;}

  // Emit to server — server uses io.to() so ALL users get video_changed
  if(S.socket&&S.room) S.socket.emit('set_video',{roomId:S.room.id,video:{url:res.url,title:res.title||'Video',meta:res.meta||'',type:res.type||'embed'}});

  // Load locally (video_changed echo from server will be deduped)
  loadVidUrl(res.url,res.title,res.meta,res.type);
  closeModal('m-video');
  toast('Loading for both users… 🎬');
};

// ── Load video ────────────────────────────────────────────────────────────────
function loadVidUrl(url,title,meta,type) {
  const safeUrl=type==='embed'?normalizeEmbedUrl(url):url;
  S.vid={url:safeUrl,title:title||'Video',meta:meta||'',type:type||'embed'};
  if($('clear-content-btn')) $('clear-content-btn').classList.toggle('hidden',!S.isOwner);
  if(S.room) $('r-title').textContent=S.room.name;
  $('r-sub').textContent=(title||'')+(meta?' · '+meta:'');

  const player=$('player'),fr=$('vframe'),pempty=$('pempty');
  if(S._nativeVid){S._nativeVid.remove();S._nativeVid=null;}
  if(S._frameBindTimer){clearTimeout(S._frameBindTimer);S._frameBindTimer=null;}
  S._frameProvider=null;
  S._lastIframeState=null;

  if(type==='direct'){
    fr.style.display='none';pempty.style.display='none';
    const vid=document.createElement('video');
    vid.src=safeUrl;vid.controls=true;
    vid.style.cssText='width:100%;height:100%;background:#000;display:block';
    if(S.isOwner){
      vid.addEventListener('play',  ()=>{clockTick(true, vid.currentTime); sendOwnerSync(true, vid.currentTime);});
      vid.addEventListener('pause', ()=>{clockTick(false,vid.currentTime); sendOwnerSync(false,vid.currentTime);});
      vid.addEventListener('seeked',()=>{clockTick(!vid.paused,vid.currentTime); sendOwnerSync(!vid.paused,vid.currentTime,true);});
    }
    player.appendChild(vid);
    S._nativeVid=vid;
    clockTick(false,0);
    guestFrameTick(false,0);
  } else {
    fr.onload=()=>{
      scheduleFrameBinding();
      if(!S.isOwner&&S.socket&&S.room) S.socket.emit('request_sync',{roomId:S.room.id});
    };
    fr.src=safeUrl;fr.style.display='block';pempty.style.display='none';
    clockTick(false,0);
    guestFrameTick(false,0);
  }

  const limited=type==='embed'&&embedProvider(safeUrl)==='generic';
  setSyncStatus(
    S.isOwner?'hosting':(limited?'offline':'synced'),
    S.isOwner?(limited?'Controls are limited on this site':'You control playback'):(limited?'This site limits real-time sync':'Waiting for sync')
  );
  startSyncTimers();
}

// ── SYNC ENGINE — BUG FIX #2 #3 ──────────────────────────────────────────────
// Owner maintains a JS clock as source of truth for iframe players.
// Heartbeat every 2s broadcasts current time+playing to all guests.
// This works regardless of whether the iframe sends postMessage events.

function clockTick(playing, time) {
  S._clock={playing,time:Number(time)||0,ts:Date.now()};
}
function clockNow() {
  const c=S._clock;
  if(!c.playing) return c.time;
  return c.time+(Date.now()-c.ts)/1000;
}

function sendOwnerSync(playing, time, isSeeked=false) {
  clockTick(playing,time);
  if(!S.socket||!S.room||!S.isOwner) return;
  S.socket.emit('owner_sync',{roomId:S.room.id,playing,time,isSeeked});
}

function sendHeartbeat() {
  if(!S.isOwner||!S.socket||!S.room) return;
  const t=S._nativeVid?S._nativeVid.currentTime:clockNow();
  const p=S._nativeVid?!S._nativeVid.paused:S._clock.playing;
  S.socket.emit('owner_sync',{roomId:S.room.id,playing:p,time:t});
}

function startSyncTimers() {
  stopAllTimers();
  if(S.isOwner) {
    S._heartbeatTimer=setInterval(()=>{if(S.socket&&S.room)sendHeartbeat();},1200);
    setSyncStatus('hosting','You control playback');
  } else {
    S._guestTimer=setInterval(()=>{if(S.socket&&S.room)S.socket.emit('request_sync',{roomId:S.room.id});},5000);
  }
}
function stopAllTimers() {
  if(S._heartbeatTimer){clearInterval(S._heartbeatTimer);S._heartbeatTimer=null;}
  if(S._guestTimer){clearInterval(S._guestTimer);S._guestTimer=null;}
  if(S._frameBindTimer){clearTimeout(S._frameBindTimer);S._frameBindTimer=null;}
}

// Apply sync to guest's player — BUG FIX #3
function applySync(playing,time,isSeeked) {
  if(S.isOwner) return;

  if(S._nativeVid){
    const v=S._nativeVid;
    const drift=Math.abs(v.currentTime-time);
    if(isSeeked||drift>2.5) { try{v.currentTime=time;}catch{} }
    if(playing&&v.paused)  v.play().catch(()=>{});
    if(!playing&&!v.paused) v.pause();
    return;
  }

  // Iframe sync — try all known APIs
  const fr=$('vframe');
  if(!fr||!fr.src||fr.src==='about:blank'||fr.src==='') return;
  const provider=embedProvider(fr.src);
  const drift=Math.abs(guestFrameNow()-time);
  const shouldSeek=isSeeked||drift>1.5;
  try {
    if(provider==='youtube'){
      if(shouldSeek) fr.contentWindow.postMessage(JSON.stringify({event:'command',func:'seekTo',args:[time,true]}),'*');
      fr.contentWindow.postMessage(JSON.stringify({event:'command',func:playing?'playVideo':'pauseVideo'}),'*');
    }else if(provider==='vimeo'){
      if(shouldSeek) fr.contentWindow.postMessage(JSON.stringify({method:'setCurrentTime',value:time}),'*');
      fr.contentWindow.postMessage(JSON.stringify({method:playing?'play':'pause'}),'*');
    }else{
      fr.contentWindow.postMessage({action:playing?'play':'pause',time},'*');
      if(shouldSeek) fr.contentWindow.postMessage({action:'seek',time},'*');
    }
  } catch {}
  guestFrameTick(playing,time);
}

// Listen for iframe events (owner picks these up to update clock)
window.addEventListener('message',e=>{
  if(!S.isOwner) return;
  const fr=$('vframe');
  if(!fr||!e.source||e.source!==fr.contentWindow) return;
  const d=parseFrameMsg(e.data);
  if(!d) return;
  const currentTime=Number(d.data?.seconds ?? d.seconds ?? d.time ?? d.info?.currentTime ?? clockNow())||0;
  const pushState=(playing,isSeeked=false)=>{
    clockTick(playing,currentTime);
    if(isSeeked||S._lastIframeState!==playing){
      S._lastIframeState=playing;
      sendOwnerSync(playing,currentTime,isSeeked);
    }
  };

  if(d.event==='play')  pushState(true);
  if(d.event==='pause') pushState(false);
  if(d.event==='seek'||d.event==='seeked') pushState(S._lastIframeState!==false,true);
  if(d.event==='timeupdate') clockTick(S._lastIframeState!==false,currentTime);

  if(d.event==='onReady') scheduleFrameBinding();
  if(d.event==='onStateChange'){
    const st=Number(d.info);
    if(st===1) pushState(true);
    if(st===2||st===0) pushState(false,st===0);
  }
  if(d.event==='infoDelivery'){
    if(d.info?.currentTime!=null) clockTick(S._lastIframeState===true,d.info.currentTime);
    const st=Number(d.info?.playerState);
    if(st===1) pushState(true);
    if(st===2||st===0) pushState(false,st===0);
  }
});

function setSyncStatus(state,text) {
  const dot=$('ss-dot'); if(dot) dot.className='ss-dot '+(state==='hosting'?'hosting':state==='synced'?'synced':'offline');
  const t=$('ss-txt');   if(t)   t.textContent=text;
}

// ── CHAT ──────────────────────────────────────────────────────────────────────
window.sendChat = () => doSend($('chat-inp'));
window.fcSend   = () => doSend($('fc-inp'));
function doSend(inp) {
  const txt=inp.value.trim(); if(!txt||!S.socket||!S.room) return;
  inp.value=''; inp.style.height='';
  const tmp='tmp_'+Date.now(); S.msgIds.add(tmp);
  renderMsgDirect(S.user,txt,true,tmp);
  S.socket.emit('chat_message',{roomId:S.room.id,text:txt});
  stopTyping();
}
window.chatKeyH=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendChat();}};
window.fcKeyH  =e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();fcSend();}};
window.chatInputH=el=>{
  el.style.height='';el.style.height=Math.min(el.scrollHeight,110)+'px';
  if(!S.socket||!S.room)return;
  if(!S.typing.active){S.typing.active=true;S.socket.emit('typing',{roomId:S.room.id,isTyping:true});}
  clearTimeout(S.typing.timer);
  S.typing.timer=setTimeout(stopTyping,1600);
};
window.fcInputH=el=>{el.style.height='';el.style.height=Math.min(el.scrollHeight,80)+'px';};
function stopTyping(){if(S.typing.active&&S.socket&&S.room){S.typing.active=false;S.socket.emit('typing',{roomId:S.room.id,isTyping:false});}}

function renderMsg(msg,fromHistory=false){
  if(S.msgIds.has(msg.id))return; S.msgIds.add(msg.id);
  if(msg.type==='system'){sysMsg(msg.text);return;}
  if(msg.userId===S.user?.id)return;
  renderMsgDirect(msg.user,msg.text,false,msg.id);
  if(!fromHistory)scrollChat();
}
function renderMsgDirect(user,text,isMine,id){
  const et=esc(text);
  // Sidebar
  const box=$('chat-box'); box.querySelector('.chat-mt')?.remove();
  const d=document.createElement('div'); d.className='msg-w '+(isMine?'mine':'theirs');
  d.innerHTML=(isMine?'':`<div class="msg-s">${esc(user?.displayName||'')}</div>`)+`<div class="msg-b">${et}</div>`;
  twEl(d); box.appendChild(d);
  // Float
  const fc=$('fc-msgs');
  const fd=document.createElement('div'); fd.className='fc-msg '+(isMine?'mine':'theirs');
  fd.innerHTML=(isMine?'':`<div class="ms">${esc(user?.displayName||'')}</div>`)+`<div class="mb">${et}</div>`;
  twEl(fd); fc.appendChild(fd);
  while(fc.children.length>25) fc.removeChild(fc.firstChild);
  fc.scrollTop=fc.scrollHeight;
  scrollChat();
}
function sysMsg(text){
  [$('chat-box'),$('fc-msgs')].forEach(box=>{
    if(!box)return; box.querySelector('.chat-mt')?.remove();
    const d=document.createElement('div');
    d.className=box.id==='chat-box'?'msg-sys':'fc-sys';
    d.textContent=text; box.appendChild(d);
  });scrollChat();
}
function scrollChat(){const b=$('chat-box');if(b)b.scrollTop=b.scrollHeight;}

// ── EMOJI ─────────────────────────────────────────────────────────────────────
window.sendEmoji=emoji=>{if(!S.socket||!S.room)return;S.socket.emit('emoji_reaction',{roomId:S.room.id,emoji});spawnEmoji(emoji);};
function spawnEmoji(emoji){
  const el=document.createElement('div');el.className='float-emj';
  const dur=2.6+Math.random()*0.8;
  el.innerHTML=`<div class="float-emj-core">${reactionEmoji(emoji, 'emoji-reaction-float')}</div>`;
  el.style.left=(10+Math.random()*74)+'vw';
  el.style.bottom=(Math.random()*28+42)+'px';
  el.style.setProperty('--fe-drift',`${(Math.random()*120-60).toFixed(0)}px`);
  el.style.setProperty('--fe-spin',`${(Math.random()*28-14).toFixed(0)}deg`);
  el.style.setProperty('--fe-scale',`${(1.08+Math.random()*0.42).toFixed(2)}`);
  el.style.setProperty('--fe-dur',`${dur.toFixed(2)}s`);
  $('efloat').appendChild(el);setTimeout(()=>el.remove(),dur*1000+180);
}

// ── MEDIA UPLOAD ──────────────────────────────────────────────────────────────
window.uploadVid=async input=>{
  if(!input.files?.length||!S.room)return;
  await uploadLibraryMedia(input, { prog:'up-prog', fill:'up-fill', label:'up-lbl2', success:`Saved to library: ${input.files[0].name}` });
};
window.uploadHomeMedia=async input=>{
  if(!input.files?.length)return;
  await uploadLibraryMedia(input, { prog:'home-up-prog', fill:'home-up-fill', label:'home-up-lbl', success:`Saved to library: ${input.files[0].name}` });
};
async function uploadLibraryMedia(input, progIds) {
  const file = input.files[0];
  input.value = '';
  try {
    const res = await apiUpload('/library/upload', file, progIds);
    setLibraryState(res.items, res.usage);
    toast(progIds.success || 'Upload complete!');
  } catch (e) {
    toast(e.message);
  }
}
async function saveLibraryOrder(ids) {
  const res = await api('PATCH', '/library/order', { ids });
  setLibraryState(res.items, res.usage);
}
window.moveLibraryItem = async (mediaId, dir) => {
  const items = S.library.items.slice();
  const idx = items.findIndex(item => item.id === mediaId);
  const next = idx + dir;
  if (idx < 0 || next < 0 || next >= items.length) return;
  [items[idx], items[next]] = [items[next], items[idx]];
  try {
    await saveLibraryOrder(items.map(item => item.id));
  } catch (e) {
    toast(e.message);
  }
};
window.deleteLibraryItem = async mediaId => {
  try {
    const res = await fetch('/api/library/' + mediaId, {
      method:'DELETE',
      headers:{ Authorization:'Bearer ' + S.token }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Delete failed');
    setLibraryState(data.items, data.usage);
    if (S.room) renderMediaList((S.room.uploadedVideos || []).filter(item => item.id !== mediaId || item.ownerId !== S.user?.id));
    toast('Deleted permanently');
  } catch (e) {
    toast(e.message);
  }
};
function renderMediaList(vs){
  const list=$('media-list'); if(!list)return;
  if (S.room) S.room.uploadedVideos = Array.isArray(vs) ? vs : [];
  list.innerHTML='';
  if(!vs?.length){
    list.innerHTML='<div class="media-mt"><div style="font-size:2rem;opacity:.2">📁</div><p>No saved media yet</p></div>';
    return;
  }
  vs.forEach((item, idx)=>list.appendChild(makeMediaItem(item, { editable:item.ownerId===S.user?.id, showOwner:true, index:idx })));
}
function makeMediaItem(v, opts = {}) {
  const d=document.createElement('div');d.className='media-item';
  const ownerPill = opts.showOwner ? `<span class="mi-owner"><span class="mi-owner-dot" style="background:${v.ownerAvatarColor||'#444'}">${esc(v.ownerAvatar||'?')}</span>${esc(v.ownerName||'You')}</span>` : '';
  d.innerHTML=`<span style="font-size:1.1rem">🎬</span><div class="mi-main"><div class="mi-nm" title="${esc(v.originalName)}">${esc(v.originalName)}</div><div class="mi-meta">${ownerPill}<span class="mi-sz">${fmtSz(v.size)}</span></div></div><div class="mi-actions"></div>`;
  const actions = d.querySelector('.mi-actions');
  if (S.room) {
    const play=document.createElement('button');
    play.className='mi-btn play'; play.title='Play for both';
    play.innerHTML='<svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
    play.onclick=e=>{e.stopPropagation();playMediaItem(v);};
    actions.appendChild(play);
    d.addEventListener('click',()=>playMediaItem(v));
  }
  if (opts.editable) {
    const up=document.createElement('button');
    up.className='mi-btn ord'; up.title='Move up';
    up.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
    up.onclick=e=>{e.stopPropagation();moveLibraryItem(v.id,-1);};
    actions.appendChild(up);
    const down=document.createElement('button');
    down.className='mi-btn ord'; down.title='Move down';
    down.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>';
    down.onclick=e=>{e.stopPropagation();moveLibraryItem(v.id,1);};
    actions.appendChild(down);
    const del=document.createElement('button');
    del.className='mi-btn del'; del.title='Delete permanently';
    del.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
    del.onclick=e=>{e.stopPropagation();deleteLibraryItem(v.id);};
    actions.appendChild(del);
  }
  return d;
}
function playMediaItem(v){
  if(S.socket&&S.room)S.socket.emit('set_video',{roomId:S.room.id,video:{url:v.url,title:v.originalName,meta:`Saved by ${v.ownerName||'You'}`,type:'direct'}});
  loadVidUrl(v.url,v.originalName,`Saved by ${v.ownerName||'You'}`,'direct');sbTab('chat');toast('Playing: '+v.originalName);
}
function fmtSz(b){if(!b)return'';if(b<1024)return b+'B';if(b<1048576)return(b/1024).toFixed(1)+'KB';if(b<1073741824)return(b/1048576).toFixed(1)+'MB';return(b/1073741824).toFixed(2)+'GB';}

// ── PROFILE ───────────────────────────────────────────────────────────────────
window.pickClr=c=>{S.pendingClr=c;const el=$('prof-av');el.style.background=c;el.textContent=S.user.avatar;};
window.prevAvatar=input=>{if(!input.files?.length)return;S.pendingAvFile=input.files[0];$('prof-av').innerHTML=`<img src="${URL.createObjectURL(S.pendingAvFile)}" style="width:100%;height:100%;object-fit:cover">`;};
window.saveProfile=async()=>{
  const e=$('pf-err');e.textContent='';
  try{
    const form=new FormData();
    form.append('displayName',$('pf-nm').value.trim());form.append('bio',$('pf-bio').value.trim());
    if($('pf-pw').value.trim())form.append('password',$('pf-pw').value.trim());
    if(S.pendingClr)form.append('avatarColor',S.pendingClr);
    if(S.pendingAvFile)form.append('avatar',S.pendingAvFile);
    const r=await fetch('/api/auth/profile',{method:'PATCH',headers:{Authorization:'Bearer '+S.token},body:form});
    const d=await r.json();if(!r.ok){e.textContent=d.error;return;}
    persist(d.user,S.token);closeModal('m-prof');goHome();toast('Profile updated! ✨');
  }catch(ex){e.textContent=ex.message;}
};

// ── WEBRTC — BUG FIX #7 (stability, timeout, state machine) ──────────────────
const RTC_CFG={iceServers:[
  {urls:'stun:stun.l.google.com:19302'},
  {urls:'stun:stun1.l.google.com:19302'},
  {urls:'stun:stun2.l.google.com:19302'},
]};
const RTC_STATES=['idle','calling','connecting','connected','failed'];

function setRtcState(state,label){
  S.rtc.state=state;
  const dot=$('cb-dot'); if(dot){dot.className='cb-dot '+state;}
  if(label&&$('cb-status')) $('cb-status').textContent=label;
}

window.toggleVoice=async()=>{S.rtc.inCall?endCall():await startCall();};

async function startCall(){
  if(!S.socket||!S.room){toast('Join a room first');return;}
  if(S.rtc.inCall)return;
  try{
    S.rtc.stream=await navigator.mediaDevices.getUserMedia({audio:true,video:false});
    setupPc('caller');
    S.rtc.stream.getTracks().forEach(t=>S.rtc.pc.addTrack(t,S.rtc.stream));
    const offer=await S.rtc.pc.createOffer({offerToReceiveAudio:true});
    await S.rtc.pc.setLocalDescription(offer);
    S.socket.emit('rtc_offer',{roomId:S.room.id,offer});
    S.rtc.inCall=true;
    setCallUI(true);setRtcState('calling','Calling…');
    // BUG FIX #7: timeout if no answer
    S.rtc._connectTimer=setTimeout(()=>{if(S.rtc.state!=='connected'){toast('No answer — call ended');endCall();}},20000);
  }catch(ex){toast('Mic error: '+ex.message);endCall();}
}

function setupPc(role){
  if(S.rtc.pc){S.rtc.pc.close();S.rtc.pc=null;}
  const pc=new RTCPeerConnection(RTC_CFG);
  pc.ontrack=e=>{const a=$('remote-audio');if(a)a.srcObject=e.streams[0];};
  pc.onicecandidate=e=>{if(e.candidate&&S.socket&&S.room)S.socket.emit('rtc_ice',{roomId:S.room.id,candidate:e.candidate});};
  pc.onconnectionstatechange=()=>{
    const st=pc.connectionState;
    if(st==='connected'){clearTimeout(S.rtc._connectTimer);setRtcState('connected','In call 🎙');toast('Call connected!');}
    if(st==='disconnected'){setRtcState('connecting','Reconnecting…');}
    if(st==='failed'){setRtcState('failed','Call failed');toast('Call failed');endCall();}
  };
  pc.onicegatheringstatechange=()=>{};
  S.rtc.pc=pc;
}

async function handleRtcOffer(offer){
  if(!S.socket||!S.room)return;
  try{
    S.rtc.stream=await navigator.mediaDevices.getUserMedia({audio:true,video:false});
    setupPc('answerer');
    S.rtc.stream.getTracks().forEach(t=>S.rtc.pc.addTrack(t,S.rtc.stream));
    await S.rtc.pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer=await S.rtc.pc.createAnswer();
    await S.rtc.pc.setLocalDescription(answer);
    S.socket.emit('rtc_answer',{roomId:S.room.id,answer});
    S.rtc.inCall=true;setCallUI(true);setRtcState('connecting','Connecting…');
  }catch(ex){toast('Call error: '+ex.message);endCall();}
}
async function handleRtcAnswer(a){if(S.rtc.pc){try{await S.rtc.pc.setRemoteDescription(new RTCSessionDescription(a));}catch{}}}
async function handleRtcIce(c){if(S.rtc.pc){try{await S.rtc.pc.addIceCandidate(new RTCIceCandidate(c));}catch{}}}
function handleRtcHangup(){sysMsg('Partner ended the call');endCall();}

function endCall(){
  clearTimeout(S.rtc._connectTimer);
  if(S.socket&&S.room&&S.rtc.inCall) S.socket.emit('rtc_hangup',{roomId:S.room.id});
  S.rtc.stream?.getTracks().forEach(t=>t.stop());
  S.rtc.pc?.close();
  S.rtc={pc:null,stream:null,inCall:false,muted:false,state:'idle',_connectTimer:null};
  setCallUI(false);
  // Clear partner mute
  $('cb-partner-mute')?.classList.add('hidden');
  $('vwh-mute')?.classList.add('hidden');
  $('vwg-mute')?.classList.add('hidden');
}
window.endCall=endCall;

// BUG FIX #8: toggleMute broadcasts mute state to partner
window.toggleMute=()=>{
  if(!S.rtc.stream)return;
  S.rtc.muted=!S.rtc.muted;
  S.rtc.stream.getAudioTracks().forEach(t=>t.enabled=!S.rtc.muted);
  $('cb-mute')?.classList.toggle('muted',S.rtc.muted);
  // Broadcast mute status
  if(S.socket&&S.room) S.socket.emit('mute_status',{roomId:S.room.id,muted:S.rtc.muted});
  toast(S.rtc.muted?'Muted 🔇':'Unmuted 🎙');
};

function setCallUI(active,status){
  $('call-bar')?.classList.toggle('hidden',!active);
  $('voice-btn')?.classList.toggle('active',active);
  if(status&&$('cb-status')) $('cb-status').textContent=status;
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function esc(t){return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
let _tt;
function toast(msg){const el=$('toast');el.textContent=msg;el.classList.remove('hidden');el.classList.add('show');clearTimeout(_tt);_tt=setTimeout(()=>el.classList.remove('show'),2900);}
window.toast=toast;
