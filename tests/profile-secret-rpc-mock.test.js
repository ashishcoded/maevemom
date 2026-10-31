const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dbPath = path.join(__dirname, '.tmp-profile-secret-rpc-db.json');
const ownerId = '11111111-1111-4111-8111-111111111111';
const otherUserId = '22222222-2222-4222-8222-222222222222';
const profileId = '33333333-3333-4333-8333-333333333333';
process.env.FAKE_SUPABASE_DB = dbPath;
delete process.env.FAKE_SUPABASE_FAIL;
fs.writeFileSync(dbPath, JSON.stringify({ app_users:[], profiles:[{id:profileId,user_id:ownerId}], profile_secrets:[] }), 'utf8');
const { client } = require('./fixtures/mock-supabase.cjs');

test.after(() => { try { fs.unlinkSync(dbPath); } catch {} delete process.env.FAKE_SUPABASE_FAIL; });

test('PIN RPC mock supports success and rejects wrong ownership', async () => {
  const supabase=client();
  let result=await supabase.rpc('upsert_profile_pin_hash',{p_user_id:ownerId,p_profile_id:profileId,p_pin_hash:'bcrypt-hash'});
  assert.equal(result.error,null);
  result=await supabase.rpc('get_profile_pin_hashes',{p_user_id:ownerId,p_profile_ids:[profileId]});
  assert.deepEqual(result.data,[{profile_id:profileId,pin_hash:'bcrypt-hash'}]);
  result=await supabase.rpc('upsert_profile_pin_hash',{p_user_id:otherUserId,p_profile_id:profileId,p_pin_hash:'wrong'});
  assert.equal(result.error.code,'42501');
  result=await supabase.rpc('delete_profile_pin_hash',{p_user_id:otherUserId,p_profile_id:profileId});
  assert.equal(result.error.code,'42501');
});

test('PIN RPC mock returns database errors without data', async () => {
  process.env.FAKE_SUPABASE_FAIL='1';
  const result=await client().rpc('get_profile_pin_hashes',{p_user_id:ownerId,p_profile_ids:[profileId]});
  assert.equal(result.data,null);
  assert.equal(result.error.code,'MOCK_DB_FAILURE');
});
