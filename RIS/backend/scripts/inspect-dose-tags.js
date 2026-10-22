'use strict';

/**
 * Inventaris tag DICOM per series: "modaliti ini sebenarnya mengirim apa?"
 *
 *   node scripts/inspect-dose-tags.js <studyInstanceUid> [--series=<n>] [--group=0018,0040]
 *
 * Untuk tiap series: daftar instance yang bisa dibaca PACS, lalu untuk instance
 * pertama cetak semua tag pada group yang diminta (default 0018 + 0040) beserta
 * VR dan nilainya. Dipakai untuk menyusun alias di dose-rules.json ketika ada
 * alat baru / karakter data baru dari lapangan -- tidak perlu tebak-tebakan lagi.
 *
 * Read-only: cuma GET ke DICOMweb PACS, tidak menyentuh DB.
 */
const path = require('path');
const BACKEND_DIR = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(BACKEND_DIR, '.env'), quiet: true });

const argOf = name => {
    const found = process.argv.slice(2).find(arg => arg.startsWith(`--${name}=`));
    return found ? found.split('=').slice(1).join('=') : '';
};
const studyUid = String(process.argv[2] || '').trim();
if (!studyUid) {
    console.error('Pakai: node scripts/inspect-dose-tags.js <studyInstanceUid> [--series=<n>] [--group=0018,0040]');
    process.exit(1);
}
const onlySeries = Number(argOf('series') || 0);
const groups = (argOf('group') || '0018,0040').split(',').map(g => g.trim().toUpperCase()).filter(Boolean);

const pacsRoot = String(process.env.DICOMWEB_PACS_RS_ROOT || `${process.env.DICOMWEB_PACS_ROOT || 'http://127.0.0.1:5001'}/rs`).replace(/\/+$/, '');
const headers = process.env.DICOMWEB_TOKEN ? { Authorization: `Bearer ${process.env.DICOMWEB_TOKEN}` } : {};
const q = value => encodeURIComponent(value);

const getJson = async (url) => {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return res.json();
};

// Beberapa tag kunci biar gampang dibaca manusia, sisanya diambil dari dictionary ringan.
const KNOWN = {
    '00080060': 'Modality', '00080070': 'Manufacturer', '00081090': 'ManufacturerModelName',
    '0008103E': 'SeriesDescription', '00180015': 'BodyPartExamined', '00180060': 'KVP',
    '00181150': 'ExposureTime', '00181151': 'XRayTubeCurrent', '00181152': 'Exposure',
    '00181153': 'ExposureInuAs', '00181154': 'AveragePulseWidth', '00181155': 'RadiationSetting',
    '00181160': 'FilterType', '00181170': 'GeneratorPower', '00181190': 'FocalSpots',
    '00181110': 'DistanceSourceToDetector', '00181111': 'DistanceSourceToPatient',
    '0018115E': 'EstimatedRadiographicMagnificationFactor', '00181181': 'CollimatorType',
    '00181131': 'AcquisitionDeviceProcessingDescription', '00181140': 'ExposureControlMode',
    '00189305': 'XRayTubeCurrent_mA_alt', '00181194': 'XRayTubeCurrent_mA',
    '00180090': 'KVP_alt', '00189260': 'ExposureTime_alt',
    '00101130': 'PatientWeight_alt', '00101030': 'PatientWeight',
    '00400316': 'DoseAreaProduct_DAP', '0040031E': 'DoseAreaProductTotal',
    '0040A730': 'ContentSequence', '0040A040': 'ValueType', '0040A043': 'ConceptCodeSequence',
    '0040A160': 'NumericValue', '004008EA': 'MeasurementUnitsCodeSequence',
    '00180088': 'SpiralPitchFactor', '00189073': 'CTDIvol', '00189345': 'MeanCTDIvolCandidate',
    '00189346': 'CTDIPhantomTypeCodeSequence', '00189347': 'CTDIvol_alt',
};

const label = tag => KNOWN[tag] ? `${tag} ${KNOWN[tag]}` : tag;
const display = (element) => {
    const value = element?.Value?.[0];
    if (value === undefined) return '(kosong)';
    if (typeof value === 'object') return JSON.stringify(value).slice(0, 60);
    return String(value);
};

const main = async () => {
    const series = await getJson(`${pacsRoot}/studies/${q(studyUid)}/series`);
    console.log(`study ${studyUid} -- ${series.length} series`);
    for (const [index, item] of series.entries()) {
        const seriesUid = item['0020000E']?.Value?.[0] || '';
        const modality = item['00080060']?.Value?.[0] || '';
        const description = item['0008103E']?.Value?.[0] || '';
        const count = item['00201209']?.Value?.[0] || '?';
        const mark = onlySeries && index + 1 !== onlySeries ? ' ' : '*';
        console.log(`${mark} [${index + 1}] ${modality.padEnd(4)} ${String(count).padStart(4)} inst  ${description || '(tanpa deskripsi)'}  ${seriesUid}`);
        if (onlySeries && index + 1 !== onlySeries) continue;

        let metadata;
        try {
            metadata = await getJson(`${pacsRoot}/studies/${q(studyUid)}/series/${q(seriesUid)}/metadata`);
        } catch (error) {
            console.log(`    ! metadata gagal: ${error.message}`);
            continue;
        }
        const first = Array.isArray(metadata) ? metadata[0] : metadata;
        const tags = Object.keys(first || {}).sort();
        const printed = tags.filter(tag => groups.some(group => tag.startsWith(group)));
        console.log(`    total tag di instance pertama: ${tags.length}; tag group ${groups.join('/')}: ${printed.length}`);
        for (const tag of printed) {
            console.log(`      ${label(tag).padEnd(62)} ${display(first[tag])}`);
        }
        const doseish = tags.filter(tag => /CTDI|DLP|Exposure|DoseArea|KVP|TubeCurrent|DistanceSource|PatientWeight|ContentSequence/i.test(`${label(tag)}`));
        const absent = doseish.length ? '' : '  (tidak ada tag dose/exposure sama sekali -- alat ini memang tidak mengirim)';
        console.log(`    kandidat tag dose: ${doseish.map(label).join(', ') || '-'}${absent}`);
    }
};

main().catch(error => { console.error('GAGAL:', error.message); process.exit(1); });
