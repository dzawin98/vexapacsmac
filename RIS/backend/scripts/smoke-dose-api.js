'use strict';

/**
 * Smoke test endpoint dose (butuh PostgreSQL 'ris' hidup).
 *
 *   node scripts/smoke-dose-api.js
 *
 * Menjalankan index.js di port sementara (default 8099), lalu memanggil
 * /api/dose/rules, /api/dose/diagnostics, dan /api/dose/reextract untuk
 * memastikan jalur rules file -> service benar-benar hidup.
 *
 * PACS tidak perlu hidup: bagian re-extract boleh gagal (dicatat sebagai
 * "failed"), yang diuji adalah wiring + penanganan errornya.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const backendDir = path.resolve(__dirname, '..');
const port = Number(process.env.SMOKE_PORT || 8099);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dose-smoke-'));
const rulesPath = path.join(tmpDir, 'dose-rules.json');

let passed = 0;
let failed = 0;
const check = (name, condition, detail) => {
    if (condition) {
        passed += 1;
        console.log(`  PASS  ${name}`);
    } else {
        failed += 1;
        console.log(`  FAIL  ${name}${detail === undefined ? '' : `  -> ${JSON.stringify(detail).slice(0, 400)}`}`);
    }
};

const base = `http://127.0.0.1:${port}`;
const headers = { 'x-user-role': 'administrator', 'content-type': 'application/json' };
const call = async (method, url, body) => {
    const response = await fetch(`${base}${url}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload = null;
    try {
        payload = await response.json();
    } catch (_) {
        payload = null;
    }
    return { status: response.status, payload };
};

(async () => {
    console.log(`# smoke dose API (port ${port}, rules ${rulesPath})`);
    const child = spawn(process.execPath, ['index.js'], {
        cwd: backendDir,
        env: { ...process.env, PORT: String(port), VEXA_DOSE_RULES_PATH: rulesPath },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const logLines = [];
    child.stdout.on('data', chunk => logLines.push(String(chunk)));
    child.stderr.on('data', chunk => logLines.push(String(chunk)));

    const ready = await new Promise(resolve => {
        const deadline = Date.now() + 60000;
        const tick = setInterval(() => {
            if (logLines.join('').includes('listening at')) {
                clearInterval(tick);
                resolve(true);
            } else if (Date.now() > deadline || child.exitCode !== null) {
                clearInterval(tick);
                resolve(false);
            }
        }, 500);
    });
    check('backend siap (Listening + DB connected)', ready && logLines.join('').includes('Connected to PostgreSQL'));
    if (!ready) {
        console.log(logLines.join('').slice(-2000));
        child.kill();
        process.exit(1);
    }
    await new Promise(resolve => setTimeout(resolve, 1500));

    // 1. File rules belum ada -> endpoint membuat default dan memakainya.
    const rulesDefault = await call('GET', '/api/dose/rules');
    check('GET /api/dose/rules -> 200', rulesDefault.status === 200, rulesDefault.status);
    check('file default otomatis dibuat di server', fs.existsSync(rulesPath));
    check('source = default-file + autoCreated', rulesDefault.payload?.source === 'default-file' && rulesDefault.payload?.autoCreated === true,
        rulesDefault.payload && { source: rulesDefault.payload.source, autoCreated: rulesDefault.payload.autoCreated });
    check('ringkasan memuat profil vendor', (rulesDefault.payload?.summary?.profiles || []).length >= 4,
        rulesDefault.payload?.summary?.profiles?.map(profile => profile.id));
    check('tanpa warning', (rulesDefault.payload?.warnings || []).length === 0, rulesDefault.payload?.warnings);

    // 2. Edit file -> langsung berlaku (hot reload, tanpa restart).
    fs.writeFileSync(rulesPath, JSON.stringify({
        schemaVersion: 1,
        settings: { diagnosticLog: true },
        profiles: [{
            id: 'alat-baru-ct',
            match: { manufacturerContains: ['ALAT BARU'], modality: ['CT'] },
            seriesKeywords: ['rdsr', 'dose'],
            sr: { totalDlp: { aliases: ['dlp alat baru'], unit: 'mGy*cm' } },
        }],
    }), 'utf-8');
    const rulesCustom = await call('GET', '/api/dose/rules');
    check('edit file langsung terbaca tanpa restart', rulesCustom.payload?.source === 'custom', rulesCustom.payload?.source);
    check('profil alat baru tampil di ringkasan',
        (rulesCustom.payload?.summary?.profiles || []).some(profile => profile.id === 'alat-baru-ct'),
        rulesCustom.payload?.summary?.profiles?.map(profile => profile.id));

    // 3. File rusak -> default + warning, endpoint tetap 200.
    fs.writeFileSync(rulesPath, '{ rusak', 'utf-8');
    const rulesBroken = await call('GET', '/api/dose/rules');
    check('file rusak -> tetap 200 (tidak mematikan layanan)', rulesBroken.status === 200, rulesBroken.status);
    check('file rusak -> source invalid + warning', rulesBroken.payload?.source === 'invalid' && (rulesBroken.payload?.warnings || []).length > 0,
        rulesBroken.payload && { source: rulesBroken.payload.source, warnings: rulesBroken.payload.warnings });

    // 4. Diagnostics: log hasil ekstraksi bisa dibaca lewat HTTP.
    const diagnostics = await call('GET', '/api/dose/diagnostics?limit=5');
    check('GET /api/dose/diagnostics -> 200 + daftar entries', diagnostics.status === 200 && Array.isArray(diagnostics.payload?.entries),
        diagnostics.payload);

    // 5. Re-extract: dryRun + temuan study yang tidak ada di dose_report.
    const reextract = await call('POST', '/api/dose/reextract', { studyInstanceUid: '1.2.3.4.5.smoke', dryRun: true });
    check('POST /api/dose/reextract -> 200', reextract.status === 200, reextract.payload);
    check('reextract dryRun melaporkan hasil per study', Array.isArray(reextract.payload?.results) && reextract.payload.results.length === 1,
        reextract.payload?.results);
    check('nilai rules dilaporkan di respons reextract', Boolean(reextract.payload?.rulesPath), reextract.payload?.rulesPath);

    // createMissing: kalau ekstraksi bisa jalan tapi study belum punya baris,
    // harus jujur melaporkan no-record (+ alasan MWL) -- bukan berpura-pura create.
    // Tanpa PACS hidup, langkah ekstraksi gagal lebih dulu: itu juga diterima.
    const missing = await call('POST', '/api/dose/reextract', { studyInstanceUid: '1.2.3.4.5.smoke', dryRun: true, createMissing: true });
    check('createMissing -> 200 dan flag dilaporkan', missing.status === 200 && missing.payload?.createMissing === true, missing.payload?.createMissing);
    const firstMissing = missing.payload?.results?.[0] || {};
    const missingOk = firstMissing.status === 'failed'
        || (firstMissing.status === 'no-record' && /order MWL/.test(firstMissing.reason || ''));
    check('createMissing: hasil jujur (failed karena PACS mati, atau no-record + alasan MWL)', missingOk, firstMissing);
    check('createMissing tidak menambah baris saat dryRun', missing.payload?.created === 0, missing.payload);

    // 6. Validasi input: tanpa study/modality harus 400.
    const bad = await call('POST', '/api/dose/reextract', {});
    check('tanpa studyInstanceUid & modalityCode -> 400', bad.status === 400, bad.status);

    // 7. Permission: tanpa header role harus 403.
    const forbidden = await fetch(`${base}/api/dose/rules`).then(response => response.status).catch(() => 0);
    check('tanpa x-user-role -> 403', forbidden === 403, forbidden);

    child.kill();
    try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) { /* abaikan */ }

    console.log(`\n${passed} lulus, ${failed} gagal`);
    process.exit(failed ? 1 : 0);
})().catch(err => {
    console.error('SMOKE ERROR', err);
    process.exit(1);
});
