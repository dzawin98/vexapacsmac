/**
 * Probe ringkas: berapa baris QC status + apakah studi laporan (ekspertise) punya baris QC.
 * Pakai dari RIS/backend: node scripts/probe-qc-status.js
 */
require('dotenv').config({ path: './.env' })
const pool = require('../src/services/db')

;(async () => {
  try {
    const [all] = await pool.query('SELECT COUNT(*) AS n FROM quality_control_status')
    console.log('quality_control_status =', all[0]?.n)
    const [rows] = await pool.query('SELECT * FROM quality_control_status ORDER BY study_instance_uid LIMIT 5')
    for (const row of rows) {
      console.log(' ', Object.entries(row).map(([k, v]) => `${k}=${v}`).join(' | ').slice(0, 300))
    }
    const uid = '1.2.826.0.1.3680043.10.5432.1781538491650.181287691'
    const [hit] = await pool.query('SELECT * FROM quality_control_status WHERE study_instance_uid = ?', [uid])
    console.log('')
    console.log('QC untuk studi laporan (', uid.slice(-20), ') =', hit.length, 'baris')
    const [ord] = await pool.query('SELECT id, status, tanggal_order, study_instance_uid, actual_study_instance_uid FROM mwl_orders WHERE study_instance_uid = ?', [uid])
    console.log('order untuk studi itu =', JSON.stringify(ord).slice(0, 300))
  } catch (error) {
    console.error('probe gagal:', error.message)
  } finally {
    process.exit(0)
  }
})()
