const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

const port = 3328;
const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, 'tests', '.tmp-profile-repository-enabled-data');
const mediaDir = path.join(root, 'tests', '.tmp-profile-repository-enabled-uploads');
const fakeDb = path.join(root, 'tests', '.tmp-profile-repository-enabled-db.json');
const authId = '11111111-1111-4111-8111-111111111111';
let child;

async function start(overrides = {}) {
  child = spawn(process.execPath, ['-r', path.join(root, 'tests', 'fixtures', 'mock-supabase.cjs'), 'server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT:String(port), DATA_DIR:dataDir, MEDIA_DIR:mediaDir,
      USE_SUPABASE_PROFILE_REPOSITORY:'true', SUPABASE_URL:'https://mock.local', SUPABASE_PUBLISHABLE_KEY:'publishable', SUPABASE_SECRET_KEY:'server-only',
      FAKE_SUPABASE_DB:fakeDb, FAKE_SUPABASE_AUTH_ID:authId, ...overrides },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/auth/me`)).status === 401) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Test server did not start');
}
async function stop() { child?.kill(); await new Promise(resolve => child?.once('exit', resolve)); }
async function request(url, options = {}) { return fetch(`http://127.0.0.1:${port}/api${url}`, options); }
async function login() {
  const response = await request('/auth/email-login', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({email:'mock@example.test',password:'not-used'}) });
  const body=await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.token;
}

test.before(async () => { await fs.rm(dataDir, {recursive:true,force:true}); await fs.rm(mediaDir, {recursive:true,force:true}); await fs.rm(fakeDb, {force:true}); await start(); });
test.after(async () => { await stop(); await fs.rm(dataDir, {recursive:true,force:true}); await fs.rm(mediaDir, {recursive:true,force:true}); await fs.rm(fakeDb, {force:true}); });

test('repository mode persists a profile PIN and rejects wrong PIN after restart', async () => {
  let token = await login();
  let response = await request('/profiles', { method:'POST', headers:{authorization:`Bearer ${token}`,'content-type':'application/json'}, body:JSON.stringify({name:'Locked',pin:'1234'}) });
  assert.equal(response.status, 200);
  const created = (await response.json()).profile;
  assert.equal(created.locked, true);
  await stop();
  await start();
  token = await login();
  response = await request(`/profiles/${created.id}/activate`, { method:'POST', headers:{authorization:`Bearer ${token}`,'content-type':'application/json'}, body:JSON.stringify({pin:'0000'}) });
  assert.equal(response.status, 401);
  response = await request(`/profiles/${created.id}/activate`, { method:'POST', headers:{authorization:`Bearer ${token}`,'content-type':'application/json'}, body:JSON.stringify({pin:'1234'}) });
  assert.equal(response.status, 200);
});

test('repository mode rejects legacy IDs and reports database failures safely', async () => {
  let response = await request('/auth/login', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({username:'ashish',password:'ashish123'}) });
  assert.equal(response.status, 200);
  const legacyToken=(await response.json()).token;
  response = await request('/auth/me', { headers:{authorization:`Bearer ${legacyToken}`} });
  assert.equal(response.status, 401);

  const verifiedToken=await login();
  await stop();
  await start({FAKE_SUPABASE_FAIL:'1'});
  response = await request('/auth/me', { headers:{authorization:`Bearer ${verifiedToken}`} });
  assert.equal(response.status, 503);
  const body=await response.json();
  assert.deepEqual(body,{error:'Account data is temporarily unavailable'});
});
