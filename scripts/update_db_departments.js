const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function run() {
  console.log('--- Updating Supabase Data ---');

  // 1. Rename department 1 to แผนกวิชาช่างยนต์ (AUTO)
  const { data: d1, error: e1 } = await sb
    .from('departments')
    .update({ name: 'แผนกวิชาช่างยนต์', code: 'AUTO' })
    .eq('id', 1)
    .select();
  console.log('Updated Dept 1:', d1, e1);

  // 2. Update student นายเอ to department_id: 2 (ช่างไฟฟ้ากำลัง)
  const { data: u, error: eu } = await sb
    .from('users')
    .update({
      department_id: 2
    })
    .eq('username', '7878985zf@xgmail.com')
    .select();
  console.log('Updated User นายเอ:', u, eu);

  // 3. Update existing requests of นายเอ to student_code: '22222222'
  const { data: r, error: er } = await sb
    .from('leave_requests')
    .update({
      student_code: '22222222'
    })
    .eq('student_id', '2c99f603-7825-4393-94f3-373317e14eac')
    .select();
  console.log('Updated Leave Requests count:', r ? r.length : 0, er);

  // 4. Verify all departments
  const { data: allDepts } = await sb.from('departments').select('*').order('id');
  console.log('All Departments:', allDepts);
}

run();
