'use strict';

/**
 * Dose extraction rule engine (Tahap 1).
 *
 * Tujuan: memisahkan "mesin" dari "karakter alat". Semua aturan pencocokan
 * (nama series, alias konsep SR, daftar tag proyeksi, konversi unit, profil
 * per-vendor) tinggal di file JSON di luar folder aplikasi:
 *
 *     %ProgramData%\VEXAPACS\dose-rules.json     (atau env VEXA_DOSE_RULES_PATH)
 *
 * File itu dibaca ulang setiap kali ekstraksi dijalankan, jadi mengubahnya
 * berlaku langsung tanpa restart service -- pola yang sama dengan
 * readAppLinkSettings() di index.js.
 *
 * Default tertanam di file ini dan dipakai kalau file JSON tidak ada, tidak
 * bisa dibaca, atau isinya salah. Jadi tidak ada risiko regresi: menghapus
 * file rules = kembali ke perilaku bawaan.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SCHEMA_VERSION = 1;

const DEFAULT_DOSE_RULES = {
    schemaVersion: SCHEMA_VERSION,
    _bacaDulu: [
        'DOSE EXTRACTION RULES — this file can be edited on the server without a rebuild.',
        'Location: %ProgramData%\\VEXAPACS\\dose-rules.json (default C:\\ProgramData\\VEXAPACS\\).',
        'Changes take effect when the next study is processed; no service restart is needed.',
        'Save as UTF-8 WITHOUT BOM (Notepad: select "UTF-8"; PowerShell: [IO.File]::WriteAllText).',
        'If this file is broken, the backend keeps running with the built-in rules and records the reason in',
        'C:\\ProgramData\\VEXAPACS\\dose-extract.log (see also GET /api/dose/rules).',
        '',
        'defaults.sr / defaults.projection = baseline rules for ALL modalities.',
        'profiles[] = per-modality overrides (selected via match.manufacturerContains etc.).',
        'Aliases and tags you write are ADDED to the built-in lists (they do not replace them).',
        'Use "replaceAliases": true / "replaceTags": true to replace the whole list.',
        'reduce selects which value is used when several are present: first|max|min|sum|avg.',
        'unitScale converts the vendor unit to the target unit, e.g. { "cgy": 10 } for cGy -> mGy.',
        'New fields here are stored as well (even when they are not shown on screen yet).',
    ],
    settings: {
        diagnosticLog: true,
        diagnosticLogMaxBytes: 512 * 1024,
        fallbackToImageMetadataWhenSrEmpty: true,
    },
    defaults: {
        seriesKeywords: ['dose', 'rdsr', 'dose report', 'dosereport', 'dose info', 'radiation dose'],
        sr: {
            avgCtdiVol: {
                aliases: ['mean ctdivol', 'ctdivol', 'ctdi vol', 'ctdivol (mgy)'],
                reduce: 'avg',
                unit: 'mGy',
            },
            totalDlp: {
                aliases: [
                    'ct dose length product total',
                    'dose length product total',
                    'total dlp',
                    'dlp total',
                    'dlp',
                ],
                reduce: 'max',
                unit: 'mGy*cm',
            },
            weight: {
                aliases: ['patient weight'],
                reduce: 'first',
                unit: 'kg',
            },
            manufacturer: {
                aliases: ['manufacturer', 'equipment manufacturer'],
                type: 'text',
            },
            stationName: {
                aliases: ['device observer name', 'device name', 'station name'],
                type: 'text',
            },
        },
        projection: {
            kvp: { tags: ['00180060'], unit: 'kVp' },
            ma: { tags: ['00181151'], unit: 'mA' },
            ua: { tags: [], deriveFrom: 'ma', factor: 1000, unit: 'uA' },
            seconds: { tags: ['00181150'], unit: 's', scale: 0.001 },
            mas: { tags: ['00181152'], unit: 'mAs' },
            uas: { tags: ['00181153'], unit: 'uAs', deriveFrom: 'mas', factor: 1000 },
            sid: { tags: ['00181110', '00181111'], unit: 'mm' },
            dap: { tags: ['0018115E', '00400316', '0040031E'], unit: 'mGy*cm2' },
            weight: { tags: ['00101030'], unit: 'kg' },
            manufacturer: { tags: ['00080070'], type: 'text' },
            stationName: { tags: ['00081010', '00181000'], type: 'text' },
            // CR/DX: banyak alat radiografi umum TIDAK mengirim kVp/mAs, hanya
            // Exposure Index (0018,1411), Target EI (0018,1412), Deviation Index
            // (0018,1413) + View Position (0018,5101) + Body Part (0018,0015).
            // Terverifikasi ada pada Carestream Image Suite Vita CR dan FUJIFILM CR.
            exposureIndex: { tags: ['00181411'], unit: '' },
            targetExposureIndex: { tags: ['00181412'], unit: '' },
            deviationIndex: { tags: ['00181413'], unit: '' },
            viewPosition: { tags: ['00185101'], type: 'text' },
            bodyPart: { tags: ['00180015'], type: 'text' },
            // Enhanced CT tanpa RDSR: nilai dose ada di dalam sequence
            // (0018,9321 CT Exposure Sequence), dicari otomatis oleh
            // firstDicomNumber lewat dicomSr.deepFindElement.
            // Nama field disamakan dengan hasil SR supaya DB/UI tidak berubah.
            avgCtdiVol: { tags: ['00189345'], unit: 'mGy' },
            totalDlp: { tags: ['00189346'], unit: 'mGy*cm' },
        },
    },
    profiles: [
        {
            id: 'siemens-ct',
            match: { manufacturerContains: ['SIEMENS'] },
            seriesKeywords: ['dose', 'rdsr'],
            sr: {
                avgCtdiVol: { aliases: ['mean ctdivol', 'ctdivol'] },
                totalDlp: { aliases: ['ct dose length product total', 'dlp'] },
            },
        },
        {
            id: 'ge-ct',
            match: { manufacturerContains: ['GE MEDICAL', 'GE HEALTHCARE', 'GE HOSPITAL'] },
            seriesKeywords: ['dose', 'dose info', 'rdsr'],
            sr: {
                avgCtdiVol: { aliases: ['ctdi vol', 'ctdivol', 'ctdiw'] },
                totalDlp: { aliases: ['dlp total', 'dose length product', 'total dlp'] },
            },
        },
        {
            id: 'philips-ct',
            match: { manufacturerContains: ['PHILIPS'] },
            seriesKeywords: ['dose', 'dose info'],
            sr: {
                avgCtdiVol: { aliases: ['mean ctdivol', 'ctdivol'] },
                totalDlp: { aliases: ['total dlp', 'dlp'] },
            },
            projection: {
                dap: { tags: ['0018115E', '00400316'] },
            },
        },
        {
            id: 'canon-ct',
            match: { manufacturerContains: ['CANON', 'TOSHIBA'] },
            seriesKeywords: ['dose', 'rdsr', 'dose report'],
        },
        // --- Radiografi umum (CR/DX) ---------------------------------------
        // Alat CR/DX hampir tidak pernah mengirim kVp/mAs. Yang ada: Exposure
        // Index, Target EI, Deviation Index, View Position, Body Part. Field-field
        // ini sudah ada di defaults.projection, profil di bawah jadi contoh cara
        // menambah penyesuaian per vendor di lapangan.
        {
            id: 'cr-dx',
            match: { modality: ['CR', 'DX', 'MG', 'RF'] },
            seriesKeywords: ['dose', 'exposure'],
            projection: {
                exposureIndex: { tags: ['00181411'] },
                targetExposureIndex: { tags: ['00181412'] },
                deviationIndex: { tags: ['00181413'] },
            },
        },
        {
            id: 'carestream-cr',
            match: { manufacturerContains: ['CARESTREAM', 'CARESTREAM HEALTH'] },
            projection: {
                // Carestream Image Suite (Vita CR) memakai tag standar EI/Target EI/DI.
                exposureIndex: { tags: ['00181411'] },
                targetExposureIndex: { tags: ['00181412'] },
                deviationIndex: { tags: ['00181413'] },
            },
        },
        {
            id: 'fujifilm-cr',
            match: { manufacturerContains: ['FUJIFILM'] },
            projection: {
                // FUJIFILM CR: EI/DI tidak selalu ada, tapi Target EI selalu dikirim (876).
                exposureIndex: { tags: ['00181411'] },
                targetExposureIndex: { tags: ['00181412'] },
                deviationIndex: { tags: ['00181413'] },
            },
        },
    ],
};

// ---------------------------------------------------------------------------
// File location + loading
// ---------------------------------------------------------------------------

function resolveDoseRulesPath() {
    const override = String(process.env.VEXA_DOSE_RULES_PATH || '').trim();
    if (override) return path.resolve(override);
    // Urutan lintas platform: VEXA_PROGRAM_DATA_DIR → ProgramData (Windows)
    // → ~/Library/Application Support (macOS) → ~/.vexapacs (Linux/fallback).
    const explicit = String(process.env.VEXA_PROGRAM_DATA_DIR || '').trim();
    if (explicit) return path.join(path.resolve(explicit), 'VEXAPACS', 'dose-rules.json');
    const programData = String(process.env.ProgramData || process.env.PROGRAMDATA || '').trim();
    if (programData) return path.join(programData, 'VEXAPACS', 'dose-rules.json');
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'VEXAPACS', 'dose-rules.json');
    }
    return path.join(os.homedir(), '.vexapacs', 'VEXAPACS', 'dose-rules.json');
}

function stripBom(text) {
    // PowerShell 5.1 `Set-Content -Encoding UTF8` menulis BOM dan Notepad
    // "UTF-8 with BOM" juga. JSON.parse menolaknya, dan dulu itu membuat
    // settings.json diam-diam kembali ke default.
    return String(text || '').replace(/^\uFEFF/, '');
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function ensureDoseRulesFile(rulesPath, log) {
    try {
        if (fs.existsSync(rulesPath)) return false;
        fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
        fs.writeFileSync(rulesPath, JSON.stringify(DEFAULT_DOSE_RULES, null, 2), 'utf-8');
        log(`[dose-rules] default rule file dibuat: ${rulesPath}`);
        return true;
    } catch (err) {
        log(`[dose-rules] tidak bisa membuat file rules di ${rulesPath}: ${err.message} (memakai default bawaan)`);
        return false;
    }
}

/**
 * Normalisasi + validasi aturan custom. Setiap key yang salah tipe dibuang dan
 * dicatat di warnings -- file yang salah tidak boleh membuat ekstraksi gagal,
 * tapi juga tidak boleh gagal secara diam-diam.
 */
function normalizeRules(raw, warnings) {
    const warn = message => {
        if (warnings.length < 50) warnings.push(message);
    };
    if (!isPlainObject(raw)) {
        warn('file content is not a JSON object; using the built-in defaults');
        return null;
    }
    const rules = {
        schemaVersion: Number.isFinite(Number(raw.schemaVersion)) ? Number(raw.schemaVersion) : SCHEMA_VERSION,
        settings: { ...DEFAULT_DOSE_RULES.settings },
        defaults: {
            seriesKeywords: [...DEFAULT_DOSE_RULES.defaults.seriesKeywords],
            sr: {},
            projection: {},
        },
        profiles: [],
    };
    for (const [key, value] of Object.entries(DEFAULT_DOSE_RULES.defaults.sr)) {
        rules.defaults.sr[key] = { ...value };
    }
    for (const [key, value] of Object.entries(DEFAULT_DOSE_RULES.defaults.projection)) {
        rules.defaults.projection[key] = { ...value, tags: [...(value.tags || [])] };
    }

    if (!Number.isFinite(Number(raw.schemaVersion))) {
        warn(`schemaVersion is missing / not a number; assuming ${SCHEMA_VERSION}`);
    } else if (Number(raw.schemaVersion) > SCHEMA_VERSION) {
        warn(`schemaVersion ${raw.schemaVersion} is newer than this build understands (${SCHEMA_VERSION}); unknown keys are ignored`);
    }

    if (isPlainObject(raw.settings)) {
        for (const [key, value] of Object.entries(raw.settings)) {
            if (key.startsWith('_') || key.startsWith('$')) continue;
            if (!(key in DEFAULT_DOSE_RULES.settings)) {
                warn(`settings.${key} is unknown (ignored)`);
                continue;
            }
            rules.settings[key] = value;
        }
    } else if (raw.settings !== undefined) {
        warn('settings is not an object (ignored)');
    }

    const mergeFieldRule = (target, source, kindLabel, key) => {
        if (!isPlainObject(source)) {
            warn(`${kindLabel}.${key} is not an object (ignored)`);
            return;
        }
        const next = { ...target };
        for (const [prop, value] of Object.entries(source)) {
            if (prop === 'tags') {
                if (!Array.isArray(value) || value.some(tag => typeof tag !== 'string')) {
                    warn(`${kindLabel}.${key}.tags must be an array of strings (ignored)`);
                    continue;
                }
                // default: tag vendor DITAMBAHKAN ke tag bawaan. Pakai
                // "replaceTags": true kalau memang ingin mengganti seluruhnya.
                next.tags = Array.from(new Set([
                    ...(source.replaceTags === true ? [] : (target.tags || [])),
                    ...value.map(tag => normalizeTag(tag)),
                ])).filter(Boolean);
                continue;
            }
            if (prop === 'aliases') {
                if (!Array.isArray(value) || value.some(alias => !isPlainObject(alias) && typeof alias !== 'string')) {
                    warn(`${kindLabel}.${key}.aliases must be an array of strings / {regex} (ignored)`);
                    continue;
                }
                // default: alias DITAMBAHKAN ke alias bawaan (paling sering
                // dibutuhkan di lapangan). Pakai "replaceAliases": true untuk
                // mengganti seluruh daftar.
                next.aliases = source.replaceAliases === true
                    ? value.map(alias => (isPlainObject(alias) ? { ...alias } : String(alias)))
                    : [
                        ...(target.aliases || []),
                        ...value.map(alias => (isPlainObject(alias) ? { ...alias } : String(alias))),
                    ];
                continue;
            }
            if (prop === 'reduce' && !['first', 'max', 'min', 'sum', 'avg'].includes(String(value))) {
                warn(`${kindLabel}.${key}.reduce '${value}' is unknown (first|max|min|sum|avg); using 'first'`);
                next.reduce = 'first';
                continue;
            }
            if (prop === 'unitScale') {
                if (!isPlainObject(value)) {
                    warn(`${kindLabel}.${key}.unitScale is not an object (ignored)`);
                    continue;
                }
                const badUnits = Object.entries(value).filter(([, factor]) => !Number.isFinite(Number(factor)));
                if (badUnits.length) {
                    warn(`${kindLabel}.${key}.unitScale.${badUnits[0][0]} is not a number (ignored)`);
                    continue;
                }
                next.unitScale = { ...(target.unitScale || {}), ...value };
                continue;
            }
            if (prop.startsWith('_') || prop.startsWith('$')) {
                // komentar / catatan: dibolehkan, tidak dipakai mesin
                delete next[prop];
                continue;
            }
            if (['scale', 'factor'].includes(prop) && !Number.isFinite(Number(value))) {
                warn(`${kindLabel}.${key}.${prop} is not a number (ignored)`);
                continue;
            }
            next[prop] = value;
        }
        Object.keys(target).forEach(existing => {
            if (!(existing in next)) delete target[existing];
        });
        Object.assign(target, next);
    };

    const applyBucket = (bucket, kindLabel, into) => {
        // bucket yang tidak ditulis sama sekali = tidak ada override, dan itu
        // normal (profil CT tidak perlu blok projection). Jangan berisik.
        if (bucket === undefined || bucket === null) return;
        if (!isPlainObject(bucket)) {
            warn(`${kindLabel} is not an object (ignored)`);
            return;
        }
        for (const [key, value] of Object.entries(bucket)) {
            if (['seriesKeywords', 'projectionTags'].includes(key)) {
                warn(`${kindLabel}.${key} is not recognised here (ignored)`);
                continue;
            }
            if (!into[key]) {
                into[key] = kindLabel.includes('projection') ? { tags: [] } : { aliases: [] };
            }
            mergeFieldRule(into[key], value, kindLabel, key);
        }
    };

    if (raw.defaults !== undefined) {
        if (!isPlainObject(raw.defaults)) {
            warn('defaults is not an object (ignored)');
        } else {
            if (raw.defaults.seriesKeywords !== undefined) {
                if (Array.isArray(raw.defaults.seriesKeywords)) {
                    rules.defaults.seriesKeywords = raw.defaults.seriesKeywords.map(String).filter(Boolean);
                } else {
                    warn('defaults.seriesKeywords must be an array of strings (ignored)');
                }
            }
            applyBucket(raw.defaults.sr, 'defaults.sr', rules.defaults.sr);
            applyBucket(raw.defaults.projection, 'defaults.projection', rules.defaults.projection);
        }
    }

    if (raw.profiles !== undefined) {
        if (!Array.isArray(raw.profiles)) {
            warn('profiles must be an array (ignored)');
        } else {
            raw.profiles.forEach((profile, index) => {
                if (!isPlainObject(profile)) {
                    warn(`profiles[${index}] is not an object (ignored)`);
                    return;
                }
                const normalized = {
                    id: String(profile.id || `profile-${index + 1}`).trim(),
                    match: isPlainObject(profile.match) ? { ...profile.match } : {},
                    seriesKeywords: Array.isArray(profile.seriesKeywords)
                        ? profile.seriesKeywords.map(String).filter(Boolean)
                        : [],
                    sr: {},
                    projection: {},
                };
                if (profile.seriesKeywords !== undefined && !Array.isArray(profile.seriesKeywords)) {
                    warn(`profiles[${index}].seriesKeywords must be an array of strings (ignored)`);
                }
                applyBucket(profile.sr, `profiles[${index}].sr`, normalized.sr);
                applyBucket(profile.projection, `profiles[${index}].projection`, normalized.projection);
                rules.profiles.push(normalized);
            });
        }
    }

    for (const key of Object.keys(raw)) {
        if (['schemaVersion', 'settings', 'defaults', 'profiles'].includes(key)) continue;
        if (key.startsWith('_') || key.startsWith('$')) continue; // komentar dokumentasi
        warn(`key '${key}' is unknown at the root (ignored)`);
    }

    return rules;
}

function normalizeTag(tag) {
    return String(tag || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase().slice(0, 8);
}

/**
 * Baca rules dari disk. Dipanggil setiap ekstraksi supaya perubahan langsung
 * berlaku. Tidak pernah throw: kalau ada masalah -> default + warning.
 */
function readDoseRules(options = {}) {
    const log = typeof options.log === 'function' ? options.log : () => {};
    const rulesPath = options.path ? path.resolve(options.path) : resolveDoseRulesPath();
    const warnings = [];
    // autoCreated = file belum ada dan baru saja ditulis dari default bawaan.
    // Dibedakan supaya operator tahu file ini masih default, bukan hasil suntingan.
    const autoCreated = ensureDoseRulesFile(rulesPath, log);
    if (!fs.existsSync(rulesPath)) {
        return { rules: normalizeRules(DEFAULT_DOSE_RULES, warnings), path: rulesPath, source: 'builtin', warnings, autoCreated: false };
    }
    let raw;
    try {
        raw = JSON.parse(stripBom(fs.readFileSync(rulesPath, 'utf-8')));
    } catch (err) {
        const message = `[dose-rules] ${rulesPath} could not be read as JSON: ${err.message} -- using the built-in defaults`;
        log(message);
        warnings.push(message);
        return { rules: normalizeRules(DEFAULT_DOSE_RULES, warnings), path: rulesPath, source: 'invalid', warnings, autoCreated };
    }
    const rules = normalizeRules(raw, warnings) || normalizeRules(DEFAULT_DOSE_RULES, warnings);
    const source = autoCreated ? 'default-file' : (warnings.length ? 'custom-with-warnings' : 'custom');
    for (const warning of warnings) log(`[dose-rules] ${warning}`);
    return { rules, path: rulesPath, source, warnings, autoCreated };
}

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

function normalizeText(value) {
    return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeUnit(unit) {
    return normalizeText(unit)
        .replace(/[·⋅]/g, '*')
        .replace(/\s+/g, '')
        .replace(/\*/g, '*');
}

function aliasMatches(alias, item) {
    const concept = normalizeText(item?.concept);
    const itemPath = normalizeText(item?.path);
    if (isPlainObject(alias)) {
        const pattern = String(alias.regex || alias.match || '').trim();
        if (!pattern) return false;
        const flags = String(alias.flags || 'i').replace(/[^gimsuy]/g, '') || 'i';
        try {
            const re = new RegExp(pattern, flags.includes('i') ? flags : `${flags}i`);
            return re.test(concept) || (alias.matchPath === true && re.test(itemPath));
        } catch (err) {
            return false;
        }
    }
    const needle = normalizeText(alias);
    if (!needle) return false;
    return concept.includes(needle) || itemPath.includes(needle);
}

function fieldRuleFor(rules, profile, field, kind) {
    const bucket = kind === 'projection' ? 'projection' : 'sr';
    const base = rules.defaults[bucket][field] || (bucket === 'projection' ? { tags: [] } : { aliases: [] });
    const override = profile?.[bucket]?.[field];
    if (!override) return base;
    const merged = { ...base, ...override };
    if (bucket === 'projection') {
        merged.tags = Array.isArray(override.tags) && override.replaceTags !== true
            ? Array.from(new Set([...(base.tags || []), ...override.tags]))
            : (override.tags || base.tags || []);
        merged.tags = merged.tags.map(normalizeTag).filter(Boolean);
    } else if (override.aliases) {
        // default: alias vendor DITAMBAHKAN ke alias bawaan (paling sering
        // dibutuhkan di lapangan). Pakai "replaceAliases": true untuk mengganti.
        merged.aliases = override.replaceAliases === true
            ? [...override.aliases]
            : [...(base.aliases || []), ...override.aliases];
    }
    return merged;
}

function listSrFields(rules, profile) {
    return Array.from(new Set([
        ...Object.keys(rules.defaults.sr),
        ...Object.keys(profile?.sr || {}),
    ]));
}

function listProjectionFields(rules, profile) {
    return Array.from(new Set([
        ...Object.keys(rules.defaults.projection),
        ...Object.keys(profile?.projection || {}),
    ]));
}

function allSeriesKeywords(rules, profile) {
    const keywords = [
        ...(rules.defaults.seriesKeywords || []),
        ...(profile?.seriesKeywords || []),
        ...rules.profiles.flatMap(item => item.seriesKeywords || []),
    ];
    return Array.from(new Set(keywords.map(normalizeText).filter(Boolean)));
}

function matchesSeriesKeywords(seriesDescription, rules, profile) {
    const description = normalizeText(seriesDescription);
    if (!description) return false;
    return allSeriesKeywords(rules, profile).some(keyword => description.includes(keyword));
}

// ---------------------------------------------------------------------------
// Profile resolution
// ---------------------------------------------------------------------------

function matchesProfile(profile, context) {
    const match = profile?.match || {};
    const manufacturer = normalizeText(context?.manufacturer);
    const stationName = normalizeText(context?.stationName);
    const modality = String(context?.modality || '').trim().toUpperCase();
    const seriesDescription = normalizeText(context?.seriesDescription);

    if (Array.isArray(match.modality) && match.modality.length) {
        const wanted = match.modality.map(item => String(item).trim().toUpperCase());
        if (!wanted.includes(modality)) return false;
    }
    if (Array.isArray(match.manufacturer) && match.manufacturer.length) {
        const wanted = match.manufacturer.map(normalizeText);
        if (!wanted.includes(manufacturer)) return false;
    }
    if (Array.isArray(match.manufacturerContains) && match.manufacturerContains.length) {
        const needles = match.manufacturerContains.map(normalizeText);
        if (!needles.some(needle => manufacturer.includes(needle))) return false;
    }
    if (Array.isArray(match.stationNameContains) && match.stationNameContains.length) {
        const needles = match.stationNameContains.map(normalizeText);
        if (!needles.some(needle => stationName.includes(needle))) return false;
    }
    if (Array.isArray(match.seriesDescriptionContains) && match.seriesDescriptionContains.length) {
        const needles = match.seriesDescriptionContains.map(normalizeText);
        if (!needles.some(needle => seriesDescription.includes(needle))) return false;
    }
    const hasCondition = ['modality', 'manufacturer', 'manufacturerContains', 'stationNameContains', 'seriesDescriptionContains']
        .some(key => Array.isArray(match[key]) && match[key].length);
    return hasCondition;
}

/**
 * Profil paling spesifik yang cocok. Diurutkan dari yang paling banyak
 * kondisi cocok, jadi profil vendor+modality menang atas vendor saja.
 */
function resolveProfile(rules, context) {
    const matched = (rules.profiles || [])
        .filter(profile => matchesProfile(profile, context))
        .map(profile => ({
            profile,
            score: Object.values(profile.match || {}).reduce((total, value) => total + (Array.isArray(value) ? value.length : 0), 0),
        }))
        .sort((a, b) => b.score - a.score);
    return matched.length ? matched[0].profile : null;
}

// ---------------------------------------------------------------------------
// Value extraction (pure)
// ---------------------------------------------------------------------------

function formatDoseNumber(value) {
    return Number.isFinite(value) ? String(Number(value.toFixed(3))) : '';
}

function applyReduce(items, reduce) {
    if (!items.length) return null;
    const values = items.map(item => Number(item.value)).filter(Number.isFinite);
    if (!values.length) return null;
    switch (String(reduce || 'first')) {
        case 'max': return Math.max(...values);
        case 'min': return Math.min(...values);
        case 'sum': return values.reduce((total, value) => total + value, 0);
        case 'avg': return values.reduce((total, value) => total + value, 0) / values.length;
        default: return values[0];
    }
}

function convertUnit(value, fromUnit, rule) {
    const scale = rule?.unitScale;
    if (!Number.isFinite(value) || !isPlainObject(scale)) return { value, converted: false, fromUnit };
    const key = normalizeUnit(fromUnit);
    const factor = Number(scale[key] ?? scale[normalizeText(fromUnit)]);
    if (!Number.isFinite(factor) || factor === 1) return { value, converted: false, fromUnit };
    return { value: value * factor, converted: true, fromUnit };
}

/**
 * Hitung nilai field dari isi Structured Report yang sudah di-flatten.
 * @param {object} rules
 * @param {object|null} profile
 * @param {{numeric:Array, text:Array, code:Array}} srContent
 */
function computeSrValues(rules, profile, srContent) {
    const numeric = Array.isArray(srContent?.numeric) ? srContent.numeric : [];
    const textAndCode = [...(srContent?.text || []), ...(srContent?.code || [])];
    const values = {};
    const matched = {};
    const missing = [];
    const usedItems = new Set();

    for (const field of listSrFields(rules, profile)) {
        const rule = fieldRuleFor(rules, profile, field, 'sr');
        const aliases = rule.aliases || [];
        if (!aliases.length) continue;
        const isText = String(rule.type || '').toLowerCase() === 'text';
        const pool = isText ? textAndCode : numeric;
        const hits = pool.filter(item => aliases.some(alias => aliasMatches(alias, item)));
        if (!hits.length) {
            missing.push(field);
            continue;
        }
        hits.forEach(item => usedItems.add(item));
        if (isText) {
            values[field] = String(hits[0].value ?? '').trim();
            matched[field] = { concept: hits[0].concept, path: hits[0].path, unit: '' };
            continue;
        }
        const reduced = applyReduce(hits, rule.reduce);
        if (reduced === null) {
            missing.push(field);
            continue;
        }
        const unit = hits[0].unit || rule.unit || '';
        const converted = convertUnit(reduced, hits[0].unit, rule);
        values[field] = formatDoseNumber(converted.value);
        matched[field] = {
            concept: hits[0].concept,
            path: hits[0].path,
            unit,
            reduce: String(rule.reduce || 'first'),
            ...(converted.converted ? { convertedFrom: converted.fromUnit, convertedTo: rule.unit } : {}),
        };
    }

    const unknownConcepts = Array.from(new Set(
        numeric
            .filter(item => !usedItems.has(item))
            .map(item => String(item.concept || '').trim())
            .filter(Boolean)
    ));
    return { values, matched, missing, unknownConcepts };
}

/**
 * Hitung nilai field proyeksi/DX dari metadata (lookup tag -> nilai).
 * @param {object} rules
 * @param {object|null} profile
 * @param {{number:Function, text:Function}} lookup
 */
function computeProjectionValues(rules, profile, lookup) {
    const readNumber = typeof lookup?.number === 'function' ? lookup.number : () => null;
    const readText = typeof lookup?.text === 'function' ? lookup.text : () => '';
    const values = {};
    const used = {};
    const missing = [];

    for (const field of listProjectionFields(rules, profile)) {
        const rule = fieldRuleFor(rules, profile, field, 'projection');
        const isText = String(rule.type || '').toLowerCase() === 'text';
        let value = '';
        let sourceTag = '';

        if (isText) {
            for (const tag of rule.tags || []) {
                const text = String(readText(tag) || '').trim();
                if (text) { value = text; sourceTag = tag; break; }
            }
        } else {
            const scale = Number.isFinite(Number(rule.scale)) ? Number(rule.scale) : 1;
            for (const tag of rule.tags || []) {
                const raw = readNumber(tag);
                if (raw === null || raw === undefined) continue;
                const scaled = Number(raw) * scale;
                if (Number.isFinite(scaled)) { value = formatDoseNumber(scaled); sourceTag = tag; break; }
            }
            if (!value && rule.deriveFrom) {
                const baseRule = fieldRuleFor(rules, profile, rule.deriveFrom, 'projection');
                const factor = Number.isFinite(Number(rule.factor)) ? Number(rule.factor) : 1;
                for (const tag of baseRule.tags || []) {
                    const raw = readNumber(tag);
                    if (raw === null || raw === undefined) continue;
                    const derived = Number(raw) * factor;
                    if (Number.isFinite(derived)) {
                        value = formatDoseNumber(derived);
                        sourceTag = `${tag}*${factor}`;
                        break;
                    }
                }
            }
        }

        if (value === '') { missing.push(field); continue; }
        values[field] = value;
        used[field] = sourceTag;
    }
    return { values, used, missing };
}

function hasDoseValue(values) {
    return Object.values(values || {}).some(value => String(value ?? '').trim() !== '');
}

// ---------------------------------------------------------------------------
// Diagnostic log (untuk diagnosa lapangan)
// ---------------------------------------------------------------------------

function appendDiagnosticLog(rules, entry, options = {}) {
    if (rules?.settings?.diagnosticLog === false) return false;
    const log = typeof options.log === 'function' ? options.log : () => {};
    const rulesPath = options.rulesPath || resolveDoseRulesPath();
    const filePath = path.join(path.dirname(rulesPath), 'dose-extract.log');
    try {
        const maxBytes = Number(rules?.settings?.diagnosticLogMaxBytes) || 512 * 1024;
        if (fs.existsSync(filePath) && fs.statSync(filePath).size > maxBytes) {
            fs.renameSync(filePath, `${filePath}.1`);
        }
        fs.appendFileSync(filePath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf-8');
        return true;
    } catch (err) {
        log(`[dose-rules] gagal menulis diagnostic log: ${err.message}`);
        return false;
    }
}

function readDiagnosticLog(limit = 50, options = {}) {
    const rulesPath = options.rulesPath || resolveDoseRulesPath();
    const filePath = path.join(path.dirname(rulesPath), 'dose-extract.log');
    if (!fs.existsSync(filePath)) return { path: filePath, entries: [] };
    try {
        const lines = stripBom(fs.readFileSync(filePath, 'utf-8'))
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean);
        const take = Math.max(1, Math.min(1000, Number(limit) || 50));
        const entries = [];
        for (const line of lines.slice(-take)) {
            try { entries.push(JSON.parse(line)); } catch (_) { /* baris rusak diabaikan */ }
        }
        return { path: filePath, entries };
    } catch (err) {
        return { path: filePath, entries: [], error: err.message };
    }
}

function allProjectionTags(rules, profile) {
    const tags = [];
    for (const field of listProjectionFields(rules, profile)) {
        for (const tag of (fieldRuleFor(rules, profile, field, 'projection').tags || [])) {
            if (!tags.includes(tag)) tags.push(tag);
        }
    }
    return tags;
}

function summarizeRules(rules) {
    return {
        schemaVersion: rules.schemaVersion,
        settings: rules.settings,
        defaults: {
            seriesKeywords: rules.defaults.seriesKeywords,
            srFields: Object.keys(rules.defaults.sr),
            projectionFields: Object.keys(rules.defaults.projection),
        },
        profiles: (rules.profiles || []).map(profile => ({
            id: profile.id,
            match: profile.match,
            seriesKeywords: profile.seriesKeywords,
            srFields: Object.keys(profile.sr || {}),
            projectionFields: Object.keys(profile.projection || {}),
        })),
    };
}

module.exports = {
    SCHEMA_VERSION,
    DEFAULT_DOSE_RULES,
    resolveDoseRulesPath,
    readDoseRules,
    normalizeRules,
    normalizeTag,
    normalizeUnit,
    normalizeText,
    resolveProfile,
    matchesSeriesKeywords,
    allSeriesKeywords,
    fieldRuleFor,
    listSrFields,
    listProjectionFields,
    allProjectionTags,
    computeSrValues,
    computeProjectionValues,
    formatDoseNumber,
    hasDoseValue,
    appendDiagnosticLog,
    readDiagnosticLog,
    summarizeRules,
    stripBom,
};
