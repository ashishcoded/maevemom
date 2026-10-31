const fs = require('node:fs');
const path = process.env.FAKE_SUPABASE_DB;
const authId = process.env.FAKE_SUPABASE_AUTH_ID || '11111111-1111-4111-8111-111111111111';
let state = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : { app_users: [], profiles: [], profile_secrets: [], memories: [], memory_assets: [], storage: {} };
state.memories ||= []; state.memory_assets ||= []; state.storage ||= {};
const save = () => fs.writeFileSync(path, JSON.stringify(state), 'utf8');

function query(table, action = 'select', payload = null) {
  const filters = [];
  const query = {
    select() { return query; },
    eq(column, value) { filters.push([column, value]); return query; },
    in(column, values) { filters.push([column, values]); return query; },
    order() { return query; },
    single() { query.singleResult = true; return query; },
    maybeSingle() { query.maybeSingleResult = true; return query; },
    then(resolve, reject) {
      try {
        if (process.env.FAKE_SUPABASE_FAIL) return resolve({ data:null, error:{ code:'MOCK_DB_FAILURE' } });
        let rows = state[table] || [];
        for (const [column, value] of filters) rows = rows.filter(row => Array.isArray(value) ? value.includes(row[column]) : row[column] === value);
        if (action === 'insert') { rows = [payload]; state[table].push(payload); save(); }
        if (action === 'upsert') {
          const existing=state[table].find(row => table === 'profile_secrets' ? row.profile_id === payload.profile_id : table === 'memory_assets' ? row.memory_id === payload.memory_id && row.kind === payload.kind : table === 'memories' ? row.id === payload.id && row.user_id === payload.user_id : false);
          if (existing) Object.assign(existing,payload); else state[table].push(payload);
          rows=[existing || payload]; save();
        }
        if (action === 'update') { rows.forEach(row => Object.assign(row, payload)); save(); }
        if (action === 'delete') { state[table] = state[table].filter(row => !rows.includes(row)); rows = []; save(); }
        if (query.singleResult && rows.length !== 1) return resolve({ data: null, error: { code: 'PGRST116' } });
        resolve({ data: query.singleResult || query.maybeSingleResult ? (rows[0] || null) : rows, error: null });
      } catch (error) { reject(error); }
    },
  };
  return query;
}

function client() {
  return {
    auth: { signInWithPassword: async ({email}) => { const id=email === 'other@example.test' ? '22222222-2222-4222-8222-222222222222' : authId; return { data: { user: { id, email, email_confirmed_at: new Date().toISOString(), user_metadata: { display_name: email.split('@')[0] } } }, error: null }; } },
    rpc(name, params) {
      if (process.env.FAKE_SUPABASE_FAIL) return Promise.resolve({ data:null, error:{ code:'MOCK_DB_FAILURE' } });
      if (name === 'get_profile_pin_hashes') {
        const rows=state.profile_secrets.filter(secret => params.p_profile_ids.includes(secret.profile_id) && state.profiles.some(profile => profile.id === secret.profile_id && profile.user_id === params.p_user_id));
        return Promise.resolve({data:rows.map(row=>({profile_id:row.profile_id,pin_hash:row.pin_hash})),error:null});
      }
      const profile=state.profiles.find(row=>row.id === params.p_profile_id && row.user_id === params.p_user_id);
      if (!profile) return Promise.resolve({data:null,error:{code:'42501',message:'Profile ownership check failed'}});
      if (name === 'upsert_profile_pin_hash') {
        const existing=state.profile_secrets.find(row=>row.profile_id === params.p_profile_id);
        if (existing) Object.assign(existing,{pin_hash:params.p_pin_hash}); else state.profile_secrets.push({profile_id:params.p_profile_id,pin_hash:params.p_pin_hash});
        save();
      } else if (name === 'delete_profile_pin_hash') {
        state.profile_secrets=state.profile_secrets.filter(row=>row.profile_id !== params.p_profile_id);
        save();
      }
      return Promise.resolve({data:null,error:null});
    },
    from(table) {
      return { select: () => query(table), insert: values => query(table, 'insert', values), upsert: values => query(table, 'upsert', values), update: values => query(table, 'update', values), delete: () => query(table, 'delete') };
    },
    schema(schemaName) { return { from: table => this.from(schemaName === 'private' ? 'profile_secrets' : table) }; },
    storage: { from(bucket) { return {
      upload: async (storagePath, buffer, options) => { if (process.env.FAKE_SUPABASE_FAIL) return {data:null,error:{code:'MOCK_DB_FAILURE'}}; state.storage[`${bucket}/${storagePath}`]={base64:buffer.toString('base64'),mimeType:options.contentType}; save(); return {data:{path:storagePath},error:null}; },
      createSignedUrl: async storagePath => { if (process.env.FAKE_SUPABASE_FAIL) return {data:null,error:{code:'MOCK_DB_FAILURE'}}; const item=state.storage[`${bucket}/${storagePath}`]; return item ? {data:{signedUrl:`data:${item.mimeType};base64,${item.base64}`},error:null} : {data:null,error:{code:'MOCK_STORAGE_NOT_FOUND'}}; },
      remove: async paths => { if (process.env.FAKE_SUPABASE_FAIL) return {data:null,error:{code:'MOCK_DB_FAILURE'}}; paths.forEach(storagePath=>delete state.storage[`${bucket}/${storagePath}`]); save(); return {data:paths.map(path=>({name:path})),error:null}; },
    }; } },
  };
}

const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === '@supabase/supabase-js') return { createClient: client };
  return originalLoad.call(this, request, parent, isMain);
};

module.exports = { client };
