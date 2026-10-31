const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

const port = 3327;
const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, 'tests', '.tmp-profile-repository-data');
const mediaDir = path.join(root, 'tests', '.tmp-profile-repository-uploads');
let child;

async function waitForServer() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/auth/me`);
      if (response.status === 401) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Test server did not start');
}

test.before(async () => {
  await fs.rm(dataDir, { recursive:true, force:true });
  await fs.rm(mediaDir, { recursive:true, force:true });
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: { ...process.env, PORT:String(port), DATA_DIR:dataDir, MEDIA_DIR:mediaDir,
      USE_SUPABASE_PROFILE_REPOSITORY:'', SUPABASE_URL:'', SUPABASE_PUBLISHABLE_KEY:'', SUPABASE_SECRET_KEY:'' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await waitForServer();
});

test.after(async () => {
  child?.kill();
  await fs.rm(dataDir, { recursive:true, force:true });
  await fs.rm(mediaDir, { recursive:true, force:true });
});

async function request(path, body = {}) {
  return fetch(`http://127.0.0.1:${port}/api${path}`, {
    method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body),
  });
}

test('signup and login stay disabled when Supabase is not configured', async () => {
  assert.equal((await request('/auth/signup', { email:'bad', password:'long-enough-password' })).status, 503);
  assert.equal((await request('/auth/email-login', {})).status, 503);
});

test('protected auth, profile loading, and logout require an app session', async () => {
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/auth/me`)).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/profiles`)).status, 401);
  assert.equal((await request('/auth/logout')).status, 401);
});
