'use strict';

/**
 * Uji mesin aturan dose terhadap file DICOM NYATA dari arsip PACS.
 *
 *   node scripts/test-dose-real-sr.js [opsi]
 *     --file=<path .dcm>   file yang diuji (default: cari RDSR di DICOMWEB_PACS_STORAGE_PATH)
 *     --rules=<path json>  file dose-rules.json yang dipakai (default: bawaan)
 *     --list               hanya tampilkan konsep SR yang ada di file
 *
 * Tidak butuh PostgreSQL/PACS hidup: file dibaca langsung dari disk.
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });
const dicomParser = require('dicom-parser');
const dicomSr = require('../src/services/dicomSr');
const doseRules = require('../src/services/doseRules');

const args = process.argv.slice(2);
const argValue = name => {
    const hit = args.find(item => item.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : '';
};
const silent = () => {};

const storageRoot = process.env.DICOMWEB_PACS_STORAGE_PATH || 'D:\\VELOPACS-RIS\\DATA';
const RDSR_SOP = '1.2.840.10008.5.1.4.1.1.88.67';

const findRdsrFile = root => {
    const stack = [root];
    while (stack.length) {
        const current = stack.pop();
        let entries = [];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch (_) {
            continue;
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
                continue;
            }
            if (!/\.dcm$/i.test(entry.name)) continue;
            try {
                if (fs.readFileSync(full).includes(RDSR_SOP)) return full;
            } catch (_) { /* abaikan file tak terbaca */ }
        }
    }
    return '';
};

const filePath = argValue('file') || findRdsrFile(storageRoot);
if (!filePath || !fs.existsSync(filePath)) {
    console.error(`Tidak ada file RDSR ditemukan di ${storageRoot} (pakai --file=<path>)`);
    process.exit(2);
}

const { metadata, srContent } = dicomSr.readSrContentFromFile(filePath, dicomParser);
const rulesPath = argValue('rules');
const state = rulesPath ? doseRules.readDoseRules({ path: rulesPath, log: silent }) : doseRules.readDoseRules({ log: silent });

console.log(`file        : ${path.relative(storageRoot, filePath)}`);
console.log(`rules       : ${state.path} (${state.source})`);
console.log(`patient     : ${dicomSr.getDicomJsonValue(metadata['00100010'])}`);
console.log(`modality    : ${dicomSr.getDicomJsonValue(metadata['00080060'])}`);
console.log(`manufacturer: ${dicomSr.getDicomJsonValue(metadata['00080070'])}`);
console.log(`series desc : ${dicomSr.getDicomJsonValue(metadata['0008103E'])}`);
console.log(`sr items    : numeric=${srContent.numeric.length} text=${srContent.text.length} code=${srContent.code.length}`);

console.log('\n-- konsep NUM di SR (nama persis dari alat) --');
for (const item of srContent.numeric) {
    console.log(`   ${JSON.stringify(item.concept)} | ${item.value} ${item.unit || ''} | path=${item.path}`);
}
if (args.includes('--list')) process.exit(0);

const context = {
    manufacturer: dicomSr.getDicomJsonValue(metadata['00080070']),
    modality: dicomSr.getDicomJsonValue(metadata['00080060']).toUpperCase() || 'CT',
    seriesDescription: dicomSr.getDicomJsonValue(metadata['0008103E']),
};
const profile = doseRules.resolveProfile(state.rules, context);
const matchesKeyword = doseRules.matchesSeriesKeywords(context.seriesDescription, state.rules, profile);
const result = doseRules.computeSrValues(state.rules, profile, srContent);

console.log('\n-- hasil ekstraksi dengan rules saat ini --');
console.log(`profil dipilih        : ${profile ? profile.id : '(default)'}`);
console.log(`seriesKeyword cocok   : ${matchesKeyword}`);
const filledCount = Object.entries(result.values).filter(([, v]) => String(v).trim() !== '').length;
// Penyebut = field terisi + field yang dilaporkan kosong (aturan profilnya sendiri),
// supaya laporan tidak terlihat "4/4 lengkap" padahal weight belum ada.
console.log(`field terbaca         : ${filledCount}/${filledCount + result.missing.length} field aturan`);
for (const [field, value] of Object.entries(result.values)) {
    console.log(`   ${field} = ${value === '' ? '(kosong)' : value}`);
}
console.log(`masih kosong          : ${result.missing.join(', ') || '-'}`);
if (result.unknownConcepts.length) {
    console.log(`\n-- konsep SR yang belum dikenali rules (${result.unknownConcepts.length}) --`);
    for (const concept of result.unknownConcepts) console.log(`   ${JSON.stringify(concept)}`);
}
