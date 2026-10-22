'use strict';

/**
 * Audit cakupan rules dose terhadap SEMUA study yang ada di PACS (read-only).
 *
 *   node scripts/audit-dose-coverage.js [--limit=N] [--modality=CT] [--json=<file>]
 *
 * Untuk tiap study: ekstraksi dose (dryRun, tidak menyentuh DB) lalu rekap
 *   - profil vendor mana yang kepilih, doseSource apa
 *   - field mana terisi, field mana kosong, dan seberapa sering
 * Keluarannya dipakai untuk memutuskan profil/alias baru apa yang perlu ditambah.
 *
 * Syarat: PACS hidup di DICOMWEB_PACS_ROOT, RIS backend bisa start di PORT audit.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BACKEND_DIR = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(BACKEND_DIR, '.env'), quiet: true });

const argOf = name => {
    const found = process.argv.slice(2).find(arg => arg.startsWith(`--${name}=`));
    return found ? found.split('=').slice(1).join('=') : '';
};
const limit = Number(argOf('limit') || 0);
const modalityFilter = argOf('modality').toUpperCase();
const jsonOut = argOf('json') || path.join(process.env.TEMP || process.env.TMP || BACKEND_DIR, 'dose-coverage.json');
const PORT = Number(process.env.DOSE_AUDIT_PORT || 8098);
const BASE = `http://127.0.0.1:${PORT}`;
const headers = { 'x-user-role': 'administrator', 'content-type': 'application/json' };
const logFile = path.join(process.env.TEMP || process.env.TMP || BACKEND_DIR, 'dose-audit-backend.log');
const pacsRoot = String(process.env.DICOMWEB_PACS_RS_ROOT || `${process.env.DICOMWEB_PACS_ROOT || 'http://127.0.0.1:5001'}/rs`).replace(/\/+$/, '');

const main = async () => {
    const studiesRes = await fetch(`${pacsRoot}/studies`);
    if (!studiesRes.ok) throw new Error(`PACS /studies gagal: HTTP ${studiesRes.status}`);
    const studies = await studiesRes.json();
    let list = studies.map(study => ({
        uid: study['0020000D']?.Value?.[0] || '',
        modalities: study['00080061']?.Value || [],
        description: study['00081030']?.Value?.[0] || '',
        date: study['00080020']?.Value?.[0] || '',
    })).filter(entry => entry.uid);
    if (modalityFilter) list = list.filter(entry => entry.modalities.includes(modalityFilter));
    if (limit > 0) list = list.slice(0, limit);
    console.log(`study diuji: ${list.length}${modalityFilter ? ` (modality ${modalityFilter})` : ''} dari ${studies.length} study di PACS`);

    const log = fs.openSync(logFile, 'w');
    const child = spawn(process.execPath, ['index.js'], {
        cwd: BACKEND_DIR,
        env: { ...process.env, PORT: String(PORT) },
        stdio: ['ignore', log, log],
    });
    const call = async body => {
        const res = await fetch(`${BASE}/api/dose/reextract`, { method: 'POST', headers, body: JSON.stringify(body) });
        return res.json();
    };

    try {
        let ready = false;
        for (let i = 0; i < 60 && !ready; i += 1) {
            try {
                ready = (await fetch(`${BASE}/api/dose/rules`, { headers })).status === 200;
            } catch { /* belum siap */ }
            if (!ready) await new Promise(resolve => setTimeout(resolve, 2000));
        }
        if (!ready) throw new Error(`backend tidak siap di port ${PORT}, lihat ${logFile}`);

        const rows = [];
        for (const [index, study] of list.entries()) {
            const payload = await call({ studyInstanceUid: study.uid, dryRun: true });
            const result = payload.results?.[0] || {};
            rows.push({ ...study, ...result });
            const label = `${String(index + 1).padStart(3)}/${list.length}`;
            console.log(`${label} ${(study.modalities.join(',') || '-').padEnd(8)} ${result.status.padEnd(11)} profil=${(result.profile || '(default)').padEnd(14)} sumber=${(result.doseSource || '-').padEnd(16)} isi=${(result.extractedFields || []).join(',') || '-'}${(result.missingFields || []).length ? ` | kosong=${result.missingFields.join(',')}` : ''}`);
        }

        const tally = (field) => rows.reduce((acc, row) => {
            const key = String(row[field] || '(kosong)');
            acc[key] = (acc[key] || 0) + 1;
            return acc;
        }, {});
        const ok = rows.filter(row => row.status !== 'failed' && (row.extractedFields || []).length);
        const fieldCounts = {};
        for (const row of rows) {
            for (const name of row.extractedFields || []) fieldCounts[name] = (fieldCounts[name] || 0) + 1;
        }
        const missingCounts = {};
        for (const row of rows) {
            for (const name of row.missingFields || []) missingCounts[name] = (missingCounts[name] || 0) + 1;
        }

        const report = {
            waktu: new Date().toISOString(),
            jumlahStudy: rows.length,
            berhasil: ok.length,
            status: tally('status'),
            profil: tally('profile'),
            sumber: tally('doseSource'),
            fieldTerisi: Object.fromEntries(Object.entries(fieldCounts).sort((a, b) => b[1] - a[1])),
            fieldKosong: Object.fromEntries(Object.entries(missingCounts).sort((a, b) => b[1] - a[1])),
            perStudy: rows.map(({ uid, modalities, description, date, status, profile, doseSource, extractedFields, missingFields, values, error, reason }) =>
                ({ uid, modalities, description, date, status, profile, doseSource, extractedFields, missingFields, values, error, reason })),
        };
        fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));

        console.log('\n-- rekap --');
        console.log('study diekstraksi   :', `${ok.length}/${rows.length}`);
        console.log('status              :', JSON.stringify(report.status));
        console.log('profil kepilih      :', JSON.stringify(report.profil));
        console.log('sumber dose         :', JSON.stringify(report.sumber));
        console.log('field paling terisi :', JSON.stringify(report.fieldTerisi));
        console.log('field paling kosong :', JSON.stringify(report.fieldKosong));
        console.log('detail JSON         :', jsonOut);
    } finally {
        child.kill();
    }
};

main().catch(error => { console.error('GAGAL:', error.message); process.exit(1); });
