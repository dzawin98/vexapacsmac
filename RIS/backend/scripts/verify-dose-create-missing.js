'use strict';

/**
 * Verifikasi end-to-end reextract + createMissing terhadap data NYATA.
 *
 *   node scripts/verify-dose-create-missing.js <studyInstanceUid>
 *
 * Syarat: PostgreSQL 'veloris_db' hidup, PACS hidup di 5001, study punya series SR.
 * Yang dilakukan:
 *   1. buat order MWL SEMENTARA (accession ZZ-VERIFY-DOSE-1) untuk study itu
 *   2. start index.js di port 8099
 *   3. POST /api/dose/reextract { dryRun:true, createMissing:true }  -> would-create
 *   4. POST /api/dose/reextract { createMissing:true }               -> created + baris DB
 *   5. jalankan ulang (idempotensi)                                  -> tidak bikin baris kedua
 *   6. BERSIH-BERSIH: hapus baris dose_report & order MWL sementara
 *
 * Tanpa langkah 6 data uji akan tertinggal, jadi blok finally selalu dijalankan.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BACKEND_DIR = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(BACKEND_DIR, '.env'), quiet: true });
const { Pool } = require('pg');

const studyUid = String(process.argv[2] || '').trim();
if (!studyUid) {
    console.error('Pakai: node scripts/verify-dose-create-missing.js <studyInstanceUid>');
    process.exit(1);
}

const ACCESSION = 'ZZ-VERIFY-DOSE-1';
const PORT = Number(process.env.DOSE_VERIFY_PORT || 8099);
const BASE = `http://127.0.0.1:${PORT}`;
const headers = { 'x-user-role': 'administrator', 'content-type': 'application/json' };
const logFile = path.join(process.env.TEMP || process.env.TMP || BACKEND_DIR, 'dose-verify-backend.log');

const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
});

const countRows = async () => (await pool.query('SELECT COUNT(*)::int AS total FROM dose_report')).rows[0].total;

const main = async () => {
    const patient = (await pool.query(
        'SELECT id, no_rm, nama_pasien FROM patients ORDER BY id LIMIT 1'
    )).rows[0];
    if (!patient) throw new Error('tabel patients kosong');
    console.log('pasien uji   :', patient.id, patient.no_rm, patient.nama_pasien);

    // Bersihkan sisa run sebelumnya supaya hasilnya tidak ambigu.
    await pool.query('DELETE FROM dose_report WHERE accession_number = $1', [ACCESSION]);
    await pool.query('DELETE FROM dose_report WHERE study_instance_uid = $1', [studyUid]);
    await pool.query('DELETE FROM mwl_orders WHERE accession_number = $1', [ACCESSION]);

    const order = await pool.query(
        `INSERT INTO mwl_orders (patient_record_id, accession_number, study_instance_uid, study_date, study_time,
             modality, cito, procedure_code, procedure_desc, nama_radiolog, nama_radiografer, nama_ruangan,
             modality_station_ae, status)
         VALUES ($1,$2,$3,'2026-06-15','09:57:45','CT','N','CT-KEPALA','CT Scan Kepala (verifikasi)',
                 'dr. Radiolog Uji','Radiografer Uji','Ruang CT 1','CT_VEXA','COMPLETED') RETURNING id`,
        [patient.id, ACCESSION, studyUid]
    );
    const orderId = order.rows[0].id;
    console.log('order sementara:', orderId, ACCESSION);

    const log = fs.openSync(logFile, 'w');
    const child = spawn(process.execPath, ['index.js'], {
        cwd: BACKEND_DIR,
        env: { ...process.env, PORT: String(PORT) },
        stdio: ['ignore', log, log],
    });
    const call = async body => {
        const res = await fetch(`${BASE}/api/dose/reextract`, { method: 'POST', headers, body: JSON.stringify(body) });
        return { status: res.status, json: await res.json() };
    };
    const waitReady = async () => {
        for (let i = 0; i < 60; i += 1) {
            try {
                if ((await fetch(`${BASE}/api/dose/rules`, { headers })).status === 200) return true;
            } catch { /* server belum siap */ }
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        return false;
    };

    try {
        if (!await waitReady()) throw new Error(`backend tidak siap di port ${PORT}, lihat ${logFile}`);

        const before = await countRows();
        const dry = await call({ studyInstanceUid: studyUid, createMissing: true, dryRun: true });
        const dryResult = dry.json.results?.[0] || {};
        console.log('dryRun       :', dry.status, JSON.stringify(dryResult));
        if (dryResult.status !== 'would-create') throw new Error(`dryRun harus would-create, dapat ${dryResult.status}`);

        const real = await call({ studyInstanceUid: studyUid, createMissing: true });
        const realResult = real.json.results?.[0] || {};
        console.log('reextract    :', real.status, JSON.stringify({
            created: real.json.created, updated: real.json.updated, skipped: real.json.skipped,
            failed: real.json.failed, result: realResult,
        }));
        const after = await countRows();
        console.log('baris dose   :', before, '->', after, '(+' + (after - before) + ')');

        const row = (await pool.query(
            'SELECT id, mwl_order_id, capture_mode, patient_id, patient_name, accession_number, modality_code, study_date, study_time, sex, birth_date, radiologist, technologist, room, ae_title, values_json FROM dose_report WHERE study_instance_uid = $1',
            [studyUid]
        )).rows[0];
        if (!row) throw new Error('baris dose_report tidak terbentuk');
        console.log('isi baris    :', JSON.stringify(row));

        const second = await call({ studyInstanceUid: studyUid, createMissing: true });
        const secondStatus = second.json.results?.[0]?.status;
        console.log('run kedua    :', secondStatus, '(idempoten: tidak menambah baris)');
        const finalCount = await countRows();
        if (finalCount !== after) throw new Error(`run kedua menambah baris (${after} -> ${finalCount})`);

        console.log('\nHASIL: createMissing berfungsi - baris dose_report dibuat dari order MWL + nilai hasil ekstraksi rules.');
    } finally {
        child.kill();
        const delRow = await pool.query('DELETE FROM dose_report WHERE study_instance_uid = $1 OR accession_number = $2', [studyUid, ACCESSION]);
        const delOrder = await pool.query('DELETE FROM mwl_orders WHERE accession_number = $1', [ACCESSION]);
        const left = await countRows();
        console.log('bersih-bersih:', 'dose_report dihapus', delRow.rowCount, '| order dihapus', delOrder.rowCount, '| total akhir', left);
        await pool.end();
    }
};

main().catch(async error => {
    console.error('GAGAL:', error.message);
    try { await pool.end(); } catch { /* ignore */ }
    process.exit(1);
});
