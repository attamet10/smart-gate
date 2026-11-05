const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function run() {
  const { data } = await sb.from('users').select('*').limit(1);
  console.log('USERS COLUMNS:', Object.keys(data[0]));
}
run();
