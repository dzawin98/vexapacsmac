'use strict';

/**
 * Helper SR/DICOM-web + file .dcm.
 *
 * Fungsi-fungsi ini dulu tinggal di dalam index.js. Dipindah ke modul supaya:
 *   1. satu sumber kebenaran untuk flatten SR (dipakai service dose),
 *   2. bisa diuji dengan file .dcm nyata tanpa menyalakan server/PACS.
 *
 * Bentuk data mengikuti DICOM JSON Model (seperti keluaran DICOMweb):
 *   { '<tag>': { Value: [...] } }
 */

const fs = require('fs');

function getDicomJsonValue(element, fallback = '') {
    const value = element?.Value?.[0];
    if (value && typeof value === 'object' && value.Alphabetic) return String(value.Alphabetic);
    return value === undefined || value === null ? fallback : String(value);
}

function getDicomCodeMeaning(sequence) {
    const item = sequence?.Value?.[0];
    return getDicomJsonValue(item?.['00080104']) || getDicomJsonValue(item?.['00080100']);
}

function getDicomNumericMeasurement(item) {
    const measuredValue = item?.['0040A300']?.Value?.[0];
    const rawValue = getDicomJsonValue(measuredValue?.['0040A30A']);
    const value = Number(rawValue);
    if (!Number.isFinite(value)) return null;
    return {
        value,
        unit: getDicomCodeMeaning(measuredValue?.['004008EA']),
    };
}

/**
 * Flatten content sequence SR (0040,A730) menjadi daftar pengukuran/text/code.
 * Karena inilah "nama konsep" dari tiap vendor terbaca apa adanya -- dan dari
 * daftar inilah aturan di dose-rules.json mencocokkan alias.
 */
function pushDoseSrContent(items, pathStack, output) {
    if (!Array.isArray(items)) return;
    for (const item of items) {
        const concept = getDicomCodeMeaning(item?.['0040A043']);
        const valueType = getDicomJsonValue(item?.['0040A040']);
        const path = [...pathStack, concept].filter(Boolean);
        if (valueType === 'NUM') {
            const measurement = getDicomNumericMeasurement(item);
            if (measurement) {
                output.numeric.push({ concept, path: path.join(' > '), ...measurement });
            }
        } else if (valueType === 'TEXT') {
            output.text.push({ concept, path: path.join(' > '), value: getDicomJsonValue(item?.['0040A160']) });
        } else if (valueType === 'CODE') {
            output.code.push({ concept, path: path.join(' > '), value: getDicomCodeMeaning(item?.['0040A168']) });
        } else if (valueType === 'DATETIME') {
            output.text.push({ concept, path: path.join(' > '), value: getDicomJsonValue(item?.['0040A120']) });
        }
        pushDoseSrContent(item?.['0040A730']?.Value, path, output);
    }
}

const emptySrContent = () => ({ numeric: [], text: [], code: [] });

// ---------------------------------------------------------------------------
// File .dcm -> bentuk DICOM JSON Model (untuk verifikasi & cadangan)
// ---------------------------------------------------------------------------

const BINARY_VR = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'OV', 'UN', 'SQ']);

const elementValue = (dataSet, tag, element) => {
    // File implicit-VR tidak menyimpan VR per elemen: element.vr bisa undefined.
    // Kalau begitu coba baca sebagai string (aman untuk tag teks), lalu jatuh ke
    // nilai mentah.
    const vr = String(element?.vr || '').toUpperCase();
    if (!BINARY_VR.has(vr)) {
        let text = '';
        try {
            text = dataSet.string(tag) || '';
        } catch (_) {
            text = '';
        }
        if (text) return text.split('\\').map(part => part.trim()).filter(part => part !== '');
    }
    const raw = element?.value;
    if (raw === undefined || raw === null) return [];
    if (Array.isArray(raw)) return raw.map(item => (typeof item === 'object' ? item : String(item)));
    return [String(raw)];
};

const dataSetToJson = dataSet => {
    const output = {};
    const elements = dataSet?.elements || {};
    for (const tag of Object.keys(elements)) {
        const element = elements[tag];
        // dicom-parser memakai key berawalan 'x' dan huruf kecil (x00080060);
        // konsumen (index.js, DICOM JSON Model) memakai tag polos HURUF BESAR.
        const jsonTag = (tag.startsWith('x') ? tag.slice(1) : tag).toUpperCase();
        // Deteksi sequence dari element.items, bukan VR: file implicit VR tidak
        // menyetel element.vr, jadi pengecekan vr saja akan melewatkannya.
        if (Array.isArray(element?.items)) {
            // dicom-parser: tiap item = { tag, length, dataOffset, dataSet }.
            output[jsonTag] = { Value: element.items.map(item => dataSetToJson(item?.dataSet || item)) };
            continue;
        }
        const value = elementValue(dataSet, tag, element);
        if (value.length) output[jsonTag] = { Value: value };
    }
    return output;
};

/**
 * Cari elemen berdasarkan tag di SELURUH pohon, termasuk di dalam sequence.
 *
 * Sebagian nilai dose tidak ada di level teratas: pada Enhanced CT, CTDIvol
 * (0018,9345) dan DLP (0018,9346) berada di dalam CT Exposure Sequence
 * (0018,9321) -> CT X-Ray Details Sequence. Tanpa pencarian bersarang, study CT
 * yang tidak punya RDSR akan selalu kosong padahal gambarannya membawa dose.
 * Dipakai sebagai cadangan: tag level teratas tetap diprioritaskan pemanggil.
 */
const DEEP_SEARCH_MAX_DEPTH = 6;

function deepFindElement(node, tag, depth = 0) {
    if (depth > DEEP_SEARCH_MAX_DEPTH || !node || typeof node !== 'object') return null;
    if (Array.isArray(node)) {
        for (const item of node) {
            const found = deepFindElement(item, tag, depth + 1);
            if (found) return found;
        }
        return null;
    }
    if (node[tag]) return node[tag];
    for (const value of Object.values(node)) {
        const found = deepFindElement(value, tag, depth + 1);
        if (found) return found;
    }
    return null;
}

/**
 * Baca file .dcm (cadangan/arsip) menjadi metadata gaya DICOM JSON + isi SR.
 * Dipakai untuk diagnosa lapangan: "file-nya ada, kenapa dose kosong?".
 */
function readDicomFileAsJson(filePath, dicomParser) {
    const parser = dicomParser || require('dicom-parser');
    const dataSet = parser.parseDicom(fs.readFileSync(filePath));
    return dataSetToJson(dataSet);
}

/** Isi SR (numeric/text/code) dari file .dcm, memakai flatten yang sama. */
function readSrContentFromFile(filePath, dicomParser) {
    const metadata = readDicomFileAsJson(filePath, dicomParser);
    const srContent = emptySrContent();
    pushDoseSrContent(metadata?.['0040A730']?.Value, [], srContent);
    return { metadata, srContent };
}

module.exports = {
    getDicomJsonValue,
    getDicomCodeMeaning,
    getDicomNumericMeasurement,
    pushDoseSrContent,
    emptySrContent,
    readDicomFileAsJson,
    readSrContentFromFile,
    dataSetToJson,
    deepFindElement,
};
