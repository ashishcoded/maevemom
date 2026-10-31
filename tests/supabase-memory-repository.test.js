const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

const port = 3334;
const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, 'tests', '.tmp-memory-repository-data');
const mediaDir = path.join(root, 'tests', '.tmp-memory-repository-uploads');
const fakeDb = path.join(root, 'tests', '.tmp-memory-repository-db.json');
const ownerId = '11111111-1111-4111-8111-111111111111';
const memoryId = '44444444-4444-4444-8444-444444444444';
let child;

async function start(overrides = {}) {
  child=spawn(process.execPath,['-r',path.join(root,'tests','fixtures','mock-supabase.cjs'),'server/index.js'],{
    cwd:root,
    env:{...process.env,PORT:String(port),DATA_DIR:dataDir,MEDIA_DIR:mediaDir,USE_SUPABASE_PROFILE_REPOSITORY:'true',USE_SUPABASE_MEMORY_REPOSITORY:'true',SUPABASE_URL:'https://mock.local',SUPABASE_PUBLISHABLE_KEY:'publishable',SUPABASE_SECRET_KEY:'server-only',FAKE_SUPABASE_DB:fakeDb,...overrides},
    stdio:['ignore','ignore','ignore'],
  });
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){try{if((await fetch(`http://127.0.0.1:${port}/api/auth/me`)).status===401)return;}catch{} await new Promise(resolve=>setTimeout(resolve,100));}
  throw new Error('Test server did not start');
}
async function stop(){if(!child)return; child.kill(); await new Promise(resolve=>child.once('exit',resolve)); child=null;}
async function request(url,options={}){return fetch(`http://127.0.0.1:${port}/api${url}`,options);}
async function login(email='mock@example.test'){
  const response=await request('/auth/email-login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password:'not-used'})});
  assert.equal(response.status,200);
  return (await response.json()).token;
}
function jsonHeaders(token){return {authorization:`Bearer ${token}`,'content-type':'application/json'};}

test.before(async()=>{await fs.rm(dataDir,{recursive:true,force:true});await fs.rm(mediaDir,{recursive:true,force:true});await fs.rm(fakeDb,{force:true});await start();});
test.after(async()=>{await stop();await fs.rm(dataDir,{recursive:true,force:true});await fs.rm(mediaDir,{recursive:true,force:true});await fs.rm(fakeDb,{force:true});});

test('memory repository persists dates and image/audio metadata across restart',{concurrency:false},async()=>{
  const token=await login(), selectedDate=Date.UTC(2024,6,14,12,0,0);
  const image='data:image/png;base64,iVBORw0KGgo=';
  const audio='data:audio/webm;codecs=opus;base64,GkXfow==';
  let response=await request('/memories',{method:'POST',headers:jsonHeaders(token),body:JSON.stringify({id:memoryId,t:selectedDate,made:selectedDate+12345,text:'A persistent memory',color:'#aabbcc',img:image,audio})});
  assert.equal(response.status,201);
  response=await request('/memories',{headers:{authorization:`Bearer ${token}`}});
  assert.equal(response.status,200);
  let body=await response.json();
  assert.equal(body.items.length,1);
  assert.equal(body.items[0].t,selectedDate);
  assert.equal(body.items[0].text,'A persistent memory');
  assert.match(body.items[0].img,/^data:image\/png;base64,/);
  assert.match(body.items[0].audio,/^data:audio\/webm;base64,/);
  const persisted=JSON.parse(await fs.readFile(fakeDb,'utf8'));
  assert.equal(persisted.memories[0].user_id,ownerId);
  assert.equal(persisted.memories[0].made_at,new Date(selectedDate).toISOString());
  assert.deepEqual(persisted.memory_assets.map(asset=>asset.kind).sort(),['audio','image']);
  assert.ok(persisted.memory_assets.every(asset=>asset.user_id===ownerId && asset.storage_path.startsWith(`${ownerId}/${memoryId}/`)));

  await stop(); await start();
  const restartedToken=await login();
  response=await request('/memories',{headers:{authorization:`Bearer ${restartedToken}`}});
  body=await response.json();
  assert.equal(body.items.length,1);
  assert.equal(body.items[0].t,selectedDate);
  assert.match(body.items[0].audio,/^data:audio\/webm;base64,/);
});

test('memory repository accepts MediaRecorder codec parameters but rejects mislabeled audio',{concurrency:false},async()=>{
  const token=await login();
  const audioMemoryId='22222222-2222-4222-8222-222222222222';
  let response=await request('/memories',{method:'POST',headers:jsonHeaders(token),body:JSON.stringify({id:audioMemoryId,t:Date.now(),made:Date.now(),text:'voice compatibility',audio:'data:audio/webm;codecs=opus;base64,GkXfow=='})});
  assert.equal(response.status,201);
  response=await request('/memories',{method:'POST',headers:jsonHeaders(token),body:JSON.stringify({id:'bad-audio-memory',t:Date.now(),made:Date.now(),audio:'data:audio/webm;codecs=opus;base64,AAAA'})});
  assert.equal(response.status,400);
  assert.deepEqual(await response.json(),{error:'Invalid audio attachment'});
  response=await request(`/memories/${audioMemoryId}`,{method:'DELETE',headers:jsonHeaders(token)});
  assert.equal(response.status,200);
});

test('memory repository enforces user isolation and deletes owned assets',{concurrency:false},async()=>{
  const ownerToken=await login(), otherToken=await login('other@example.test');
  let response=await request('/memories',{headers:{authorization:`Bearer ${otherToken}`}});
  assert.equal((await response.json()).items.length,0);
  response=await request(`/memories/${memoryId}`,{method:'DELETE',headers:{authorization:`Bearer ${otherToken}`}});
  assert.equal(response.status,404);
  response=await request(`/memories/${memoryId}`,{method:'DELETE',headers:{authorization:`Bearer ${ownerToken}`}});
  assert.equal(response.status,200);
  const persisted=JSON.parse(await fs.readFile(fakeDb,'utf8'));
  assert.equal(persisted.memories.length,0,JSON.stringify(persisted.memories));
  assert.equal(persisted.memory_assets.length,0);
  assert.deepEqual(persisted.storage,{});
});

test('memory repository returns a generic 503 when Supabase is unavailable',{concurrency:false},async()=>{
  const token=await login();
  await stop(); await start({FAKE_SUPABASE_FAIL:'1'});
  const response=await request('/memories',{headers:{authorization:`Bearer ${token}`}});
  assert.equal(response.status,503);
  assert.deepEqual(await response.json(),{error:'Account data is temporarily unavailable'});
});
