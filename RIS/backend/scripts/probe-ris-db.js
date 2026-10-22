/**
 * Probe isi DB RIS: tabel apa saja yang ada + jumlah baris kandidat penting.
 * Dipakai untuk menjawab keluhan "data tidak tampil di UI": buktikan dulu datanya ADA di DB.
 *
 * Pakai (dari dalam RIS/backend supaya modul relatif resolve):
 *   node scripts/probe-ris-db.js
 */
require('dotenv').config({ path: './.env' })
const pool = require('../src/services/db')

const CANDIDATES = [
  'mwl_orders',
  'radiology_reports',
  'radiology_report_revisions',
  'qc_status',
  'qc_distribution',
  'patients',
  'mwl_logs',
  'audit_logs',
]

;(async () => {
  try {
    const [tables] = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
    )
    const names = tables.map((row) => row.table_name)
    console.log('jumlah tabel:', names.length)
    console.log('tabel:', names.join(' '))
    console.log('')

    for (const table of CANDIDATES) {
      if (!names.includes(table)) {
        console.log(table.padEnd(28), '= (tabel tidak ada)')
        continue
      }
      const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM ${table}`)
      console.log(table.padEnd(28), '=', rows[0]?.n)
    }

    // Kalau ada tabel laporan, tampilkan laporan terbaru supaya bisa dicocokkan dengan UI.
    const reportTable = ['radiology_reports', 'reports'].find((table) => names.includes(table))
    if (reportTable) {
      const [rows] = await pool.query(
        `SELECT * FROM ${reportTable} ORDER BY id DESC LIMIT 5`
      )
      console.log('')
      console.log(`${reportTable} terbaru:`)
      for (const row of rows) {
        const summary = Object.entries(row)
          .filter(([key, value]) => value != null && String(value).length < 60)
          .map(([key, value]) => `${key}=${value}`)
          .join(' | ')
        console.log(' ', summary.slice(0, 400))
      }
    }
  } catch (error) {
    console.error('probe gagal:', error.message)
  } finally {
    process.exit(0)
  }
})()
