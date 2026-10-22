'use strict';

/**
 * Uji mesin aturan ekstraksi dose (src/services/doseRules.js).
 *
 *   node scripts/test-dose-rules.js
 *
 * Tidak butuh PostgreSQL, PACS, atau DICOM: semua input sintetis, jadi bisa
 * dijalankan kapan saja di mesin dev untuk memastikan perubahan rule tidak
 * merusak perilaku bawaan.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const rules = require('../src/services/doseRules');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
    if (condition) {
        passed += 1;
        console.log(`  PASS  ${name}`);
    } else {
        failed += 1;
        console.log(`  FAIL  ${name}${detail === undefined ? '' : `  -> ${JSON.stringify(detail)}`}`);
    }
}

function section(title) {
    console.log(`\n== ${title}`);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dose-rules-'));
const silent = () => {};

// ---------------------------------------------------------------------------
section('1. Aturan bawaan (tidak ada file rules)');
const noFile = path.join(tmpRoot, 'nothing-here', 'dose-rules.json');
const builtin = rules.readDoseRules({ path: noFile, log: silent });
check('file default dibuat otomatis', fs.existsSync(noFile));
check('source = default-file (file dibuat dari default)', builtin.source === 'default-file' && builtin.autoCreated === true, builtin.source);
check('tanpa warning', builtin.warnings.length === 0, builtin.warnings);

section('2. Resolusi profil per vendor');
check('SIEMENS -> siemens-ct',
    rules.resolveProfile(builtin.rules, { manufacturer: 'SIEMENS HEALTHINEERS', modality: 'CT' })?.id === 'siemens-ct');
check('GE -> ge-ct',
    rules.resolveProfile(builtin.rules, { manufacturer: 'GE MEDICAL SYSTEMS' })?.id === 'ge-ct');
check('PHILIPS -> philips-ct',
    rules.resolveProfile(builtin.rules, { manufacturer: 'Philips Medical Systems' })?.id === 'philips-ct');
check('CANON/TOSHIBA -> canon-ct',
    rules.resolveProfile(builtin.rules, { manufacturer: 'TOSHIBA MEDICAL' })?.id === 'canon-ct');
check('vendor tak dikenal -> tidak ada profil',
    rules.resolveProfile(builtin.rules, { manufacturer: 'UNITED IMAGING' }) === null);

section('3. Deteksi series dose (SeriesDescription)');
const kw = [
    ['Dose Report', true],
    ['RDSR', true],
    ['Dose Info', true],
    ['Radiation Dose', true],
    ['Screen Save', false],
    ['', false],
];
for (const [description, expected] of kw) {
    check(`"${description}" -> ${expected}`,
        rules.matchesSeriesKeywords(description, builtin.rules, null) === expected);
}

section('4. Ekstraksi SR: gaya Siemens');
const siemensSr = {
    numeric: [
        { concept: 'Mean CTDIvol', path: 'CT Radiation Dose > Mean CTDIvol', value: 12.3456, unit: 'mGy' },
        { concept: 'CT Dose Length Product Total', path: 'CT Radiation Dose > DLP', value: 456.789, unit: 'mGy*cm' },
        { concept: 'Patient Weight', path: 'Patient > Weight', value: 70, unit: 'kg' },
        { concept: 'Exposure Time', path: 'Irradiation > Time', value: 5000, unit: 'ms' },
    ],
    text: [{ concept: 'Manufacturer', path: 'Device > Manufacturer', value: 'SIEMENS' }],
    code: [],
};
const siemensProfile = rules.resolveProfile(builtin.rules, { manufacturer: 'SIEMENS' });
const siemensResult = rules.computeSrValues(builtin.rules, siemensProfile, siemensSr);
check('avgCtdiVol = 12.346', siemensResult.values.avgCtdiVol === '12.346', siemensResult.values);
check('totalDlp = 456.789', siemensResult.values.totalDlp === '456.789', siemensResult.values);
check('weight = 70', siemensResult.values.weight === '70', siemensResult.values);
check('manufacturer = SIEMENS', siemensResult.values.manufacturer === 'SIEMENS', siemensResult.values);
check('stationName kosong -> masuk daftar missing', siemensResult.missing.includes('stationName'), siemensResult.missing);
check('konsep tak terpakai dilaporkan (Exposure Time)',
    siemensResult.unknownConcepts.includes('Exposure Time'), siemensResult.unknownConcepts);

section('5. Ekstraksi SR: gaya GE (penamaan berbeda, DLP multi-nilai)');
const geSr = {
    numeric: [
        { concept: 'CTDI vol 16cm phantom', path: 'Dose > CTDI', value: 9.5, unit: 'mGy' },
        { concept: 'CTDI vol 32cm phantom', path: 'Dose > CTDI', value: 15.25, unit: 'mGy' },
        { concept: 'DLP Total', path: 'Dose > DLP', value: 320.5, unit: 'mGy*cm' },
        { concept: 'DLP Total', path: 'Dose > DLP (retry)', value: 480.75, unit: 'mGy*cm' },
    ],
    text: [{ concept: 'Station Name', path: 'Device > Station', value: 'CT-01' }],
    code: [],
};
const geProfile = rules.resolveProfile(builtin.rules, { manufacturer: 'GE HEALTHCARE' });
const geResult = rules.computeSrValues(builtin.rules, geProfile, geSr);
check('avgCtdiVol = rata-rata (9.5 + 15.25)/2 = 12.375',
    geResult.values.avgCtdiVol === '12.375', geResult.values);
check('totalDlp = maksimum (480.75)', geResult.values.totalDlp === '480.75', geResult.values);
check('stationName dari alias "station name" = CT-01', geResult.values.stationName === 'CT-01', geResult.values);

section('6. Ekstraksi proyeksi/DX (tag + konversi + turunan)');
const metadata = {
    '00180060': '120',
    '00181150': '5000',
    '00181151': '12.5',
    '00181152': '12.5',
    '0018115E': '345.6',
    '00101030': '68',
    '00080070': 'SIEMENS',
    '00081010': 'DX-01',
};
const lookup = {
    number: tag => (metadata[tag] === undefined ? null : Number(metadata[tag])),
    text: tag => metadata[tag] === undefined ? '' : String(metadata[tag]),
};
const projection = rules.computeProjectionValues(builtin.rules, null, lookup);
check('kvp = 120', projection.values.kvp === '120', projection.values);
check('mas = 12.5', projection.values.mas === '12.5', projection.values);
check('seconds = 5 (5000 ms -> s)', projection.values.seconds === '5', projection.values);
check('dap = 345.6', projection.values.dap === '345.6', projection.values);
check('ua = 12500 (turunan ma x1000)', projection.values.ua === '12500', projection.values);
check('uas = 12500 (turunan mas x1000)', projection.values.uas === '12500', projection.values);
check('sid kosong -> missing', projection.missing.includes('sid'), projection.missing);
check('sumber tag tercatat (kvp -> 00180060)', projection.used.kvp === '00180060', projection.used);
check('hasDoseValue = true', rules.hasDoseValue(projection.values));

const emptyProjection = rules.computeProjectionValues(builtin.rules, null, { number: () => null, text: () => '' });
check('metadata kosong -> hasDoseValue false', rules.hasDoseValue(emptyProjection.values) === false);

section('7. Rule custom di file (dengan BOM, seperti Notepad/PowerShell)');
const customPath = path.join(tmpRoot, 'custom', 'dose-rules.json');
fs.mkdirSync(path.dirname(customPath), { recursive: true });
const customRules = {
    schemaVersion: 1,
    defaults: {
        sr: {
            avgCtdiVol: { unitScale: { cgy: 10 }, unit: 'mGy' },
            totalDlp: { aliases: ['nilai dlp total'], unitScale: { 'cgy*cm': 10 } },
        },
    },
    profiles: [
        {
            id: 'custom-rs-a',
            match: { manufacturerContains: ['PHILIPS'] },
            seriesKeywords: ['dose report lokal'],
            sr: { avgCtdiVol: { aliases: ['mean ctdivol'] } },
            projection: { dap: { tags: ['00400316'] } },
        },
    ],
};
fs.writeFileSync(customPath, `\uFEFF${JSON.stringify(customRules, null, 2)}`, 'utf-8');
const custom = rules.readDoseRules({ path: customPath, log: silent });
check('BOM tetap terbaca', custom.source === 'custom', { source: custom.source, warnings: custom.warnings });
check('tanpa warning', custom.warnings.length === 0, custom.warnings);

const philipsSr = {
    numeric: [
        { concept: 'Mean CTDIvol', path: 'Dose', value: 0.85, unit: 'cGy' },
        { concept: 'Nilai DLP Total', path: 'Dose', value: 30.5, unit: 'cGy*cm' },
    ],
    text: [],
    code: [],
};
const customProfile = rules.resolveProfile(custom.rules, { manufacturer: 'Philips Medical Systems' });
check('profil custom terpilih', customProfile?.id === 'custom-rs-a', customProfile?.id);
const philipsResult = rules.computeSrValues(custom.rules, customProfile, philipsSr);
check('cGy -> mGy (x10): 0.85 -> 8.5', philipsResult.values.avgCtdiVol === '8.5', philipsResult.values);
check('cGy*cm -> mGy*cm (x10): 30.5 -> 305', philipsResult.values.totalDlp === '305', philipsResult.values);
check('alias bawaan tetap dipakai (union): weight',
    (rules.fieldRuleFor(custom.rules, customProfile, 'weight', 'sr').aliases || []).includes('patient weight'),
    rules.fieldRuleFor(custom.rules, customProfile, 'weight', 'sr'));
check('alias custom ditambahkan ke alias bawaan untuk totalDlp',
    (rules.fieldRuleFor(custom.rules, customProfile, 'totalDlp', 'sr').aliases || []).includes('nilai dlp total')
    && (rules.fieldRuleFor(custom.rules, customProfile, 'totalDlp', 'sr').aliases || []).includes('dlp'),
    rules.fieldRuleFor(custom.rules, customProfile, 'totalDlp', 'sr').aliases);
check('keyword series custom terbaca',
    rules.matchesSeriesKeywords('Dose Report Lokal', custom.rules, customProfile));
check('tag dap union: 0018115E + 00400316 + bawaan',
    rules.fieldRuleFor(custom.rules, customProfile, 'dap', 'projection').tags.join(',') === '0018115E,00400316,0040031E',
    rules.fieldRuleFor(custom.rules, customProfile, 'dap', 'projection').tags);

section('8. File rules rusak / salah tipe (tidak boleh crash, tidak boleh diam)');
const brokenPath = path.join(tmpRoot, 'broken', 'dose-rules.json');
fs.mkdirSync(path.dirname(brokenPath), { recursive: true });
fs.writeFileSync(brokenPath, '{ "schemaVersion": 1, "defaults": { "sr": { ', 'utf-8');
const broken = rules.readDoseRules({ path: brokenPath, log: silent });
check('JSON rusak -> source invalid', broken.source === 'invalid', broken.source);
check('JSON rusak -> ada warning', broken.warnings.length > 0);
check('JSON rusak -> default bawaan tetap jalan',
    rules.computeSrValues(broken.rules, null, siemensSr).values.totalDlp === '456.789');

const typoPath = path.join(tmpRoot, 'typo', 'dose-rules.json');
fs.mkdirSync(path.dirname(typoPath), { recursive: true });
fs.writeFileSync(typoPath, JSON.stringify({
    schemaVersion: 1,
    settings: { diagnosticLog: true, sesuatuYangBaru: 1 },
    defaults: { sr: { avgCtdiVol: { aliases: 'bukan-array', reduce: 'ngawur' } } },
    profiles: [{ id: 'x', match: {}, sr: { totalDlp: { tags: ['0018115E'] } } }],
    keyTambahan: true,
}), 'utf-8');
const typo = rules.readDoseRules({ path: typoPath, log: silent });
check('tipe salah dicatat sebagai warning', typo.warnings.length >= 4, typo.warnings);
check('avgCtdiVol tetap punya alias bawaan',
    (rules.fieldRuleFor(typo.rules, null, 'avgCtdiVol', 'sr').aliases || []).length > 0,
    rules.fieldRuleFor(typo.rules, null, 'avgCtdiVol', 'sr'));
check('reduce ngawur jatuh ke first',
    rules.fieldRuleFor(typo.rules, null, 'avgCtdiVol', 'sr').reduce === 'first',
    rules.fieldRuleFor(typo.rules, null, 'avgCtdiVol', 'sr').reduce);
check('key root tak dikenal dicatat',
    typo.warnings.some(warning => warning.includes('keyTambahan')), typo.warnings);
check('profiles[0].match kosong -> tidak pernah cocok',
    rules.resolveProfile(typo.rules, { manufacturer: 'SIEMENS' }) === null);

section('9. Aturan tambahan bisa menambah field baru (tanpa ubah kode)');
const extraFieldPath = path.join(tmpRoot, 'extra', 'dose-rules.json');
fs.mkdirSync(path.dirname(extraFieldPath), { recursive: true });
fs.writeFileSync(extraFieldPath, JSON.stringify({
    schemaVersion: 1,
    defaults: { sr: { ssde: { aliases: ['ssde', 'size specific dose estimate'], reduce: 'max', unit: 'mGy' } } },
}), 'utf-8');
const extra = rules.readDoseRules({ path: extraFieldPath, log: silent });
const ssdeResult = rules.computeSrValues(extra.rules, null, {
    numeric: [{ concept: 'SSDE', path: 'Dose', value: 18.4, unit: 'mGy' }],
    text: [], code: [],
});
check('field baru ssde terekstrak', ssdeResult.values.ssde === '18.4', ssdeResult.values);
check('field bawaan tetap ada', 'totalDlp' in rules.listSrFields(extra.rules, null).reduce((acc, key) => ({ ...acc, [key]: true }), {}));

section('10. Diagnostic log');
const logPath = path.join(tmpRoot, 'diag', 'dose-rules.json');
rules.readDoseRules({ path: logPath, log: silent });
const wrote = rules.appendDiagnosticLog(builtin.rules, {
    studyInstanceUid: '1.2.3', profile: 'siemens-ct', doseSource: 'dose-sr', missing: ['stationName'],
}, { rulesPath: logPath, log: silent });
check('entry tertulis', wrote === true);
const readBack = rules.readDiagnosticLog(10, { rulesPath: logPath });
check('entry bisa dibaca ulang', readBack.entries.length === 1 && readBack.entries[0].studyInstanceUid === '1.2.3', readBack.entries);
check('diagnosticLog:false mematikan penulisan',
    rules.appendDiagnosticLog({ settings: { diagnosticLog: false } }, { a: 1 }, { rulesPath: logPath, log: silent }) === false);

section('11. summarizeRules (untuk endpoint /api/dose/rules)');
const summary = rules.summarizeRules(builtin.rules);
// Jangan kunci jumlah persis: profil vendor akan terus bertambah dari lapangan.
const profileIds = summary.profiles.map(profile => profile.id);
check('ringkasan memuat profil vendor CT', ['siemens-ct', 'ge-ct', 'philips-ct', 'canon-ct'].every(id => profileIds.includes(id)), profileIds);
check('ringkasan memuat profil CR/DX', ['cr-dx', 'carestream-cr', 'fujifilm-cr'].every(id => profileIds.includes(id)), profileIds);
check('ringkasan memuat field EI/DI untuk CR', summary.defaults.projectionFields.includes('exposureIndex') && summary.defaults.projectionFields.includes('deviationIndex'),
    summary.defaults.projectionFields);
check('ringkasan memuat field default', summary.defaults.srFields.includes('totalDlp'), summary.defaults.srFields);

section('11b. Tag di dalam sequence (Enhanced CT tanpa RDSR)');

const dicomSr = require('../src/services/dicomSr');
// Struktur nyata Enhanced CT: CTDIvol/DLP ada di dalam CT Exposure Sequence.
const enhancedCtMetadata = {
    '00080060': { Value: ['CT'] },
    '00189321': {
        Value: [{
            '00189323': { Value: [{ '00189316': { Value: ['3'] } }] },
            '00189345': { Value: ['12.5'] },
            '00189346': { Value: ['640.25'] },
        }],
    },
    // Nilai 0 di level teratas harus TIDAK menutupi nilai di dalam sequence.
    '00189347': { Value: ['0'] },
};
const nestedCtdi = dicomSr.deepFindElement(enhancedCtMetadata, '00189345');
check('deepFindElement menemukan tag di dalam sequence', nestedCtdi?.Value?.[0] === '12.5', nestedCtdi && nestedCtdi.Value);
check('deepFindElement tidak mengarang tag yang tidak ada', dicomSr.deepFindElement(enhancedCtMetadata, '99999999') === null);

// firstDicomNumber gaya index.js: level teratas dulu, lalu ke dalam sequence.
const getNumber = (node) => {
    const value = node?.Value?.[0];
    if (value === undefined || value === null) return null;
    if (typeof value === 'object') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
};
const firstNumber = (metadata, tags) => {
    for (const tag of tags) {
        const element = metadata?.[tag] || dicomSr.deepFindElement(metadata, tag);
        const value = getNumber(element);
        if (value !== null) return value;
    }
    return null;
};
const deepLookup = {
    number: tag => firstNumber(enhancedCtMetadata, [tag]),
    text: () => '',
};
const enhancedProjection = rules.computeProjectionValues(rules.DEFAULT_DOSE_RULES, null, deepLookup);
check('CTDIvol dari sequence terbaca sebagai avgCtdiVol', enhancedProjection.values.avgCtdiVol === '12.5', enhancedProjection.values.avgCtdiVol);
check('DLP dari sequence terbaca sebagai totalDlp', enhancedProjection.values.totalDlp === '640.25', enhancedProjection.values.totalDlp);
check('lookup bersarang menemukan 0018,9345 di dalam 0018,9321', firstNumber(enhancedCtMetadata, ['00189345']) === 12.5, firstNumber(enhancedCtMetadata, ['00189345']));

section('12. Siklus hidup file di lokasi nyata (ProgramData / env override)');

const lifecyclePath = path.join(tmpRoot, 'programdata', 'VEXAPACS', 'dose-rules.json');
delete process.env.VEXA_DOSE_RULES_PATH;
const resolved = rules.resolveDoseRulesPath();
check('default path = <ProgramData>/VEXAPACS/dose-rules.json',
    resolved.endsWith(path.join('VEXAPACS', 'dose-rules.json')), resolved);

process.env.VEXA_DOSE_RULES_PATH = lifecyclePath;
check('env override dipakai (dev tanpa sentuh ProgramData)',
    rules.resolveDoseRulesPath() === path.resolve(lifecyclePath), rules.resolveDoseRulesPath());

const created = rules.readDoseRules({ log: silent });
check('file belum ada -> source "default-file" (default ditulis ke disk)', created.source === 'default-file', created.source);
check('flag autoCreated aktif', created.autoCreated === true);
check('file default otomatis dibuat', fs.existsSync(lifecyclePath));
const createdRaw = JSON.parse(fs.readFileSync(lifecyclePath, 'utf-8'));
check('file default = rules yang dipakai', createdRaw.schemaVersion === created.rules.schemaVersion);
check('file default memuat dokumentasi _bacaDulu', Boolean(createdRaw._bacaDulu));
check('baca kedua -> source "custom" tanpa autoCreated', (() => {
    const second = rules.readDoseRules({ log: silent });
    return second.source === 'custom' && second.autoCreated === false;
})());

// Hot-reload: tulis aturan alat baru, baca ulang tanpa restart.
fs.writeFileSync(lifecyclePath, JSON.stringify({
    schemaVersion: 1,
    profiles: [{
        id: 'vendor-baru-ct',
        match: { manufacturerContains: ['VENDOR BARU'], modality: ['CT'] },
        seriesKeywords: ['rdsr'],
        sr: { totalDlp: { aliases: ['dlp alat baru'], unit: 'mGy*cm' } },
    }],
}), 'utf-8');
const hot = rules.readDoseRules({ log: silent });
check('edit file langsung berlaku (tanpa restart)', hot.source === 'custom', hot.source);
check('profil alat baru terbaca', hot.rules.profiles.some(profile => profile.id === 'vendor-baru-ct'));
const hotProfile = rules.resolveProfile(hot.rules, { manufacturer: 'VENDOR BARU MEDICAL', modality: 'CT' });
check('profil alat baru terpilih dari manufacturer', hotProfile?.id === 'vendor-baru-ct', hotProfile?.id);
// Semantik pencocokan: substring dari string yang di-normalisasi (spasi dipertahankan).
check('manufacturerContains = substring, bukan fuzzy',
    rules.resolveProfile(hot.rules, { manufacturer: 'VENDORBARU MEDICAL', modality: 'CT' })?.id !== 'vendor-baru-ct');
check('profil default (Siemens) tetap menang untuk alat Siemens',
    rules.resolveProfile(hot.rules, { manufacturer: 'SIEMENS HEALTHINEERS', modality: 'CT' })?.id !== 'vendor-baru-ct');
const hotSr = rules.computeSrValues(hot.rules, hotProfile, {
    numeric: [{ concept: 'DLP ALAT BARU', path: 'Dose', value: 1234.5, unit: 'mGy*cm' }],
    text: [], code: [],
});
check('nilai alat baru terekstrak', hotSr.values.totalDlp === '1234.5', hotSr.values);
check('field bawaan tetap ada saat file custom', 'avgCtdiVol' in hotSr.values || rules.listSrFields(hot.rules, hotProfile).includes('avgCtdiVol'));

// BOM dari Notepad/PowerShell harus tetap terbaca.
fs.writeFileSync(lifecyclePath, `\uFEFF${JSON.stringify({ schemaVersion: 1, profiles: [{ id: 'ber-bom', match: {}, sr: {} }] })}`, 'utf-8');
const bom = rules.readDoseRules({ log: silent });
check('file ber-BOM tetap terbaca', bom.source === 'custom' && bom.rules.profiles.some(profile => profile.id === 'ber-bom'), [bom.source, bom.warnings]);

// File rusak tidak boleh mematikan ekstraksi.
fs.writeFileSync(lifecyclePath, '{ ini bukan json', 'utf-8');
const brokenFile = rules.readDoseRules({ log: silent });
check('JSON rusak -> source "invalid" + warning', brokenFile.source === 'invalid' && brokenFile.warnings.length > 0, [brokenFile.source, brokenFile.warnings]);
check('JSON rusak -> ekstraksi tetap jalan pakai default',
    rules.computeSrValues(brokenFile.rules, null, { numeric: [{ concept: 'DLP', path: 'Dose', value: 10, unit: 'mGy*cm' }], text: [], code: [] }).values.totalDlp === '10');

delete process.env.VEXA_DOSE_RULES_PATH;

// ---------------------------------------------------------------------------
console.log(`\n${passed} lulus, ${failed} gagal`);
try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch (_) { /* abaikan */ }
process.exit(failed === 0 ? 0 : 1);
