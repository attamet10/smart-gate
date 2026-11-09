const db = require('../db.js');

async function main() {
  await db.query("UPDATE onepass_requests SET status = 'approved', gate_out_at = NULL, gate_in_at = NULL, qr_expires_at = '2029-12-31 23:59:59' WHERE id = 8");
  const [rows] = await db.query("SELECT id, request_no, qr_token, status, gate_out_at, gate_in_at, qr_expires_at FROM onepass_requests WHERE id = 8");
  console.log('RESET SUCCESS:');
  console.log(JSON.stringify(rows[0], null, 2));
  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
