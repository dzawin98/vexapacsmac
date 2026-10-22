/**
 * Probe link share publik: baris di public_share_links + setelan base URL publik.
 * Pakai dari RIS/backend: node scripts/probe-public-share.js [token]
 */
require('dotenv').config({ path: './.env' })
const pool = require('../src/services/db')

const token = process.argv[2]

;(async () => {
  try {
    const [cols] = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'public_share_links' ORDER BY ordinal_position"
    )
    console.log('kolom public_share_links:', cols.map(c => c.column_name).join(' '))

    const [rows] = await pool.query(
      'SELECT token, study_instance_uid, created_by, created_at, expires_at, patient_phone, template_id FROM public_share_links ORDER BY created_at DESC LIMIT 10'
    )
    console.log('jumlah baris ditampilkan:', rows.length)
    for (const row of rows) {
      console.log(' ', JSON.stringify(row).slice(0, 300))
    }

    if (token) {
      const [hit] = await pool.query('SELECT * FROM public_share_links WHERE token = ?', [token])
      console.log('')
      console.log('token yang dikeluhkan ada =', hit.length ? 'YA' : 'TIDAK')
      if (hit.length) {
        const r = hit[0]
        const exp = r.expires_at ? new Date(r.expires_at) : null
        console.log('  study:', r.study_instance_uid)
        console.log('  expires_at:', exp ? `${exp.toISOString()} (${exp.getTime() < Date.now() ? 'SUDAH LEWAT' : 'masih berlaku'})` : '(tanpa kedaluwarsa)')
      }
    }

    // Setelan link aplikasi (publicBaseUrl dsb) — dipakai backend untuk membangun URL share.
    const [keys] = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'ui_settings' ORDER BY ordinal_position"
    )
    console.log('')
    console.log('kolom ui_settings:', keys.map(c => c.column_name).join(' '))
    const [settingRows] = await pool.query('SELECT * FROM ui_settings LIMIT 5')
    for (const row of settingRows) {
      const text = JSON.stringify(row)
      console.log('  ui_settings:', text.slice(0, 400))
      for (const needle of ['publicBaseUrl', 'publicStudyPath']) {
        const idx = text.indexOf(needle)
        if (idx >= 0) console.log('    ->', text.slice(idx, idx + 80))
      }
    }
  } catch (error) {
    console.error('probe gagal:', error.message)
  } finally {
    process.exit(0)
  }
})()
