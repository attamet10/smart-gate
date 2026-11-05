const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function run() {
  console.log('--- Seeding Classrooms for all 5 departments ---');

  // 1. Update classroom 1
  await sb.from('classrooms').update({
    name: 'ปวช.3/1 (ช่างยนต์)',
    department_id: 1,
    advisor_name: 'อ.อนุสรณ์ ช่างยนต์'
  }).eq('id', 1);

  // 2. Upsert classrooms 2, 3, 4, 5
  const newClasses = [
    { id: 2, name: 'ปวส.2/1 (ช่างไฟฟ้ากำลัง)', department_id: 2, advisor_name: 'อ.กิตติศักดิ์ ไฟฟ้า' },
    { id: 3, name: 'ปวช.2/1 (การบัญชี)', department_id: 3, advisor_name: 'อ.พิมพา บัญชี' },
    { id: 4, name: 'ปวช.3/1 (เทคโนโลยีธุรกิจดิจิทัล)', department_id: 4, advisor_name: 'อ.ธนากร ดิจิทัล' },
    { id: 5, name: 'ปวช.2/1 (การจัดการสำนักงาน)', department_id: 5, advisor_name: 'อ.นภาวรรณ สำนักงาน' }
  ];

  for (const c of newClasses) {
    const { error } = await sb.from('classrooms').upsert(c, { onConflict: 'id' });
    if (error) console.warn('Classroom error:', c.name, error.message);
  }

  // 3. Update student นายเอ to classroom_id: 2 (ช่างไฟฟ้ากำลัง ปวส.2/1)
  const { error: ue } = await sb.from('users').update({
    classroom_id: 2,
    department_id: 2
  }).eq('username', '7878985zf@xgmail.com');
  console.log('Updated user classroom:', ue);

  const { data: allCls } = await sb.from('classrooms').select('*').order('id');
  console.log('ALL CLASSROOMS NOW:', allCls);
}

run();
