const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function run() {
  const r1 = await sb.rpc('exec_sql', { sql: 'SELECT 1' });
  console.log('RPC exec_sql:', r1);
  const r2 = await sb.rpc('execute_sql', { query: 'SELECT 1' });
  console.log('RPC execute_sql:', r2);
}
run();
