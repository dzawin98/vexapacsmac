const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const { exec, execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const crypto = require('crypto');
const zlib = require('zlib');
const dotenv = require('dotenv');
const dicomParser = require('dicom-parser');
const { enforceLicenseAtStartup } = require('../../scripts/license/licenseRuntime');
const { loadLicense } = require('../../scripts/license/licenseCore');
const envCandidates = [
    path.resolve(__dirname, '.env'),
    path.resolve(__dirname, '..', '.env'),
    path.resolve(__dirname, '..', '..', '.env'),
];
let envLoaded = false;
for (const candidate of envCandidates) {
    if (fs.existsSync(candidate)) {
        dotenv.config({ path: candidate });
        envLoaded = true;
        break;
    }
}
if (!envLoaded) {
    dotenv.config();
}
enforceLicenseAtStartup('RIS');
const dicomConfig = require('./config/dicom');
const pool = require('./src/services/db');
const dicomwebRoutes = require('./src/routes/dicomwebRoutes');
const { clearQidoCache, getStudies, getSeries, getInstances, getRuntimeStats: getDicomwebRuntimeStats } = require('./src/services/dicomwebService');
const dicomwebPacs = require('./src/services/dicomwebPacsService');
const { createCache } = require('./src/utils/cache');

const app = express();
const port = process.env.PORT || 8080;
const ORTHANC_ROOT = process.env.ORTHANC_ROOT || 'http://127.0.0.1:8042';
const DICOMWEB_PACS_ROOT = process.env.DICOMWEB_PACS_ROOT || 'http://127.0.0.1:5001';
const ORTHANC_SERVICE_NAME = process.env.ORTHANC_SERVICE_NAME || 'Orthanc';
const APP_SETTINGS_PATH = path.resolve(process.env.VEXA_APP_SETTINGS_PATH || path.join(__dirname, 'settings.json'));
const PROGRAM_DATA_DIR = process.env.VEXA_PROGRAM_DATA_DIR ||
    process.env.VELO_PROGRAM_DATA_DIR ||
    (process.env.ProgramData
        ? path.join(process.env.ProgramData, 'VEXAPACS')
        : process.platform === 'darwin'
            ? path.join(require('os').homedir(), 'Library', 'Application Support', 'VEXAPACS')
            : path.join(require('os').homedir(), '.vexapacs', 'VEXAPACS'));
const BACKUP_CONFIG_PATH = process.env.VEXA_BACKUP_CONFIG_PATH ||
    process.env.VELO_BACKUP_CONFIG_PATH ||
    path.join(PROGRAM_DATA_DIR, 'backup.config.json');
const BACKUP_SCRIPT_PATH = process.env.VEXA_BACKUP_SCRIPT_PATH ||
    process.env.VELO_BACKUP_SCRIPT_PATH ||
    path.resolve(__dirname, '..', '..', 'installer', 'scripts', 'backup', 'backup.ps1');
const BACKUP_TASK_SCRIPT_PATH = process.env.VEXA_BACKUP_TASK_SCRIPT_PATH ||
    process.env.VELO_BACKUP_TASK_SCRIPT_PATH ||
    path.resolve(__dirname, '..', '..', 'installer', 'scripts', 'backup', 'register-backup-task.ps1');
const RESTORE_SCRIPT_PATH = process.env.VEXA_RESTORE_SCRIPT_PATH ||
    process.env.VELO_RESTORE_SCRIPT_PATH ||
    path.resolve(__dirname, '..', '..', 'installer', 'scripts', 'backup', 'restore.ps1');
const BACKUP_TASK_NAME =
    process.env.VEXA_BACKUP_TASK_NAME ||
    process.env.VELO_BACKUP_TASK_NAME ||
    'VEXAPACS Daily Backup';
let backupRuntimeJob = null;
const DEFAULT_PUBLIC_BASE_URL = process.env.VEXA_PUBLIC_BASE_URL ||
    process.env.PUBLIC_SHARE_BASE_URL ||
    'http://localhost:8080';
const DEFAULT_DESKTOP_VIEWER_BASE_URL = process.env.VEXA_DESKTOP_VIEWER_PUBLIC_URL || '/viewer';
const DEFAULT_DESKTOP_VIEWER_INTERNAL_URL = process.env.VEXA_DESKTOP_VIEWER_INTERNAL_URL || 'http://127.0.0.1:5994';
const DEFAULT_MOBILE_VIEWER_BASE_URL = process.env.VEXA_MOBILE_VIEWER_PUBLIC_URL || '/mobile';
const DEFAULT_MOBILE_VIEWER_INTERNAL_URL = process.env.VEXA_MOBILE_VIEWER_INTERNAL_URL || 'http://127.0.0.1:5992';
const DEFAULT_ECG_VIEWER_BASE_URL = process.env.VEXA_ECG_VIEWER_PUBLIC_URL || '/ecg';
const DEFAULT_ECG_VIEWER_INTERNAL_URL = process.env.VEXA_ECG_VIEWER_INTERNAL_URL || 'http://127.0.0.1:7771';
const DEFAULT_DESKTOP_RIS_HEADER_NAME = process.env.VEXA_DESKTOP_RIS_HEADER_NAME || 'RIS-Desktop-Sec';
const DEFAULT_DESKTOP_RIS_SHARED_SECRET = process.env.VEXA_DESKTOP_RIS_SHARED_SECRET || 'Velodesktopview89287579@#VEXA@';
const DEFAULT_MOBILE_RIS_HEADER_NAME = process.env.VEXA_MOBILE_RIS_HEADER_NAME || 'RIS-Vexa-Mobilesec';
const DEFAULT_MOBILE_RIS_SHARED_SECRET = process.env.VEXA_MOBILE_RIS_SHARED_SECRET || 'Velomobile987397497987#VEXA@';

const DEFAULT_APP_LINK_SETTINGS = {
    publicBaseUrl: DEFAULT_PUBLIC_BASE_URL,
    appVersion: 'Version 1.26.1',
    viewerTokenPath: '/viewer/token',
    viewerAccessToken: {
        expiresInDays: 7,
    },
    publicStudyPath: '/public/study',
    viewerLaunchBaseUrl: DEFAULT_DESKTOP_VIEWER_BASE_URL,
    pacsViewerEnabled: true,
    pacsViewerBaseUrl: DEFAULT_DESKTOP_VIEWER_BASE_URL,
    pacsViewerLaunchEndpoint: '/api/auth/ris/launch',
    pacsViewerHeaderName: DEFAULT_DESKTOP_RIS_HEADER_NAME,
    pacsViewerSharedSecret: DEFAULT_DESKTOP_RIS_SHARED_SECRET,
    facility: {
        name: 'NEXIA DEMO Hospital',
        address: '1 Demo Hospital Street',
    },
    orderOutLinks: {
        urllink1: {
            enabled: true,
            type: 'viewer',
            viewerId: 'vexa-pacs',
            role: 'clinician',
            label: 'Desktop Viewer Clinician',
            launchUser: {
                externalUserId: 'simrs',
                username: 'simrs',
                password: 'simrs',
                fullName: 'SIMRS Clinician',
                role: 'clinician',
            },
        },
        urllink2: {
            enabled: true,
            type: 'viewer',
            viewerId: 'vexa-mobile',
            role: 'clinician',
            label: 'Mobile Viewer Clinician',
            launchUser: {
                externalUserId: 'simrs',
                username: 'simrs',
                password: 'simrs',
                fullName: 'SIMRS Clinician',
                role: 'clinician',
            },
        },
        urllink3: {
            enabled: true,
            type: 'publicStudy',
            label: 'Patient Public Study',
        },
        urllink4: {
            enabled: true,
            type: 'viewer',
            viewerId: 'ecg-viewer',
            role: 'clinician',
            label: 'ECG Viewer Clinician',
            onlyForModalities: ['ECG'],
        },
        urllink5: { enabled: false, type: 'none' },
        urllink6: { enabled: false, type: 'none' },
    },
    simrsApi: {
        apiKey: '',
        allowedIps: [],
        username: 'simrs-integration',
        role: 'administrator',
    },
    simrsDbBridge: {
        enabled: false,
        mode: 'api-and-db',
        pollIntervalMs: 5000,
        batchSize: 50,
        risApi: {
            baseUrl: 'http://127.0.0.1:3001/api',
            apiKey: '',
        },
        postgres: {
            orderIn: {
                enabled: true,
                table: 'test_orderin',
                db: {
                    host: '127.0.0.1',
                    port: 5432,
                    database: 'ris',
                    user: 'postgres',
                    password: 'velo',
                },
            },
            orderOut: {
                enabled: true,
                table: 'test_orderout',
                updateRisFilter: 'N',
                ackInternalAfterPush: false,
                db: {
                    host: '127.0.0.1',
                    port: 5432,
                    database: 'ris',
                    user: 'postgres',
                    password: 'velo',
                },
            },
        },
    },
    whatsappBaseUrl: 'https://wa.me',
    whatsapp: {
        enabled: false,
        provider: 'waha',
        baseUrl: 'http://localhost:3000',
        session: 'default',
        apiKey: '',
        sendTextPath: '/api/sendText',
        phoneCountryCode: '62',
        fallbackToWeb: true,
        custom: {
            endpointUrl: '',
            method: 'POST',
            headersTemplate: '{"Authorization":"Bearer {{apiKey}}","Content-Type":"application/json"}',
            bodyTemplate: '{"number":"{{number}}","message":"{{message}}"}',
            successJsonPath: '',
            successExpectedValue: '',
            timeoutMs: 10000,
        },
    },
    viewers: [
        {
            id: 'vexa-pacs',
            name: 'Desktop Viewer',
            baseUrl: DEFAULT_DESKTOP_VIEWER_BASE_URL,
            internalBaseUrl: DEFAULT_DESKTOP_VIEWER_INTERNAL_URL,
            path: '/Viewer',
            queryParam: 'launch',
            type: 'vexa-ris-launch',
            launchEndpoint: '/api/auth/ris/launch',
            launchHeaderName: DEFAULT_DESKTOP_RIS_HEADER_NAME,
            launchSharedSecret: DEFAULT_DESKTOP_RIS_SHARED_SECRET,
        },
        {
            id: 'vexa-mobile',
            name: 'Mobile Viewer',
            baseUrl: DEFAULT_MOBILE_VIEWER_BASE_URL,
            internalBaseUrl: DEFAULT_MOBILE_VIEWER_INTERNAL_URL,
            path: '/Viewer',
            queryParam: 'launch',
            type: 'vexa-ris-launch',
            launchEndpoint: '/api/auth/ris/launch',
            launchHeaderName: DEFAULT_MOBILE_RIS_HEADER_NAME,
            launchSharedSecret: DEFAULT_MOBILE_RIS_SHARED_SECRET,
        },
        {
            id: 'ecg-viewer',
            name: 'VEXA ECG',
            baseUrl: DEFAULT_ECG_VIEWER_BASE_URL,
            internalBaseUrl: DEFAULT_ECG_VIEWER_INTERNAL_URL,
            path: '/viewer',
            queryParam: 'StudyInstanceUIDs',
            modalityFilter: ['ECG'],
        },
    ],
};
const DEFAULT_UI_SETTINGS = {
    viewerUrl: DEFAULT_DESKTOP_VIEWER_BASE_URL,
    viewerPath: '/Viewer',
    autoRefresh: true,
    worklistSeriesPreviewEnabled: true,
    radiologistCompetitionEnabled: false,
    viewerAccessLinkDays: 7,
    patientPortalMaxImagesPerSeries: 100,
    radiologistWhatsappNotification: {
        mode: 'manual',
        scope: 'all',
        messageTemplate: [
            'Hello {{radiologist_name}},',
            '',
            'Please read the following study as soon as possible:',
            'Patient: {{patient_name}}',
            'MRN: {{patient_id}}',
            'Accession: {{accession_number}}',
            'Study: {{study_description}}',
            'Priority: {{priority}}',
            '',
            'Open the reporting page: {{reporting_link}}',
        ].join('\n'),
    },
    viewers: [
        {
            id: 'vexa-pacs',
            name: 'Desktop Viewer',
            baseUrl: DEFAULT_DESKTOP_VIEWER_BASE_URL,
            internalBaseUrl: DEFAULT_DESKTOP_VIEWER_INTERNAL_URL,
            path: '/Viewer',
            queryParam: 'launch',
            type: 'vexa-ris-launch',
            launchEndpoint: '/api/auth/ris/launch',
            launchHeaderName: DEFAULT_DESKTOP_RIS_HEADER_NAME,
            launchSharedSecret: DEFAULT_DESKTOP_RIS_SHARED_SECRET,
        },
        {
            id: 'vexa-mobile',
            name: 'Mobile Viewer',
            baseUrl: DEFAULT_MOBILE_VIEWER_BASE_URL,
            internalBaseUrl: DEFAULT_MOBILE_VIEWER_INTERNAL_URL,
            path: '/Viewer',
            queryParam: 'launch',
            type: 'vexa-ris-launch',
            launchEndpoint: '/api/auth/ris/launch',
            launchHeaderName: DEFAULT_MOBILE_RIS_HEADER_NAME,
            launchSharedSecret: DEFAULT_MOBILE_RIS_SHARED_SECRET,
        },
        {
            id: 'ecg-viewer',
            name: 'VEXA ECG',
            baseUrl: DEFAULT_ECG_VIEWER_BASE_URL,
            internalBaseUrl: DEFAULT_ECG_VIEWER_INTERNAL_URL,
            path: '/viewer',
            queryParam: 'StudyInstanceUIDs',
            modalityFilter: ['ECG'],
        },
    ],
};

const CANONICAL_RIS_LAUNCH_VIEWERS = {
    'velo-pacs': {
        headerName: DEFAULT_DESKTOP_RIS_HEADER_NAME,
        sharedSecret: DEFAULT_DESKTOP_RIS_SHARED_SECRET,
    },
    'vexa-pacs': {
        headerName: DEFAULT_DESKTOP_RIS_HEADER_NAME,
        sharedSecret: DEFAULT_DESKTOP_RIS_SHARED_SECRET,
    },
    'velo-mobile': {
        headerName: DEFAULT_MOBILE_RIS_HEADER_NAME,
        sharedSecret: DEFAULT_MOBILE_RIS_SHARED_SECRET,
    },
    'vexa-mobile': {
        headerName: DEFAULT_MOBILE_RIS_HEADER_NAME,
        sharedSecret: DEFAULT_MOBILE_RIS_SHARED_SECRET,
    },
};

function getLicensedFacilityOverride() {
    try {
        const license = loadLicense();
        const payload = license && typeof license === 'object' ? license.payload : null;
        if (!payload || typeof payload !== 'object') return null;
        const name = String(payload.customerName || payload.customerId || '').trim();
        const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
        const address = String(metadata.facilityAddress || metadata.customerAddress || '').trim();
        if (!name && !address) return null;
        return { name, address };
    } catch (err) {
        return null;
    }
}

function resolvePublicFacility(facility) {
    const base = facility || DEFAULT_APP_LINK_SETTINGS.facility;
    const licensed = getLicensedFacilityOverride();
    return {
        name: licensed?.name || base.name || DEFAULT_APP_LINK_SETTINGS.facility.name,
        address: licensed?.address || base.address || DEFAULT_APP_LINK_SETTINGS.facility.address,
    };
}

function normalizeAppLinkSettings(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const publicBaseUrl = String(
        input.publicBaseUrl || process.env.PUBLIC_SHARE_BASE_URL || DEFAULT_APP_LINK_SETTINGS.publicBaseUrl
    ).trim().replace(/\/+$/, '');
    const appVersion = String(input.appVersion || DEFAULT_APP_LINK_SETTINGS.appVersion).trim() || DEFAULT_APP_LINK_SETTINGS.appVersion;
    const viewerTokenPath = `/${String(
        input.viewerTokenPath || DEFAULT_APP_LINK_SETTINGS.viewerTokenPath
    ).trim().replace(/^\/+/, '').replace(/\/+$/, '')}`;
    const publicStudyPath = `/${String(
        input.publicStudyPath || DEFAULT_APP_LINK_SETTINGS.publicStudyPath
    ).trim().replace(/^\/+/, '').replace(/\/+$/, '')}`;
    const viewerLaunchBaseUrl = String(
        input.viewerLaunchBaseUrl || process.env.ORDER_OUT_VIEWER_URL || DEFAULT_APP_LINK_SETTINGS.viewerLaunchBaseUrl
    ).trim().replace(/\/+$/, '');
    const pacsViewerEnabledRaw = input.pacsViewerEnabled ?? process.env.PACS_VIEWER_ENABLED;
    const pacsViewerEnabled = pacsViewerEnabledRaw === undefined || pacsViewerEnabledRaw === null
        ? DEFAULT_APP_LINK_SETTINGS.pacsViewerEnabled !== false
        : String(pacsViewerEnabledRaw).toLowerCase() !== 'false';
    const pacsViewerBaseUrl = String(
        input.pacsViewerBaseUrl || process.env.PACS_VIEWER_BASE_URL || DEFAULT_APP_LINK_SETTINGS.pacsViewerBaseUrl
    ).trim().replace(/\/+$/, '');
    const pacsViewerLaunchEndpoint = `/${String(
        input.pacsViewerLaunchEndpoint ||
            process.env.PACS_VIEWER_LAUNCH_ENDPOINT ||
            DEFAULT_APP_LINK_SETTINGS.pacsViewerLaunchEndpoint
    ).trim().replace(/^\/+/, '')}`;
    const pacsViewerSharedSecret = String(
        input.pacsViewerSharedSecret ||
            process.env.PACS_VIEWER_SHARED_SECRET ||
            DEFAULT_APP_LINK_SETTINGS.pacsViewerSharedSecret
    ).trim();
    const pacsViewerHeaderName = String(
        input.pacsViewerHeaderName ||
            process.env.PACS_VIEWER_HEADER_NAME ||
            DEFAULT_APP_LINK_SETTINGS.pacsViewerHeaderName
    ).trim();
    const rawFacility = input.facility && typeof input.facility === 'object' ? input.facility : {};
    const facility = {
        name: String(rawFacility.name || DEFAULT_APP_LINK_SETTINGS.facility.name).trim(),
        address: String(rawFacility.address || DEFAULT_APP_LINK_SETTINGS.facility.address).trim(),
    };
    const orderOutLinks = normalizeOrderOutLinkSettings(input.orderOutLinks);
    const rawViewerAccessToken = input.viewerAccessToken && typeof input.viewerAccessToken === 'object'
        ? input.viewerAccessToken
        : {};
    const defaultViewerAccessToken = DEFAULT_APP_LINK_SETTINGS.viewerAccessToken || {};
    const viewerAccessTokenDays = Number(
        rawViewerAccessToken.expiresInDays ??
        rawViewerAccessToken.ttlDays ??
        defaultViewerAccessToken.expiresInDays
    );
    const viewerAccessToken = {
        expiresInDays: Number.isFinite(viewerAccessTokenDays) && viewerAccessTokenDays >= 0
            ? Math.floor(viewerAccessTokenDays)
            : defaultViewerAccessToken.expiresInDays,
    };
    const simrsApi = normalizeSimrsApiSettings(input.simrsApi);
    const simrsDbBridge = normalizeSimrsDbBridgeSettings(input.simrsDbBridge);
    const whatsappBaseUrl = String(
        input.whatsappBaseUrl || DEFAULT_APP_LINK_SETTINGS.whatsappBaseUrl
    ).trim().replace(/\/+$/, '');
    const rawWhatsapp = input.whatsapp && typeof input.whatsapp === 'object' ? input.whatsapp : {};
    const defaultWhatsapp = DEFAULT_APP_LINK_SETTINGS.whatsapp;
    const rawWhatsappCustom = rawWhatsapp.custom && typeof rawWhatsapp.custom === 'object' ? rawWhatsapp.custom : {};
    const defaultWhatsappCustom = defaultWhatsapp.custom || {};
    const customWhatsappMethod = String(rawWhatsappCustom.method || defaultWhatsappCustom.method || 'POST').trim().toUpperCase();
    const customWhatsappTimeout = Number(rawWhatsappCustom.timeoutMs ?? defaultWhatsappCustom.timeoutMs ?? 10000);
    const whatsapp = {
        enabled: rawWhatsapp.enabled === true || String(rawWhatsapp.enabled || '').toLowerCase() === 'true',
        provider: String(rawWhatsapp.provider || defaultWhatsapp.provider).trim().toLowerCase() || defaultWhatsapp.provider,
        baseUrl: String(rawWhatsapp.baseUrl || process.env.WHATSAPP_API_BASE_URL || defaultWhatsapp.baseUrl)
            .trim()
            .replace(/\/+$/, ''),
        session: String(rawWhatsapp.session || process.env.WHATSAPP_API_SESSION || defaultWhatsapp.session).trim() || defaultWhatsapp.session,
        apiKey: String(rawWhatsapp.apiKey || process.env.WHATSAPP_API_KEY || defaultWhatsapp.apiKey).trim(),
        sendTextPath: `/${String(rawWhatsapp.sendTextPath || defaultWhatsapp.sendTextPath)
            .trim()
            .replace(/^\/+/, '')}`,
        phoneCountryCode: String(rawWhatsapp.phoneCountryCode || defaultWhatsapp.phoneCountryCode)
            .replace(/[^0-9]/g, '') || defaultWhatsapp.phoneCountryCode,
        fallbackToWeb: rawWhatsapp.fallbackToWeb !== false,
        custom: {
            endpointUrl: String(rawWhatsappCustom.endpointUrl || defaultWhatsappCustom.endpointUrl || '').trim(),
            method: ['GET', 'POST', 'PUT', 'PATCH'].includes(customWhatsappMethod) ? customWhatsappMethod : 'POST',
            headersTemplate: String(rawWhatsappCustom.headersTemplate ?? defaultWhatsappCustom.headersTemplate ?? '{}').trim() || '{}',
            bodyTemplate: String(rawWhatsappCustom.bodyTemplate ?? defaultWhatsappCustom.bodyTemplate ?? '').trim(),
            successJsonPath: String(rawWhatsappCustom.successJsonPath || defaultWhatsappCustom.successJsonPath || '').trim(),
            successExpectedValue: String(rawWhatsappCustom.successExpectedValue ?? defaultWhatsappCustom.successExpectedValue ?? '').trim(),
            timeoutMs: Number.isFinite(customWhatsappTimeout)
                ? Math.min(Math.max(Math.trunc(customWhatsappTimeout), 1000), 60000)
                : 10000,
        },
    };
    const rawViewers = Array.isArray(input.viewers) ? input.viewers : DEFAULT_APP_LINK_SETTINGS.viewers;
    const viewers = [];
    for (const entry of rawViewers) {
        if (!entry) continue;
        const baseUrl = String(entry.baseUrl || DEFAULT_APP_LINK_SETTINGS.viewers[0].baseUrl).trim().replace(/\/+$/, '');
        const path = `/${String(entry.path || DEFAULT_APP_LINK_SETTINGS.viewers[0].path).trim().replace(/^\/+/, '')}`;
        const queryParam = String(entry.queryParam || 'StudyInstanceUIDs').trim() || 'StudyInstanceUIDs';
        const name = String(entry.name || 'Viewer').trim() || 'Viewer';
        const id = String(entry.id || name || `${baseUrl}${path}${queryParam}`).trim();
        viewers.push({
            id,
            name,
            baseUrl,
            internalBaseUrl: entry.internalBaseUrl ? String(entry.internalBaseUrl).trim().replace(/\/+$/, '') : undefined,
            launchInternalBaseUrl: entry.launchInternalBaseUrl ? String(entry.launchInternalBaseUrl).trim().replace(/\/+$/, '') : undefined,
            internalUrl: entry.internalUrl ? String(entry.internalUrl).trim().replace(/\/+$/, '') : undefined,
            path,
            queryParam,
            type: String(entry.type || 'url').trim() || 'url',
            rpcUrl: entry.rpcUrl ? String(entry.rpcUrl).trim() : undefined,
            command: entry.command ? String(entry.command).trim() : undefined,
            commandType: entry.commandType ? String(entry.commandType).trim() : undefined,
            pacsAet: entry.pacsAet ? String(entry.pacsAet).trim() : undefined,
            pacsIp: entry.pacsIp ? String(entry.pacsIp).trim() : undefined,
            pacsPort: entry.pacsPort ? String(entry.pacsPort).trim() : undefined,
            wadoServiceRootPath: entry.wadoServiceRootPath ? String(entry.wadoServiceRootPath).trim() : undefined,
            isWadoSecured: entry.isWadoSecured === true || String(entry.isWadoSecured || '').toLowerCase() === 'true',
            wadoPort: entry.wadoPort ? String(entry.wadoPort).trim() : undefined,
            wadoAuthLogin: entry.wadoAuthLogin ? String(entry.wadoAuthLogin).trim() : undefined,
            wadoAuthPassword: entry.wadoAuthPassword ? String(entry.wadoAuthPassword).trim() : undefined,
            launchEndpoint: entry.launchEndpoint
                ? `/${String(entry.launchEndpoint).trim().replace(/^\/+/, '')}`
                : undefined,
            launchHeaderName: entry.launchHeaderName ? String(entry.launchHeaderName).trim() : undefined,
            launchSharedSecret: entry.launchSharedSecret ? String(entry.launchSharedSecret).trim() : undefined,
            modalityFilter: Array.isArray(entry.modalityFilter)
                ? entry.modalityFilter.map(value => String(value || '').trim().toUpperCase()).filter(Boolean)
                : undefined,
        });
    }
    if (!viewers.length) {
        viewers.push(...DEFAULT_APP_LINK_SETTINGS.viewers);
    }

    return {
        publicBaseUrl,
        appVersion,
        viewerTokenPath,
        publicStudyPath,
        viewerLaunchBaseUrl,
        pacsViewerEnabled,
        pacsViewerBaseUrl,
        pacsViewerLaunchEndpoint,
        pacsViewerHeaderName,
        pacsViewerSharedSecret,
        facility,
        viewerAccessToken,
        orderOutLinks,
        simrsApi,
        simrsDbBridge,
        whatsappBaseUrl,
        whatsapp,
        viewers,
    };
}

function normalizeSimrsDbBridgeSettings(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const defaults = DEFAULT_APP_LINK_SETTINGS.simrsDbBridge || {};
    const normalizeDriver = value => {
        const driver = String(value || 'postgresql').trim().toLowerCase();
        if (['postgres', 'postgresql', 'pg'].includes(driver)) return 'postgresql';
        if (['mysql', 'mysql2'].includes(driver)) return 'mysql';
        if (['mariadb', 'maria'].includes(driver)) return 'mariadb';
        if (['mssql', 'sqlserver', 'sql-server'].includes(driver)) return 'sqlserver';
        return 'postgresql';
    };
    const normalizeDb = (input, fallback, fallbackDriver = 'postgresql') => {
        const db = input && typeof input === 'object' ? input : {};
        const base = fallback && typeof fallback === 'object' ? fallback : {};
        const driver = normalizeDriver(db.driver || fallbackDriver);
        const defaultPort = ['mysql', 'mariadb'].includes(driver) ? 3306 : driver === 'sqlserver' ? 1433 : 5432;
        return {
            driver,
            dialect: db.dialect ? String(db.dialect).trim() : undefined,
            host: String(db.host || base.host || '127.0.0.1').trim() || '127.0.0.1',
            port: Number(db.port || base.port || defaultPort) || defaultPort,
            database: String(db.database || base.database || 'postgres').trim() || 'postgres',
            user: String(db.user || base.user || 'postgres').trim() || 'postgres',
            password: String(db.password ?? base.password ?? ''),
            ssl: db.ssl === true || String(db.ssl || '').toLowerCase() === 'true',
            encrypt: db.encrypt === true,
            trustServerCertificate: db.trustServerCertificate !== false,
            instanceName: db.instanceName ? String(db.instanceName).trim() : undefined,
            connectionString: db.connectionString ? String(db.connectionString) : undefined,
        };
    };
    const normalizeSide = (input, fallback, driver = 'postgresql') => {
        const value = input && typeof input === 'object' ? input : {};
        const base = fallback && typeof fallback === 'object' ? fallback : {};
        return {
            enabled: value.enabled !== false,
            table: String(value.table || base.table || 'order_in').trim() || 'order_in',
            updateRisFilter: value.updateRisFilter || base.updateRisFilter ? String(value.updateRisFilter || base.updateRisFilter).trim().toUpperCase() : undefined,
            ackInternalAfterPush: value.ackInternalAfterPush === true,
            columnMap: value.columnMap && typeof value.columnMap === 'object' ? value.columnMap : {},
            db: normalizeDb(value.db, base.db, driver),
        };
    };
    const connectors = Array.isArray(source.connectors) ? source.connectors.map((item, index) => {
        const connector = item && typeof item === 'object' ? item : {};
        const driver = normalizeDriver(connector.driver);
        return {
            id: String(connector.id || `connector-${index + 1}`).trim(),
            name: String(connector.name || `${driver} connector`).trim(),
            enabled: connector.enabled !== false,
            driver,
            orderIn: normalizeSide(connector.orderIn, {}, driver),
            orderOut: normalizeSide(connector.orderOut, {}, driver),
        };
    }) : [];
    return {
        enabled: source.enabled === true || String(source.enabled || '').toLowerCase() === 'true',
        mode: String(source.mode || defaults.mode || 'api-and-db').trim() || 'api-and-db',
        pollIntervalMs: Math.max(3000, Number(source.pollIntervalMs || defaults.pollIntervalMs || 15000)),
        batchSize: Math.min(500, Math.max(1, Number(source.batchSize || defaults.batchSize || 50))),
        risApi: {
            baseUrl: String(source.risApi?.baseUrl || defaults.risApi?.baseUrl || 'http://127.0.0.1:3001/api').trim().replace(/\/+$/, ''),
            apiKey: String(source.risApi?.apiKey || defaults.risApi?.apiKey || '').trim(),
        },
        postgres: {
            orderIn: normalizeSide(source.postgres?.orderIn, defaults.postgres?.orderIn),
            orderOut: normalizeSide(source.postgres?.orderOut, defaults.postgres?.orderOut),
        },
        connectors,
    };
}

function normalizeSimrsApiSettings(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const defaults = DEFAULT_APP_LINK_SETTINGS.simrsApi || {};
    const rawAllowedIps = Array.isArray(source.allowedIps)
        ? source.allowedIps
        : String(source.allowedIps || '').split(',');
    const cleanIp = value =>
        String(value || '')
            .replace(/^::ffff:/, '')
            .trim();
    const cleanRole = value => {
        const normalized = String(value || 'administrator')
            .trim()
            .toLowerCase()
            .replace(/[\s-]+/g, '_');
        if (normalized === 'admin') return 'administrator';
        if (normalized === 'medical_physics' || normalized === 'fismed') return 'medical_physics';
        if (['administrator', 'technologist', 'radiologist', 'clinician'].includes(normalized)) return normalized;
        return normalized || 'administrator';
    };
    return {
        apiKey: String(source.apiKey || defaults.apiKey || '').trim(),
        allowedIps: rawAllowedIps.map(cleanIp).filter(Boolean),
        username: String(source.username || defaults.username || 'simrs-integration').trim() || 'simrs-integration',
        role: cleanRole(source.role || defaults.role || 'administrator'),
    };
}

function normalizeOrderOutLinkSettings(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const defaults = DEFAULT_APP_LINK_SETTINGS.orderOutLinks || {};
    const normalized = {};
    for (let index = 1; index <= 6; index += 1) {
        const key = `urllink${index}`;
        const input = source[key] && typeof source[key] === 'object' ? source[key] : {};
        const fallback = defaults[key] || { enabled: false, type: 'none' };
        const merged = { ...fallback, ...input };
        const type = String(merged.type || 'none').trim();
        const rawLaunchUser = merged.launchUser && typeof merged.launchUser === 'object' ? merged.launchUser : {};
        normalized[key] = {
            enabled: merged.enabled !== false && type !== 'none',
            type,
            viewerId: merged.viewerId ? String(merged.viewerId).trim() : undefined,
            role: merged.role ? String(merged.role).trim().toLowerCase().replace(/\s+/g, '_') : undefined,
            label: merged.label ? String(merged.label).trim() : undefined,
            mode: merged.mode ? String(merged.mode).trim() : undefined,
            literalUrl: merged.literalUrl ? String(merged.literalUrl).trim() : undefined,
            launchUser: Object.keys(rawLaunchUser).length
                ? {
                      externalUserId: rawLaunchUser.externalUserId ? String(rawLaunchUser.externalUserId).trim() : undefined,
                      username: rawLaunchUser.username ? String(rawLaunchUser.username).trim() : undefined,
                      password: rawLaunchUser.password !== undefined ? String(rawLaunchUser.password) : undefined,
                      fullName: rawLaunchUser.fullName || rawLaunchUser.name ? String(rawLaunchUser.fullName || rawLaunchUser.name).trim() : undefined,
                      role: rawLaunchUser.role ? String(rawLaunchUser.role).trim().toLowerCase().replace(/\s+/g, '_') : undefined,
                  }
                : undefined,
            onlyForModalities: Array.isArray(merged.onlyForModalities)
                ? merged.onlyForModalities.map(value => String(value || '').trim().toUpperCase()).filter(Boolean)
                : undefined,
        };
    }
    return normalized;
}

function sanitizeViewerConfigForClient(viewer) {
    if (!viewer || typeof viewer !== 'object') return viewer;
    const {
        internalBaseUrl,
        launchInternalBaseUrl,
        internalUrl,
        launchSharedSecret,
        sharedSecret,
        risSharedSecret,
        secret,
        ...publicViewer
    } = viewer;
    return publicViewer;
}

function resolveRisLaunchViewer(appLinkSettings, viewerId) {
    const requestedId = normalizeNullableString(viewerId, 128);
    const viewers = Array.isArray(appLinkSettings.viewers) ? appLinkSettings.viewers : [];
    const launchViewers = viewers.filter(viewer =>
        viewer?.type === 'vexa-ris-launch' ||
        viewer?.type === 'velo-ris-launch' ||
        viewer?.type === 'ris-launch'
    );
    const selected = requestedId
        ? launchViewers.find(viewer => String(viewer.id || '') === requestedId)
        : launchViewers[0];
    if (selected) return selected;
    if (requestedId) return null;
    return {
        id: 'vexa-pacs',
        name: 'Desktop Viewer',
        baseUrl: appLinkSettings.pacsViewerBaseUrl,
        launchEndpoint: appLinkSettings.pacsViewerLaunchEndpoint,
        launchHeaderName: appLinkSettings.pacsViewerHeaderName || 'RIS-Desktop-Sec',
        launchSharedSecret: appLinkSettings.pacsViewerSharedSecret,
    };
}

function resolveRisLaunchHeaderName(viewer) {
    const canonical = CANONICAL_RIS_LAUNCH_VIEWERS[String(viewer?.id || '').trim()];
    const raw = String(canonical?.headerName || viewer?.launchHeaderName || viewer?.risHeaderName || viewer?.headerName || 'RIS-Desktop-Sec').trim();
    return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(raw) ? raw : 'RIS-Desktop-Sec';
}

function resolveRisLaunchSecret(viewer, appLinkSettings) {
    const canonical = CANONICAL_RIS_LAUNCH_VIEWERS[String(viewer?.id || '').trim()];
    if (canonical?.sharedSecret) return canonical.sharedSecret;
    return String(
        viewer?.launchSharedSecret ||
        viewer?.risSharedSecret ||
        viewer?.sharedSecret ||
        appLinkSettings?.pacsViewerSharedSecret ||
        ''
    ).trim();
}

function resolveRisLaunchEndpointUrl(baseUrl, endpointPath) {
    const baseUrlIsAbsolute = /^https?:\/\//i.test(baseUrl);
    if (!baseUrlIsAbsolute && /\/?:\d+$/.test(baseUrl)) {
        baseUrl = `http://127.0.0.1${baseUrl}`;
    } else if (!baseUrlIsAbsolute) {
        baseUrl = `http://127.0.0.1:80${baseUrl.startsWith('/') ? '' : '/'}${baseUrl}`;
    }
    const base = new URL(baseUrl);
    const endpoint = String(endpointPath || '/api/auth/ris/launch').trim();
    if (/^https?:\/\//i.test(endpoint)) {
        return new URL(endpoint);
    }
    const basePath = base.pathname.replace(/\/+$/, '');
    const relativePath = endpoint.replace(/^\/+/, '');
    base.pathname = `${basePath}/${relativePath}`.replace(/\/{2,}/g, '/');
    base.search = '';
    base.hash = '';
    return base;
}

function rewriteRisLaunchUrlForConfiguredBase(launchUrl, baseUrl) {
    if (!launchUrl || !baseUrl) return launchUrl;
    try {
        const base = new URL(baseUrl);
        const basePath = base.pathname.replace(/\/+$/, '');
        const next = new URL(launchUrl);
        next.protocol = base.protocol;
        next.hostname = base.hostname;
        next.port = '';
        if (basePath && basePath !== '/' && !next.pathname.startsWith(`${basePath}/`) && next.pathname !== basePath) {
            next.pathname = `${basePath}/${next.pathname.replace(/^\/+/, '')}`.replace(/\/{2,}/g, '/');
        }
        return next.toString();
    } catch {
        return launchUrl;
    }
}

// RIS launches must always enter the viewer through its public gateway path.
// Keeping this independent of an editable viewer URL prevents an older local
// address (or a missing /Viewer path) from dropping the one-time launch token.
function buildGatewayViewerLaunchUrl(req, launchUrl, viewer = {}) {
    try {
        const source = new URL(launchUrl);
        const token = source.searchParams.get('launch');
        if (!token) return launchUrl;

        const origin = resolveRequestOrigin(req);
        if (!origin) return launchUrl;

        const viewerPath = getDefaultViewerPublicPath(viewer);
        const destination = new URL(`${viewerPath}/Viewer`, origin);
        destination.searchParams.set('launch', token);
        return destination.toString();
    } catch {
        return launchUrl;
    }
}

function rewriteRisLaunchUrlForDev(req, launchUrl, launchViewer) {
    const internalUrl = launchViewer?.internalBaseUrl || launchViewer?.internalUrl || '';
    if (internalUrl && /^https?:\/\//i.test(internalUrl)) {
        try {
            const internal = new URL(internalUrl);
            const next = new URL(launchUrl);
            next.protocol = internal.protocol;
            next.hostname = internal.hostname;
            next.port = internal.port || '';
            return next.toString();
        } catch {}
    }
    return launchUrl;
}

function shouldUseDirectInternalViewerLaunch(req) {
    if (String(process.env.VEXA_DIRECT_VIEWER_LAUNCH || '').toLowerCase() === 'true') {
        return true;
    }
    if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
        return false;
    }
    const host = String(req?.get?.('host') || '').toLowerCase();
    return [
        'localhost:8080',
        '127.0.0.1:8080',
        '0.0.0.0:8080',
        // Vite forwards API calls to the local backend, so the backend sees :3001
        // rather than the browser's :8080 origin in development.
        'localhost:3001',
        '127.0.0.1:3001',
        '0.0.0.0:3001',
    ].includes(host);
}

function resolveOriginAwareUrl(req, configuredBaseUrl, fallbackPath = '/') {
    const raw = String(configuredBaseUrl || '').trim().replace(/\/+$/, '');
    const origin = resolveRequestOrigin(req);
    if (!raw) {
        return origin ? `${origin}${fallbackPath.startsWith('/') ? fallbackPath : `/${fallbackPath}`}` : '';
    }
    if (/^https?:\/\//i.test(raw)) {
        return raw;
    }
    if (raw.startsWith('/')) {
        return origin ? `${origin}${raw}` : raw;
    }
    return raw;
}

function isInternalViewerBaseUrl(value) {
    if (!/^https?:\/\//i.test(String(value || ''))) return false;
    try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase();
        // Local/private viewer addresses are service-to-service endpoints, including
        // explicit ports such as 5994 and 5992. In production they must never leak
        // into the browser; resolve them through /viewer or /mobile instead. Dev
        // mode is handled separately by shouldUseDirectInternalViewerLaunch().
        return (
            host === 'localhost' ||
            host === '127.0.0.1' ||
            host === '0.0.0.0' ||
            /^192\.168\./.test(host) ||
            /^10\./.test(host) ||
            /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
        );
    } catch {
        return false;
    }
}

function getDefaultViewerPublicPath(viewer = {}) {
    const id = String(viewer?.id || '').toLowerCase();
    const name = String(viewer?.name || '').toLowerCase();
    if (id.includes('mobile') || name.includes('mobile')) return '/mobile';
    if (id.includes('ecg') || name.includes('ecg')) return '/ecg';
    return '/viewer';
}

function resolveViewerPublicBaseUrl(req, viewer = {}, fallbackBaseUrl = '') {
    const raw = String(viewer?.baseUrl || fallbackBaseUrl || '').trim().replace(/\/+$/, '');
    const fallbackPath = getDefaultViewerPublicPath(viewer);
    if (!raw || isInternalViewerBaseUrl(raw)) {
        return resolveOriginAwareUrl(req, fallbackPath, fallbackPath);
    }
    return resolveOriginAwareUrl(req, raw, fallbackPath);
}

function resolveRequestOrigin(req) {
    const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
    const forwardedHost = String(req.get('x-forwarded-host') || '').split(',')[0].trim();
    const protocol = forwardedProto || req.protocol || 'http';
    const host = forwardedHost || req.get('host');
    return host ? `${protocol}://${host}` : '';
}

/**
 * Origin APLIKASI yang sedang dipakai operator (header Origin/Referer dari browser).
 * Di dev UI (8080) dan API (3001) berbeda origin: tanpa ini link share yang dibuat
 * menunjuk ke port API (mis. http://127.0.0.1:3001/public/study/<token>) sehingga
 * dibuka di browser menjadi "Cannot GET /public/study/...". Di produksi satu origin,
 * nilainya sama dengan host request sehingga tidak mengubah perilaku.
 */
function resolveBrowserOrigin(req) {
    const candidates = [req.get('origin'), req.get('referer')];
    for (const raw of candidates) {
        const value = String(raw || '').trim();
        if (!value || value === 'null') continue;
        try {
            const parsed = new URL(value);
            if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
                return `${parsed.protocol}//${parsed.host}`;
            }
        } catch {
            // header tidak bisa diparse -> coba kandidat berikutnya
        }
    }
    return '';
}

/**
 * Origin lokal/LAN (dev: satu mesin atau satu jaringan internal). Dipakai sebagai gerbang
 * supaya penyesuaian khusus development tidak pernah aktif di produksi.
 */
function isLocalOrLanOrigin(origin) {
    try {
        const host = new URL(String(origin)).hostname.toLowerCase();
        return (
            host === 'localhost' ||
            host === '127.0.0.1' ||
            host === '::1' ||
            host === '[::1]' ||
            host.endsWith('.localhost') ||
            /^192\.168\./.test(host) ||
            /^10\./.test(host) ||
            /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
        );
    } catch {
        return false;
    }
}

function resolveInteractiveViewerBaseUrl(req, configuredBaseUrl) {
    try {
        const absoluteConfiguredBaseUrl = resolveOriginAwareUrl(req, configuredBaseUrl);
        const configured = new URL(absoluteConfiguredBaseUrl);
        const origin = resolveRequestOrigin(req);
        if (!origin) return configured.toString().replace(/\/+$/, '');
        const requestBase = new URL(origin);
        requestBase.pathname = configured.pathname || '/';
        requestBase.search = '';
        requestBase.hash = '';
        return requestBase.toString().replace(/\/+$/, '');
    } catch {
        return configuredBaseUrl;
    }
}

function ensureAppSettingsFile() {
    if (fs.existsSync(APP_SETTINGS_PATH)) {
        return;
    }
    fs.writeFileSync(
        APP_SETTINGS_PATH,
        JSON.stringify(DEFAULT_APP_LINK_SETTINGS, null, 2),
        'utf-8'
    );
}

function readAppLinkSettings() {
    ensureAppSettingsFile();
    try {
        // Node's JSON.parse rejects a leading UTF-8 BOM. The production settings
        // file is written by installer/scripts/configure-production-settings.ps1,
        // and Windows PowerShell 5.1's `Set-Content -Encoding UTF8` emits one —
        // which used to silently drop every configured setting back to defaults.
        const raw = fs.readFileSync(APP_SETTINGS_PATH, 'utf-8');
        return normalizeAppLinkSettings(JSON.parse(raw.replace(/^\uFEFF/, '')));
    } catch (err) {
        return normalizeAppLinkSettings(null);
    }
}

function buildPublicAppUrl(baseUrl, routePath, token) {
    const normalizedBase = String(baseUrl || '').replace(/\/+$/, '');
    const normalizedPath = `/${String(routePath || '').replace(/^\/+/, '').replace(/\/+$/, '')}`;
    const encodedToken = encodeURIComponent(String(token || '').trim());
    return `${normalizedBase}${normalizedPath}/${encodedToken}`;
}

function appendQueryParams(url, params = {}) {
    if (!url) return url;
    try {
        const next = new URL(url);
        for (const [key, value] of Object.entries(params)) {
            if (value === undefined || value === null || String(value).trim() === '') continue;
            next.searchParams.set(key, String(value).trim());
        }
        return next.toString();
    } catch {
        return url;
    }
}

function getOrderOutModality(order = {}) {
    return String(
        order.modality ||
        order.modality_code ||
        order.modalityCode ||
        order.ModalityCode ||
        order.modality_type ||
        ''
    ).trim().toUpperCase();
}

function isOrderOutLinkRuleAllowed(rule, order) {
    if (!rule?.enabled) return false;
    const modalityFilter = Array.isArray(rule.onlyForModalities) ? rule.onlyForModalities : [];
    if (!modalityFilter.length) return true;
    const modality = getOrderOutModality(order);
    return Boolean(modality && modalityFilter.includes(modality));
}

function findOrderOutViewerRule(appLinkSettings, viewerId, role, order = {}) {
    const requestedViewerId = String(viewerId || '').trim();
    const requestedRole = String(role || '').trim().toLowerCase().replace(/\s+/g, '_');
    const rules = appLinkSettings?.orderOutLinks || {};
    for (const rule of Object.values(rules)) {
        if (!rule || rule.type !== 'viewer' || !rule.enabled) continue;
        if (requestedViewerId && String(rule.viewerId || '').trim() !== requestedViewerId) continue;
        if (requestedRole && String(rule.role || '').trim().toLowerCase().replace(/\s+/g, '_') !== requestedRole) continue;
        if (!isOrderOutLinkRuleAllowed(rule, order)) continue;
        return rule;
    }
    return null;
}

function findOrderOutViewerRuleByKey(appLinkSettings, linkKey, order = {}) {
    const key = String(linkKey || '').trim().toLowerCase();
    if (!/^urllink[1-6]$/.test(key)) return null;
    const rule = appLinkSettings?.orderOutLinks?.[key];
    if (!rule || rule.type !== 'viewer' || !rule.enabled) return null;
    if (!isOrderOutLinkRuleAllowed(rule, order)) return null;
    return { key, rule };
}

function buildViewerTokenUrlForOrderOut(accessLink, rule, appLinkSettings, publicBaseUrl, linkKey) {
    if (!accessLink?.token) return null;
    const baseUrl = resolveViewerTokenBaseUrl(publicBaseUrl);
    const tokenPath = `${String(appLinkSettings.viewerTokenPath || '/viewer/token').replace(/\/+$/, '')}/${encodeURIComponent(String(accessLink.token))}`;
    const opaquePath = linkKey ? `${tokenPath}/${encodeURIComponent(String(linkKey))}` : tokenPath;
    return `${String(baseUrl || '').replace(/\/+$/, '')}${opaquePath.startsWith('/') ? opaquePath : `/${opaquePath}`}`;
}

function buildOrderOutLinks({ order, appLinkSettings, publicBaseUrl, viewerAccessLink, share, existing = {}, body = {} }) {
    const rules = appLinkSettings.orderOutLinks || {};
    const links = {};
    for (let index = 1; index <= 6; index += 1) {
        const key = `urllink${index}`;
        const rule = rules[key] || {};
        const bodyValue = body?.[key] || null;
        const existingValue = existing?.[key] || null;
        if (!isOrderOutLinkRuleAllowed(rule, order)) {
            links[key] = bodyValue || existingValue || null;
            continue;
        }
        if (rule.type === 'viewer') {
            links[key] =
                buildViewerTokenUrlForOrderOut(viewerAccessLink, rule, appLinkSettings, publicBaseUrl, key) ||
                bodyValue ||
                existingValue ||
                null;
            continue;
        }
        if (rule.type === 'publicStudy') {
            links[key] = share?.token
                ? buildPublicAppUrl(publicBaseUrl, appLinkSettings.publicStudyPath, share.token)
                : bodyValue || existingValue || null;
            continue;
        }
        if (rule.type === 'literal') {
            links[key] = rule.literalUrl || bodyValue || existingValue || null;
            continue;
        }
        links[key] = bodyValue || existingValue || null;
    }
    return links;
}

function resolveViewerTokenBaseUrl(fallbackBaseUrl = '') {
    const configured = String(process.env.VIEWER_TOKEN_BASE_URL || process.env.BACKEND_PUBLIC_BASE_URL || '').trim();
    if (configured) return configured.replace(/\/+$/, '');
    return String(fallbackBaseUrl || DEFAULT_APP_LINK_SETTINGS.publicBaseUrl).replace(/\/+$/, '');
}

function normalizeWhatsappNumber(rawNumber, countryCode = '62') {
    let digits = String(rawNumber || '').replace(/[^0-9]/g, '');
    const normalizedCountry = String(countryCode || '62').replace(/[^0-9]/g, '') || '62';
    if (digits.startsWith('0')) {
        digits = `${normalizedCountry}${digits.slice(1)}`;
    } else if (digits && !digits.startsWith(normalizedCountry) && digits.length <= 12) {
        digits = `${normalizedCountry}${digits}`;
    }
    return digits;
}

function buildWhatsappWebUrl(number, message) {
    const settings = readAppLinkSettings();
    const base = String(settings.whatsappBaseUrl || 'https://wa.me').replace(/\/+$/, '');
    return `${base}/${encodeURIComponent(number)}?text=${encodeURIComponent(message || '')}`;
}

function renderWhatsappCustomTemplate(value, variables) {
    if (Array.isArray(value)) return value.map(item => renderWhatsappCustomTemplate(item, variables));
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, renderWhatsappCustomTemplate(item, variables)])
        );
    }
    if (typeof value !== 'string') return value;
    return value.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(variables, key) ? String(variables[key] ?? '') : match
    );
}

function parseWhatsappCustomJsonTemplate(template, variables, label) {
    try {
        const parsed = JSON.parse(String(template || '{}'));
        const rendered = renderWhatsappCustomTemplate(parsed, variables);
        if (!rendered || typeof rendered !== 'object' || Array.isArray(rendered)) {
            throw new Error(`${label} must be a JSON object`);
        }
        return rendered;
    } catch (error) {
        const configError = new Error(`${label} is not valid JSON: ${error.message}`);
        configError.status = 500;
        throw configError;
    }
}

function readWhatsappCustomJsonPath(payload, pathValue) {
    const pathParts = String(pathValue || '').trim().split('.').map(part => part.trim()).filter(Boolean);
    let current = payload;
    for (const part of pathParts) {
        if (current === null || current === undefined || typeof current !== 'object') return undefined;
        current = current[part];
    }
    return current;
}

async function sendWhatsappMessageViaCustomProvider({ whatsapp, normalizedNumber, message, fallbackUrl }) {
    const custom = whatsapp.custom || {};
    if (!custom.endpointUrl) {
        const error = new Error('Custom WhatsApp endpoint URL is not configured');
        error.status = 500;
        error.fallbackUrl = fallbackUrl;
        throw error;
    }
    const variables = {
        number: normalizedNumber,
        message: String(message || ''),
        session: whatsapp.session || 'default',
        apiKey: whatsapp.apiKey || '',
        chatId: `${normalizedNumber}@c.us`,
        numberUrl: encodeURIComponent(normalizedNumber),
        messageUrl: encodeURIComponent(String(message || '')),
    };
    const endpoint = renderWhatsappCustomTemplate(custom.endpointUrl, variables);
    let parsedEndpoint;
    try {
        parsedEndpoint = new URL(endpoint);
    } catch {
        const error = new Error('Custom WhatsApp endpoint URL must be a complete HTTP or HTTPS URL');
        error.status = 500;
        error.fallbackUrl = fallbackUrl;
        throw error;
    }
    if (!['http:', 'https:'].includes(parsedEndpoint.protocol)) {
        const error = new Error('Custom WhatsApp endpoint only supports HTTP or HTTPS');
        error.status = 500;
        error.fallbackUrl = fallbackUrl;
        throw error;
    }
    const configuredHeaders = parseWhatsappCustomJsonTemplate(custom.headersTemplate || '{}', variables, 'Custom WhatsApp headers template');
    const headers = Object.fromEntries(
        Object.entries(configuredHeaders).map(([key, value]) => [String(key), String(value ?? '')])
    );
    const method = ['GET', 'POST', 'PUT', 'PATCH'].includes(custom.method) ? custom.method : 'POST';
    let body;
    if (method !== 'GET' && String(custom.bodyTemplate || '').trim()) {
        const bodyTemplate = String(custom.bodyTemplate).trim();
        try {
            body = JSON.stringify(renderWhatsappCustomTemplate(JSON.parse(bodyTemplate), variables));
            if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) {
                headers['Content-Type'] = 'application/json';
            }
        } catch {
            body = renderWhatsappCustomTemplate(bodyTemplate, variables);
        }
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), custom.timeoutMs || 10000);
    let response;
    try {
        response = await fetch(parsedEndpoint, { method, headers, body, signal: controller.signal });
    } catch (error) {
        const providerError = new Error(error?.name === 'AbortError' ? 'Custom WhatsApp API timed out' : error.message || 'Custom WhatsApp API is unavailable');
        providerError.status = 502;
        providerError.fallbackUrl = fallbackUrl;
        throw providerError;
    } finally {
        clearTimeout(timeout);
    }
    const responseText = await response.text().catch(() => '');
    let payload = null;
    try {
        payload = responseText ? JSON.parse(responseText) : null;
    } catch {
        payload = responseText;
    }
    let success = response.ok;
    if (success && custom.successJsonPath) {
        const actualValue = readWhatsappCustomJsonPath(payload, custom.successJsonPath);
        success = custom.successExpectedValue === ''
            ? Boolean(actualValue)
            : String(actualValue ?? '').toLowerCase() === String(custom.successExpectedValue).toLowerCase();
    }
    if (!success) {
        const error = new Error(`Custom WhatsApp API rejected the message${response.ok ? '' : ` (HTTP ${response.status})`}`);
        error.status = 502;
        error.fallbackUrl = fallbackUrl;
        error.providerResponse = payload;
        throw error;
    }
    return {
        sent: true,
        provider: 'custom',
        number: normalizedNumber,
        fallbackUrl,
        response: payload,
    };
}

async function sendWhatsappMessageViaConfiguredProvider({ number, message }) {
    const settings = readAppLinkSettings();
    const whatsapp = settings.whatsapp || {};
    const normalizedNumber = normalizeWhatsappNumber(number, whatsapp.phoneCountryCode);
    const fallbackUrl = buildWhatsappWebUrl(normalizedNumber, message);
    if (!normalizedNumber || !String(message || '').trim()) {
        const error = new Error('WhatsApp number and message are required');
        error.status = 400;
        throw error;
    }
    if (!whatsapp.enabled) {
        return {
            sent: false,
            provider: whatsapp.provider || 'web',
            fallbackUrl,
            reason: 'disabled',
        };
    }
    const provider = whatsapp.provider || 'waha';
    if (provider === 'custom' || provider === 'custom-rest' || provider === 'webhook') {
        return sendWhatsappMessageViaCustomProvider({ whatsapp, normalizedNumber, message, fallbackUrl });
    }
    if (provider !== 'waha') {
        const error = new Error(`Unsupported WhatsApp provider: ${whatsapp.provider}`);
        error.status = 400;
        error.fallbackUrl = fallbackUrl;
        throw error;
    }
    const endpoint = `${String(whatsapp.baseUrl || '').replace(/\/+$/, '')}${whatsapp.sendTextPath || '/api/sendText'}`;
    const headers = {
        'Content-Type': 'application/json',
    };
    if (whatsapp.apiKey) {
        headers['X-Api-Key'] = whatsapp.apiKey;
    }
    const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            session: whatsapp.session || 'default',
            chatId: `${normalizedNumber}@c.us`,
            text: String(message || ''),
        }),
    });
    const responseText = await response.text().catch(() => '');
    let payload = null;
    try {
        payload = responseText ? JSON.parse(responseText) : null;
    } catch (err) {
        payload = responseText;
    }
    if (!response.ok) {
        const error = new Error(
            typeof payload?.message === 'string'
                ? payload.message
                : typeof payload?.error === 'string'
                  ? payload.error
                  : `WhatsApp API returned ${response.status}`
        );
        error.status = 502;
        error.fallbackUrl = fallbackUrl;
        error.providerResponse = payload;
        throw error;
    }
    return {
        sent: true,
        provider: 'waha',
        number: normalizedNumber,
        fallbackUrl,
        response: payload,
    };
}
const ROLE_ALIASES = {
    admin: 'administrator',
    administrator: 'administrator',
    editor: 'technologist',
    technologist: 'technologist',
    fismed: 'medical_physics',
    medical: 'medical_physics',
    medical_physics: 'medical_physics',
    'medical physics': 'medical_physics',
    radiologist: 'radiologist',
    doctor: 'radiologist',
    viewer: 'clinician',
    clinician: 'clinician',
};

const normalizeUserRole = value => {
    const raw = String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
    return ROLE_ALIASES[raw] || raw || 'clinician';
};

const DEFAULT_ROLE_PERMISSIONS = {
    clinician: [
        'view_dashboard',
        'view_worklist',
        'view_quality_control',
        'view_settings',
        'view_mwl_register',
        'view_mwl_order',
        'view_mwl_status',
        'download_study',
        'qc_process',
        'change_password',
    ],
    technologist: [
        'view_dashboard',
        'view_worklist',
        'view_quality_control',
        'view_settings',
        'view_mwl_register',
        'view_mwl_order',
        'view_mwl_technologist',
        'view_mwl_status',
        'view_dose_monitor',
        'view_dose_report',
        'view_dose_idrl',
        'view_study_management',
        'view_doctor_management',
        'view_modality_management',
        'manage_study_management',
        'manage_doctor_management',
        'manage_modality_management',
        'send_mwl',
        'download_study',
        'edit_metadata',
        'qc_process',
        'change_password',
    ],
    medical_physics: [
        'view_dashboard',
        'view_management_report',
        'view_worklist',
        'view_quality_control',
        'view_settings',
        'view_dose_monitor',
        'view_dose_report',
        'view_dose_idrl',
        'view_dicom_manager',
        'download_study',
        'edit_metadata',
        'qc_process',
        'change_password',
    ],
    administrator: [
        'view_dashboard',
        'view_management_report',
        'view_worklist',
        'view_quality_control',
        'view_settings',
        'view_backup_restore',
        'view_mwl_register',
        'view_mwl_order',
        'view_mwl_technologist',
        'view_mwl_status',
        'view_study_management',
        'view_doctor_management',
        'view_modality_management',
        'view_dicom_manager',
        'manage_study_management',
        'manage_doctor_management',
        'manage_modality_management',
        'send_mwl',
        'view_users',
        'edit_metadata',
        'delete_study',
        'delete_series',
        'delete_instance',
        'restore_dicom_manager_operation',
        'download_study',
        'edit_settings',
        'restart_server',
        'manage_backup_restore',
        'manage_users',
        'manage_roles',
        'view_radiologist',
        'report_create',
        'report_edit',
        'report_finalize',
        'report_print',
        'report_export',
        'qc_process',
        'change_password',
    ],
    radiologist: [
        'view_dashboard',
        'view_radiologist',
        'report_create',
        'report_edit',
        'report_finalize',
        'report_print',
        'report_export',
        'change_password',
    ],
};

const WORKFLOW_STATUS_READ_PERMISSIONS = [
    'view_worklist',
    'view_radiologist',
    'view_quality_control',
    'view_mwl_technologist',
    'view_mwl_status',
    'view_mwl_order',
    'view_dose_monitor',
    'view_dose_report',
    'view_dose_idrl',
    'view_management_report',
    'view_dicom_manager',
];

const DEFAULT_ROLE_DOCTOR_GROUPS = {
    radiologist: 'RADIOLOGIST',
    technologist: 'TECHNOLOGIST',
    medical_physics: 'FISMED',
    clinician: 'CLINICIAN',
};

const ROLE_LANDING_PAGE_OPTIONS = [
    { path: '/dashboard', permission: 'view_dashboard' },
    { path: '/worklist', permission: 'view_worklist' },
    { path: '/distribution', permission: 'view_quality_control' },
    { path: '/reporting', permission: 'view_radiologist' },
    { path: '/mwl/register', permission: 'view_mwl_register' },
    { path: '/mwl/order', permission: 'view_mwl_order' },
    { path: '/mwl/technologist', permission: 'view_mwl_technologist' },
    { path: '/mwl/status', permission: 'view_mwl_status' },
    { path: '/mwl/management-study', permission: 'view_study_management' },
    { path: '/mwl/doctor-management', permission: 'view_doctor_management' },
    { path: '/mwl/modality-management', permission: 'view_modality_management' },
    { path: '/dose/monitor', permission: 'view_dose_monitor' },
    { path: '/dose/report', permission: 'view_dose_report' },
    { path: '/dose/idrl', permission: 'view_dose_idrl' },
    { path: '/report', permission: 'view_management_report' },
    { path: '/manager', permission: 'view_dicom_manager' },
    { path: '/settings', permission: 'view_settings' },
    { path: '/backup-restore', permission: 'view_backup_restore' },
    { path: '/users', permission: 'view_users' },
];

const DEFAULT_ROLE_LANDING_PAGES = {
    administrator: '/dashboard',
    technologist: '/mwl/technologist',
    medical_physics: '/dose/monitor',
    radiologist: '/reporting',
    clinician: '/worklist',
};

const resolveAllowedRoleLandingPage = (role, permissions, configuredLandingPage = null) => {
    const normalizedRole = normalizeUserRole(role || 'clinician');
    const allowedPermissions = new Set(Array.isArray(permissions) ? permissions : []);
    const isAllowed = path => {
        const option = ROLE_LANDING_PAGE_OPTIONS.find(item => item.path === path);
        return Boolean(option && allowedPermissions.has(option.permission));
    };
    const configured = String(configuredLandingPage || '').trim();
    if (configured && isAllowed(configured)) return configured;
    const roleDefault = DEFAULT_ROLE_LANDING_PAGES[normalizedRole];
    if (roleDefault && isAllowed(roleDefault)) return roleDefault;
    return ROLE_LANDING_PAGE_OPTIONS.find(item => allowedPermissions.has(item.permission))?.path || null;
};
const parseJsonEnv = (value, fallback) => {
    if (!value || typeof value !== 'string') return fallback;
    try {
        return JSON.parse(value);
    } catch (err) {
        return fallback;
    }
};
const parseJsonValue = (value, fallback = null) => {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch (err) {
        return fallback;
    }
};
const readJsonFile = (filePath, fallback = null) => {
    try {
        if (!filePath || !fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
    } catch (err) {
        console.warn(`Failed to read JSON defaults from ${filePath}:`, err.message);
        return fallback;
    }
};
const DEFAULT_UI_SETTINGS_ENV = parseJsonEnv(process.env.DEFAULT_UI_SETTINGS_JSON, null);
const DEFAULT_EXPERTISE_SETTINGS_FILE = process.env.DEFAULT_EXPERTISE_SETTINGS_FILE
    ? path.resolve(process.env.DEFAULT_EXPERTISE_SETTINGS_FILE)
    : path.resolve(__dirname, 'defaults', 'expertise-defaults.json');
const DEFAULT_EXPERTISE_SETTINGS_FILE_DATA = readJsonFile(DEFAULT_EXPERTISE_SETTINGS_FILE, null);
const DEFAULT_EXPERTISE_SETTINGS_ENV = parseJsonEnv(
    process.env.DEFAULT_EXPERTISE_SETTINGS_JSON,
    null
) || DEFAULT_EXPERTISE_SETTINGS_FILE_DATA;
const DEFAULT_USERS_ENV = parseJsonEnv(process.env.DEFAULT_USERS_JSON, null);
const DEFAULT_SIGNATURES_ENV = parseJsonEnv(process.env.DEFAULT_SIGNATURES_JSON, null);
const DEFAULT_ORTHANC_CONFIG_PATH = path.resolve(
    __dirname,
    '..',
    '..',
    'DcmServer',
    'Configuration',
    'orthanc.json'
);
const ORTHANC_CONFIG_PATH = process.env.ORTHANC_CONFIG_PATH
    ? path.resolve(process.env.ORTHANC_CONFIG_PATH)
    : fs.existsSync(DEFAULT_ORTHANC_CONFIG_PATH)
      ? DEFAULT_ORTHANC_CONFIG_PATH
      : path.join(__dirname, 'orthanc.json');
const DICOMWEB_SETTINGS_PATH = process.env.DICOMWEB_SETTINGS_PATH
    ? path.resolve(process.env.DICOMWEB_SETTINGS_PATH)
    : path.join(__dirname, 'dicomweb-pacs.settings.json');

const orthancIdCache = new Map();
const MAX_CACHE_ENTRIES = 2000;
const previewCache = createCache(60000, 500);
const viewerWindowCommands = new Map();
const viewerWindowSessions = new Map();

function normalizeViewerWindowSlot(slot) {
    return String(slot || 'viewer-default').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 120) || 'viewer-default';
}

function pruneViewerWindowState() {
    const now = Date.now();
    const maxAgeMs = 10 * 60 * 1000;
    for (const [slot, command] of viewerWindowCommands.entries()) {
        if (!command?.createdAt || now - command.createdAt > maxAgeMs) {
            viewerWindowCommands.delete(slot);
        }
    }
    for (const [slot, session] of viewerWindowSessions.entries()) {
        if (!session?.lastSeenAt || now - session.lastSeenAt > maxAgeMs) {
            viewerWindowSessions.delete(slot);
        }
    }
}

function getCacheKey(level, query) {
    const lower = String(level || '').toLowerCase();
    if (
        lower === 'instance' &&
        query &&
        typeof query.SOPInstanceUID === 'string' &&
        query.SOPInstanceUID
    ) {
        return `instance:${query.SOPInstanceUID}`;
    }
    if (
        lower === 'series' &&
        query &&
        typeof query.SeriesInstanceUID === 'string' &&
        query.SeriesInstanceUID
    ) {
        return `series:${query.SeriesInstanceUID}`;
    }
    if (
        lower === 'study' &&
        query &&
        typeof query.StudyInstanceUID === 'string' &&
        query.StudyInstanceUID
    ) {
        return `study:${query.StudyInstanceUID}`;
    }
    return null;
}

function getCachedIds(level, query) {
    const key = getCacheKey(level, query);
    if (!key) return null;
    const hit = orthancIdCache.get(key);
    if (!hit) return null;
    orthancIdCache.delete(key);
    orthancIdCache.set(key, hit);
    return hit;
}

function setCachedIds(level, query, ids) {
    const key = getCacheKey(level, query);
    if (!key || !Array.isArray(ids) || !ids.length) return;
    if (orthancIdCache.has(key)) {
        orthancIdCache.delete(key);
    }
    orthancIdCache.set(key, ids);
    if (orthancIdCache.size > MAX_CACHE_ENTRIES) {
        const firstKey = orthancIdCache.keys().next().value;
        if (firstKey) {
            orthancIdCache.delete(firstKey);
        }
    }
}

app.use(cors());
app.use(morgan('dev'));

// Slow-request log.
//
// morgan prints every request to the console, so by the time somebody notices "the ms
// is high" the line has scrolled away and nothing is left to inspect. Anything at or
// above RIS_SLOW_REQUEST_MS (default 250 ms) is appended to a file with the fields
// needed to see where the time went: duration, method, path, status, response size and
// the caller. Kept bounded by rotating at RIS_SLOW_REQUEST_MAX_BYTES.
const SLOW_REQUEST_MS = Math.max(Number(process.env.RIS_SLOW_REQUEST_MS || 250), 1);
const SLOW_REQUEST_MAX_BYTES = Math.max(Number(process.env.RIS_SLOW_REQUEST_MAX_BYTES || 5 * 1024 * 1024), 64 * 1024);
const SLOW_REQUEST_LOG_PATH = process.env.RIS_SLOW_REQUEST_LOG
    || path.join(PROGRAM_DATA_DIR, 'logs', 'slow-requests.log');
let slowRequestLogReady = false;
app.use((req, res, next) => {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        if (durationMs < SLOW_REQUEST_MS) return;
        const line = `${new Date().toISOString()} ${Math.round(durationMs)}ms ${req.method} ${req.originalUrl} -> ${res.statusCode} ${res.getHeader('content-length') || 0}b user=${String(req.headers['x-user-username'] || '-')}\n`;
        try {
            if (!slowRequestLogReady) {
                fs.mkdirSync(path.dirname(SLOW_REQUEST_LOG_PATH), { recursive: true });
                slowRequestLogReady = true;
            }
            const size = fs.existsSync(SLOW_REQUEST_LOG_PATH) ? fs.statSync(SLOW_REQUEST_LOG_PATH).size : 0;
            if (size > SLOW_REQUEST_MAX_BYTES) {
                fs.renameSync(SLOW_REQUEST_LOG_PATH, `${SLOW_REQUEST_LOG_PATH}.1`);
            }
            fs.appendFileSync(SLOW_REQUEST_LOG_PATH, line);
        } catch {
            /* logging must never break a request */
        }
    });
    next();
});

app.use(bodyParser.json({ limit: '10mb' }));

// The RIS API previously sent every JSON body uncompressed. The technologist
// worklist page is ~460-650 KB of mostly-repeating field names, and the page
// polls it every 30 s in the background — on the hospital LAN that is the
// dominant cost of "loading the worklist", not the SQL. Gzip shrinks this
// payload ~13x (634 KB -> 46 KB). Do not remove: without it the auto-refresh
// stalls the page whenever several stations are open at once.
// Brotli is accepted by every browser the RIS supports and compresses these
// repetitive JSON rows ~20-25% smaller than gzip. Fall back to gzip for older
// clients. The compressed bodies are memoised per (encoding, body) pair because
// the worklist auto-refreshes every 30 s with byte-identical payloads between
// changes, and zlib was previously run on every single response.
const encodedBodyCache = new Map();
const MAX_ENCODED_CACHE_BYTES = 64 * 1024 * 1024;
let encodedBodyCacheBytes = 0;
const ENCODED_CACHE_MAX_ENTRIES = 120;

function rememberEncodedBody(key, buffer) {
    if (encodedBodyCacheBytes + buffer.length > MAX_ENCODED_CACHE_BYTES) return;
    encodedBodyCache.set(key, buffer);
    encodedBodyCacheBytes += buffer.length;
    while (encodedBodyCache.size > ENCODED_CACHE_MAX_ENTRIES) {
        const oldestKey = encodedBodyCache.keys().next().value;
        const dropped = encodedBodyCache.get(oldestKey);
        encodedBodyCacheBytes -= dropped ? dropped.length : 0;
        encodedBodyCache.delete(oldestKey);
    }
}

function compressPayload(payload, encoding) {
    if (encoding === 'br' && typeof zlib.brotliCompressSync === 'function') {
        return zlib.brotliCompressSync(payload, {
            params: {
                [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
                [zlib.constants.BROTLI_PARAM_SIZE_HINT]: payload.length,
            },
        });
    }
    return zlib.gzipSync(payload, { level: 6 });
}

app.use((req, res, next) => {
    const acceptEncoding = String(req.headers['accept-encoding'] || '');
    const useBrotli = /\bbr\b/.test(acceptEncoding);
    const useGzip = /\bgzip\b/.test(acceptEncoding);
    if (!useBrotli && !useGzip) return next();
    const encoding = useBrotli ? 'br' : 'gzip';
    const bodyKey = (body) => {
        const serialized = JSON.stringify(body);
        return `${encoding}:${serialized.length}:${serialized}`;
    };
    const originalJson = res.json.bind(res);
    res.json = (body) => {
        if (res.headersSent || res.getHeader('Content-Encoding')) return originalJson(body);
        let serialized;
        try {
            serialized = JSON.stringify(body);
        } catch {
            return originalJson(body);
        }
        if (serialized.length < 1024) return originalJson(body);

        const cacheKey = `${encoding}:${serialized.length}:${serialized}`;
        let compressed = encodedBodyCache.get(cacheKey);
        if (!compressed) {
            try {
                compressed = compressPayload(Buffer.from(serialized, 'utf8'), encoding);
            } catch (error) {
                return originalJson(body);
            }
            rememberEncodedBody(cacheKey, compressed);
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Encoding', encoding);
        res.setHeader('Vary', 'Accept-Encoding');
        res.setHeader('Content-Length', compressed.length);
        res.end(compressed);
        return res;
    };
    next();
});

function loadDefaultDoseIdrlRecords() {
    const candidates = [
        path.resolve(__dirname, '..', 'src', 'pages', 'dose', 'doseMock.ts'),
        path.resolve(__dirname, 'src', 'pages', 'dose', 'doseMock.ts'),
    ];
    for (const candidate of candidates) {
        try {
            if (!fs.existsSync(candidate)) continue;
            const source = fs.readFileSync(candidate, 'utf8');
            const match = source.match(/export const defaultIdrlRecords: IdrlRecord\[] = (\[[\s\S]*?\]);/);
            if (!match) continue;
            const records = Function(`"use strict"; return (${match[1]});`)();
            return Array.isArray(records) ? records : [];
        } catch (err) {
            console.warn('Failed to load default IDRL records:', err.message);
        }
    }
    return [];
}

async function seedDefaultDoseIdrlRecords(connection) {
    const records = loadDefaultDoseIdrlRecords();
    if (!records.length) return;
    let inserted = 0;
    for (const record of records) {
        const id = String(record.id || '').trim();
        const modalityCode = normalizeModality(record.modalityCode).toUpperCase();
        const exam = String(record.exam || '').trim();
        const metric = String(record.metric || '').trim();
        const limit = String(record.limit || '').trim();
        if (!id || !modalityCode || !exam || !metric || !limit) continue;
        const [result] = await connection.query(
            `
            INSERT IGNORE INTO dose_idrl (id, modality_code, exam, metric, dose_limit, unit, body_region, reference_text, effective_date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
                id,
                modalityCode,
                exam,
                metric,
                limit,
                record.unit || null,
                record.bodyRegion || null,
                record.reference || null,
                record.effectiveDate || null,
            ]
        );
        inserted += result.affectedRows || 0;
    }
    if (inserted > 0) {
        console.log(`Default IDRL/TPDI records seeded: ${inserted}`);
    }
}

// Test connection & Initial Setup
(async () => {
    try {
        const connection = await pool.getConnection();
        console.log('Connected to PostgreSQL database.');

        // Create users table
        await connection.query(`
          CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(50) NOT NULL UNIQUE,
            password VARCHAR(255) NOT NULL,
            name VARCHAR(100),
            phone_number VARCHAR(32) NULL,
            usernamepacs VARCHAR(100) NULL,
            passwordpacs VARCHAR(1024) NULL,
            role VARCHAR(20) DEFAULT 'viewer',
            theme VARCHAR(10) DEFAULT 'light',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);
        try {
            await connection.query(
                'ALTER TABLE users ADD COLUMN theme VARCHAR(10) DEFAULT "light"'
            );
        } catch (err) {
            if (!String(err.message || '').includes('Duplicate column')) {
                console.error('Error updating users table:', err.message);
            }
        }
        try {
            await connection.query(
                'ALTER TABLE users ADD COLUMN preferences TEXT NULL'
            );
        } catch (err) {
            if (!String(err.message || '').includes('Duplicate column')) {
                console.error('Error adding preferences column:', err.message);
            }
        }
        try {
            await connection.query(
                'ALTER TABLE users ADD COLUMN phone_number VARCHAR(32) NULL AFTER name'
            );
        } catch (err) {
            if (!String(err.message || '').includes('Duplicate column')) {
                console.error('Error updating users table:', err.message);
            }
        }
        try {
            await connection.query(
                'ALTER TABLE users ADD COLUMN usernamepacs VARCHAR(100) NULL AFTER phone_number'
            );
        } catch (err) {
            if (!String(err.message || '').includes('Duplicate column')) {
                console.error('Error updating users table:', err.message);
            }
        }
        try {
            await connection.query(
                'ALTER TABLE users ADD COLUMN passwordpacs VARCHAR(1024) NULL AFTER usernamepacs'
            );
        } catch (err) {
            if (!String(err.message || '').includes('Duplicate column')) {
                console.error('Error updating users table:', err.message);
            }
        }
        try {
            await connection.query('ALTER TABLE users MODIFY COLUMN passwordpacs VARCHAR(1024) NULL');
        } catch (err) {}
        try {
            await connection.query(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255) NULL UNIQUE AFTER passwordpacs"
            );
        } catch (err) {
            if (!String(err.message || '').includes('Duplicate column')) {
                console.error('Error updating users table:', err.message);
            }
        }
        try {
            await connection.query(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255) NULL AFTER google_id"
            );
        } catch (err) {
            if (!String(err.message || '').includes('Duplicate column')) {
                console.error('Error updating users table:', err.message);
            }
        }

        await connection.query(`
          CREATE TABLE IF NOT EXISTS ui_settings (
            id INT PRIMARY KEY,
            viewer_url VARCHAR(255) NOT NULL,
            viewer_path VARCHAR(255) NOT NULL,
            auto_refresh TINYINT(1) NOT NULL,
            worklist_series_preview_enabled TINYINT(1) NOT NULL DEFAULT 1,
            radiologist_competition_enabled TINYINT(1) NOT NULL DEFAULT 0,
            patient_portal_max_images_per_series INT NOT NULL DEFAULT 100,
            radiologist_whatsapp_auto TINYINT(1) NOT NULL DEFAULT 0,
            radiologist_whatsapp_template TEXT NULL,
            viewer_config TEXT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS radiologist_whatsapp_notifications (
            id INT AUTO_INCREMENT PRIMARY KEY,
            order_id INT NOT NULL,
            study_instance_uid VARCHAR(128) NULL,
            accession_number VARCHAR(64) NULL,
            radiologist_doctor_code VARCHAR(64) NULL,
            phone_number VARCHAR(32) NULL,
            sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            provider VARCHAR(32) NULL,
            status VARCHAR(32) NULL,
            error_message TEXT NULL,
            UNIQUE KEY uq_radiologist_whatsapp_order (order_id)
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS role_permissions (
            role VARCHAR(50) NOT NULL,
            permission VARCHAR(100) NOT NULL,
            PRIMARY KEY (role, permission)
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS role_doctor_groups (
            role VARCHAR(50) NOT NULL PRIMARY KEY,
            doctor_group VARCHAR(50) NULL
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS role_settings (
            role VARCHAR(50) NOT NULL PRIMARY KEY,
            default_landing_page VARCHAR(128) NOT NULL
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS dicom_nodes (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            aet VARCHAR(64) NOT NULL,
            host VARCHAR(255) NOT NULL,
            port INT NOT NULL,
            description VARCHAR(255),
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS dicom_routing_schedules (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(120) NOT NULL,
            node_id INT NOT NULL,
            enabled TINYINT(1) NOT NULL DEFAULT 1,
            recurrence VARCHAR(16) NOT NULL DEFAULT 'daily',
            run_time VARCHAR(5) NOT NULL DEFAULT '01:00',
            source_date_mode VARCHAR(24) NOT NULL DEFAULT 'previous_day',
            source_date DATE NULL,
            modality VARCHAR(32) NULL,
            max_retries INT NOT NULL DEFAULT 3,
            next_run_at DATETIME NOT NULL,
            last_run_at DATETIME NULL,
            created_by VARCHAR(100) NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_routing_schedule_due (enabled, next_run_at),
            INDEX idx_routing_schedule_node (node_id)
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS dicom_routing_jobs (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            schedule_id INT NOT NULL,
            node_id INT NOT NULL,
            study_instance_uid VARCHAR(128) NOT NULL,
            study_date VARCHAR(8) NULL,
            modality VARCHAR(32) NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'queued',
            attempts INT NOT NULL DEFAULT 0,
            max_retries INT NOT NULL DEFAULT 3,
            next_attempt_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            started_at DATETIME NULL,
            completed_at DATETIME NULL,
            last_error TEXT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_routing_study_destination (schedule_id, node_id, study_instance_uid),
            INDEX idx_routing_job_queue (status, next_attempt_at),
            INDEX idx_routing_job_schedule (schedule_id)
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS audit_logs (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            event_type VARCHAR(64) NOT NULL,
            outcome VARCHAR(16) NOT NULL DEFAULT 'success',
            username VARCHAR(100) NULL,
            role VARCHAR(50) NULL,
            ip_address VARCHAR(64) NULL,
            user_agent VARCHAR(255) NULL,
            study_instance_uid VARCHAR(128) NULL,
            series_instance_uid VARCHAR(128) NULL,
            sop_instance_uid VARCHAR(128) NULL,
            target_type VARCHAR(64) NULL,
            target_id VARCHAR(255) NULL,
            details_json JSON NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_audit_created_at (created_at),
            INDEX idx_audit_event_type (event_type),
            INDEX idx_audit_study (study_instance_uid),
            INDEX idx_audit_username (username)
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS radiology_reports (
            id INT AUTO_INCREMENT PRIMARY KEY,
            study_instance_uid VARCHAR(128) NOT NULL UNIQUE,
            patient_id VARCHAR(64),
            radiologist_id INT,
            clinical_info TEXT,
            findings MEDIUMTEXT,
            conclusion MEDIUMTEXT,
            kritis VARCHAR(1) NOT NULL DEFAULT '0',
            status VARCHAR(16) DEFAULT 'draft',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            finalized_at TIMESTAMP NULL DEFAULT NULL,
            INDEX (study_instance_uid)
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS radiology_report_revisions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            report_id INT,
            study_instance_uid VARCHAR(128) NOT NULL,
            patient_id VARCHAR(64),
            radiologist_id INT,
            clinical_info TEXT,
            findings MEDIUMTEXT,
            conclusion MEDIUMTEXT,
            kritis VARCHAR(1) NOT NULL DEFAULT '0',
            status VARCHAR(16),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            finalized_at TIMESTAMP NULL DEFAULT NULL,
            INDEX (study_instance_uid),
            INDEX (report_id)
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS radiologist_templates (
            id INT AUTO_INCREMENT PRIMARY KEY,
            radiologist_id INT NOT NULL,
            title VARCHAR(150) NOT NULL,
            findings MEDIUMTEXT,
            conclusion MEDIUMTEXT,
            modality_code VARCHAR(64) NULL,
            procedure_code VARCHAR(128) NULL,
            procedure_description VARCHAR(255) NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX (radiologist_id),
            INDEX idx_radiologist_templates_context (radiologist_id, modality_code, procedure_code)
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS expertise_settings (
            id INT PRIMARY KEY,
            header_image MEDIUMTEXT,
            template_html MEDIUMTEXT,
            qr_position VARCHAR(16) NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS expertise_print_templates (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(150) NOT NULL,
            header_image MEDIUMTEXT,
            template_html MEDIUMTEXT,
            is_active TINYINT(1) NOT NULL DEFAULT 1,
            is_default TINYINT(1) NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX (is_active),
            INDEX (is_default)
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS radiologist_signatures (
            user_id INT PRIMARY KEY,
            signature_image MEDIUMTEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS quality_control_status (
            study_instance_uid VARCHAR(128) PRIMARY KEY,
            processed_by VARCHAR(100),
            processed_at TIMESTAMP NULL DEFAULT NULL
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS radiologist_assignments (
            study_instance_uid VARCHAR(128) PRIMARY KEY,
            radiologist_id INT,
            assigned_by VARCHAR(100),
            assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX (radiologist_id)
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS patients (
            id INT AUTO_INCREMENT PRIMARY KEY,
            no_rm VARCHAR(255) NOT NULL UNIQUE,
            nama_pasien VARCHAR(255) NOT NULL,
            tanggal_lahir DATE NOT NULL,
            kelamin VARCHAR(1) NOT NULL,
            alamat VARCHAR(150) NULL,
            kecamatan VARCHAR(150) NULL,
            kabupaten VARCHAR(150) NULL,
            provinsi VARCHAR(150) NULL,
            kode_pos VARCHAR(7) NULL,
            no_hp VARCHAR(20) NULL,
            waktu_update_pasien DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            update_simrs VARCHAR(1) NOT NULL DEFAULT 'N',
            INDEX idx_patients_name (nama_pasien),
            INDEX idx_patients_norm (no_rm)
          )
        `);
        await ensurePatientTableSchema(connection);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS mwl_orders (
            id INT AUTO_INCREMENT PRIMARY KEY,
            patient_record_id INT NOT NULL,
            accession_number VARCHAR(64) NOT NULL UNIQUE,
            study_instance_uid VARCHAR(128) NOT NULL UNIQUE,
            study_date DATE NULL,
            study_time TIME NULL,
            modality VARCHAR(16) NOT NULL,
            cito VARCHAR(1) NULL,
            polirawat VARCHAR(15) NULL,
            kode_ruangan VARCHAR(12) NULL,
            nama_ruangan VARCHAR(50) NULL,
            procedure_code VARCHAR(64) NULL,
            procedure_desc VARCHAR(255) NOT NULL,
            kode_pemeriksaan VARCHAR(12) NULL,
            nama_pemeriksaan VARCHAR(50) NULL,
            kode_dokter VARCHAR(12) NULL,
            nama_dokter VARCHAR(255) NULL,
            kode_admin VARCHAR(12) NULL,
            nama_admin VARCHAR(255) NULL,
            kode_dokter_radiolog VARCHAR(12) NULL,
            nama_radiolog VARCHAR(255) NULL,
            kode_radiografer VARCHAR(12) NULL,
            nama_radiografer VARCHAR(100) NULL,
            radiografer_datetime_start DATETIME NULL,
            radiografer_datetime_end DATETIME NULL,
            cara_bayar VARCHAR(10) NULL,
            kode_asuransi VARCHAR(12) NULL,
            nama_asuransi VARCHAR(255) NULL,
            kode_instalasi_radiologi VARCHAR(12) NULL,
            nama_instalasi_radiologi VARCHAR(50) NULL,
            referring_physician VARCHAR(255) NULL,
            assigned_staff_json JSON NULL,
            modality_station_ae VARCHAR(64) NULL,
            modality_station_room VARCHAR(150) NULL,
            status ENUM('PENDING','SENT_TO_MWL','COMPLETED','CANCELLED') NOT NULL DEFAULT 'PENDING',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_mwl_orders_status (status),
            INDEX idx_mwl_orders_patient (patient_record_id),
            CONSTRAINT fk_mwl_orders_patient FOREIGN KEY (patient_record_id) REFERENCES patients(id) ON DELETE CASCADE
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS mwl_studies (
            id INT AUTO_INCREMENT PRIMARY KEY,
            procedure_code VARCHAR(64) NOT NULL,
            modality_code VARCHAR(16) NOT NULL,
            study_description VARCHAR(255) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_mwl_studies_desc_modality (study_description, modality_code),
            INDEX idx_mwl_studies_desc (study_description),
            INDEX idx_mwl_studies_proc (procedure_code)
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS mwl_doctors (
            id INT AUTO_INCREMENT PRIMARY KEY,
            kode_dokter VARCHAR(64) NOT NULL UNIQUE,
            nama_dokter VARCHAR(255) NOT NULL,
            role VARCHAR(16) NOT NULL,
            user_id INT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_mwl_doctors_user (user_id),
            INDEX idx_mwl_doctors_role (role),
            INDEX idx_mwl_doctors_name (nama_dokter)
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS mwl_modalities (
            id INT AUTO_INCREMENT PRIMARY KEY,
            nama_ruangan VARCHAR(150) NOT NULL,
            ae_title_station VARCHAR(64) NULL UNIQUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_mwl_modalities_room (nama_ruangan),
            INDEX idx_mwl_modalities_room (nama_ruangan)
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS dose_report (
            id VARCHAR(64) PRIMARY KEY,
            mwl_order_id INT NULL,
            patient_id VARCHAR(64) NULL,
            patient_name VARCHAR(255) NULL,
            accession_number VARCHAR(64) NULL,
            modality_code VARCHAR(16) NOT NULL,
            study_description VARCHAR(255) NULL,
            study_date VARCHAR(16) NULL,
            study_time VARCHAR(32) NULL,
            sex VARCHAR(4) NULL,
            birth_date VARCHAR(16) NULL,
            cito TINYINT(1) NOT NULL DEFAULT 0,
            radiologist VARCHAR(255) NULL,
            technologist VARCHAR(255) NULL,
            medical_physicist VARCHAR(255) NULL,
            room VARCHAR(150) NULL,
            ae_title VARCHAR(64) NULL,
            study_instance_uid VARCHAR(128) NULL,
            capture_mode VARCHAR(16) NOT NULL DEFAULT 'manual',
            values_json JSON NULL,
            saved_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_dose_report_mwl_order (mwl_order_id),
            INDEX idx_dose_report_modality_date (modality_code, study_date),
            INDEX idx_dose_report_study_uid (study_instance_uid),
            INDEX idx_dose_report_saved_at (saved_at)
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS dose_idrl (
            id VARCHAR(128) PRIMARY KEY,
            modality_code VARCHAR(16) NOT NULL,
            exam VARCHAR(255) NOT NULL,
            metric VARCHAR(80) NOT NULL,
            dose_limit VARCHAR(80) NOT NULL,
            unit VARCHAR(80) NULL,
            body_region VARCHAR(150) NULL,
            reference_text VARCHAR(255) NULL,
            effective_date VARCHAR(32) NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_dose_idrl_modality_exam (modality_code, exam)
          )
        `);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS dose_idrl_study_links (
            id VARCHAR(255) PRIMARY KEY,
            modality_code VARCHAR(16) NOT NULL,
            idrl_exam VARCHAR(255) NOT NULL,
            study_master_id INT NOT NULL,
            procedure_code VARCHAR(64) NULL,
            study_description VARCHAR(255) NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_dose_idrl_study_link (modality_code, idrl_exam, study_master_id),
            INDEX idx_dose_idrl_study_group (modality_code, idrl_exam)
          )
        `);
        await seedDefaultDoseIdrlRecords(connection);
        try {
            await connection.query(
                'ALTER TABLE dose_report ADD COLUMN IF NOT EXISTS medical_physicist VARCHAR(255) NULL AFTER technologist'
            );
        } catch (err) {}
        try {
            await connection.query(
                'ALTER TABLE dose_report ADD INDEX IF NOT EXISTS idx_dose_report_saved_at (saved_at)'
            );
        } catch (err) {}
        try {
            await connection.query(
                'ALTER TABLE mwl_doctors ADD COLUMN IF NOT EXISTS user_id INT NULL AFTER role'
            );
        } catch (err) {}
        try {
            await connection.query(
                'ALTER TABLE mwl_doctors ADD UNIQUE INDEX IF NOT EXISTS uq_mwl_doctors_user (user_id)'
            );
        } catch (err) {}
        try {
            await connection.query(
                'ALTER TABLE mwl_doctors ADD CONSTRAINT fk_mwl_doctors_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL'
            );
        } catch (err) {}
        try {
            await connection.query(
                'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS study_instance_uid VARCHAR(128) NOT NULL UNIQUE AFTER accession_number'
            );
        } catch (err) {}
        await applyMwlOrderIndonesiaSchema(connection);
        await ensureOrderInTable();
        await dicomwebPacs.ensureStateTables(connection);
        await connection.query(`
          CREATE TABLE IF NOT EXISTS mwl_logs (
            id INT AUTO_INCREMENT PRIMARY KEY,
            order_id INT NOT NULL,
            orthanc_file_name VARCHAR(255) NULL,
            transport_method VARCHAR(32) NULL,
            orthanc_status VARCHAR(32) NOT NULL DEFAULT 'SENT_TO_ORTHANC',
            is_active TINYINT(1) NOT NULL DEFAULT 1,
            message TEXT NULL,
            sync_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_mwl_logs_order (order_id),
            INDEX idx_mwl_logs_active (is_active),
            CONSTRAINT fk_mwl_logs_order FOREIGN KEY (order_id) REFERENCES mwl_orders(id) ON DELETE CASCADE
          )
        `);

        // Check for default admin
        const [rows] = await connection.query('SELECT * FROM users WHERE username = "admin"');
        if (rows.length === 0) {
            const defaultPacsPassword = encryptPacsCredential('admin123');
            await connection.query(
                `INSERT INTO users
                    (username, password, name, usernamepacs, passwordpacs, role)
                 VALUES ("admin", "admin123", "Administrator", "admin", ?, "administrator")`,
                [defaultPacsPassword]
            );
            console.log('Default rescue administrator created with PACS viewer access.');
        } else {
            const adminUpdates = [];
            const adminParams = [];
            if (normalizeUserRole(rows[0].role) !== 'administrator') {
                adminUpdates.push('role = ?');
                adminParams.push('administrator');
            }
            // Only repair empty bootstrap credentials. Never overwrite credentials
            // explicitly configured by an administrator after installation.
            if (!normalizeNullableString(rows[0].usernamepacs, 100)) {
                adminUpdates.push('usernamepacs = ?');
                adminParams.push('admin');
            }
            if (!normalizeNullableString(rows[0].passwordpacs, 2048)) {
                adminUpdates.push('passwordpacs = ?');
                adminParams.push(encryptPacsCredential('admin123'));
            }
            if (adminUpdates.length) {
                await connection.query(
                    `UPDATE users SET ${adminUpdates.join(', ')} WHERE username = "admin"`,
                    adminParams
                );
                console.log('Default rescue administrator viewer access repaired.');
            }
        }
        const defaultUsers = Array.isArray(DEFAULT_USERS_ENV) ? DEFAULT_USERS_ENV : [];
        for (const user of defaultUsers) {
            if (!user || typeof user !== 'object') continue;
            const username = typeof user.username === 'string' ? user.username.trim() : '';
            const password = typeof user.password === 'string' ? user.password : '';
            if (!username || !password) continue;
            const [existing] = await connection.query(
                'SELECT id FROM users WHERE username = ?',
                [username]
            );
            if (existing.length) continue;
            const name = typeof user.name === 'string' ? user.name : null;
            const role = normalizeUserRole(user.role || 'clinician');
            const theme = typeof user.theme === 'string' ? user.theme : 'light';
            await connection.query(
                'INSERT INTO users (username, password, name, role, theme) VALUES (?, ?, ?, ?, ?)',
                [username, password, name, role, theme]
            );
        }

        const [roleRows] = await connection.query('SELECT id, role FROM users');
        for (const row of roleRows) {
            const normalizedRole = normalizeUserRole(row.role);
            if (normalizedRole !== row.role) {
                await connection.query('UPDATE users SET role = ? WHERE id = ?', [normalizedRole, row.id]);
            }
        }

        try {
            await backfillOrderInFromMwl();
        } catch (err) {
            console.warn('Failed to backfill order_in:', err.message);
        }

        const [uiRows] = await connection.query('SELECT id FROM ui_settings WHERE id = 1');
        if (uiRows.length === 0) {
            const normalized = normalizeUiSettings(
                DEFAULT_UI_SETTINGS_ENV || DEFAULT_UI_SETTINGS
            );
            const viewerConfigJson = JSON.stringify(normalized.viewers || []);
            try {
                await connection.query(
                    'INSERT INTO ui_settings (id, viewer_url, viewer_path, auto_refresh, worklist_series_preview_enabled, radiologist_competition_enabled, viewer_access_link_days, patient_portal_max_images_per_series, radiologist_whatsapp_auto, radiologist_whatsapp_scope, radiologist_whatsapp_template, viewer_config) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [
                        normalized.viewerUrl,
                        normalized.viewerPath,
                        normalized.autoRefresh ? 1 : 0,
                        normalized.worklistSeriesPreviewEnabled ? 1 : 0,
                        normalized.radiologistCompetitionEnabled ? 1 : 0,
                        normalized.viewerAccessLinkDays,
                        normalized.patientPortalMaxImagesPerSeries,
                        normalized.radiologistWhatsappNotification.mode === 'auto' ? 1 : 0,
                        normalized.radiologistWhatsappNotification.scope,
                        normalized.radiologistWhatsappNotification.messageTemplate,
                        viewerConfigJson,
                    ]
                );
            } catch (err) {
                await connection.query(
                    'INSERT INTO ui_settings (id, viewer_url, viewer_path, auto_refresh, radiologist_competition_enabled) VALUES (1, ?, ?, ?, ?)',
                    [
                        normalized.viewerUrl,
                        normalized.viewerPath,
                        normalized.autoRefresh ? 1 : 0,
                        normalized.radiologistCompetitionEnabled ? 1 : 0,
                    ]
                );
            }
        }
        const [expertRows] = await connection.query('SELECT id FROM expertise_settings WHERE id = 1');
        if (expertRows.length === 0) {
            const defaultsRoot =
                DEFAULT_EXPERTISE_SETTINGS_ENV &&
                typeof DEFAULT_EXPERTISE_SETTINGS_ENV === 'object'
                    ? DEFAULT_EXPERTISE_SETTINGS_ENV
                    : {};
            const defaults =
                defaultsRoot.expertise && typeof defaultsRoot.expertise === 'object'
                    ? defaultsRoot.expertise
                    : defaultsRoot;
            const headerImage =
                typeof defaults.headerImage === 'string' ? defaults.headerImage : null;
            const templateHtml =
                typeof defaults.templateHtml === 'string' ? defaults.templateHtml : null;
            const qrPositionRaw =
                typeof defaults.qrPosition === 'string' ? defaults.qrPosition : null;
            const qrPosition =
                qrPositionRaw === 'left' || qrPositionRaw === 'center' || qrPositionRaw === 'right'
                    ? qrPositionRaw
                    : null;
            try {
                await connection.query(
                    'INSERT INTO expertise_settings (id, header_image, template_html, qr_position) VALUES (1, ?, ?, ?)',
                    [headerImage, templateHtml, qrPosition]
                );
            } catch (err) {
                await connection.query(
                    'INSERT INTO expertise_settings (id, header_image, template_html) VALUES (1, ?, ?)',
                    [headerImage, templateHtml]
                );
            }
        }
        const signatureDefaults = Array.isArray(DEFAULT_SIGNATURES_ENV)
            ? DEFAULT_SIGNATURES_ENV
            : [];
        for (const entry of signatureDefaults) {
            if (!entry || typeof entry !== 'object') continue;
            const username = typeof entry.username === 'string' ? entry.username.trim() : '';
            const signatureImage =
                typeof entry.signatureImage === 'string' ? entry.signatureImage : '';
            if (!username || !signatureImage) continue;
            const [userRows] = await connection.query(
                'SELECT id FROM users WHERE username = ?',
                [username]
            );
            if (!userRows.length) continue;
            const userId = userRows[0].id;
            const [sigRows] = await connection.query(
                'SELECT user_id FROM radiologist_signatures WHERE user_id = ?',
                [userId]
            );
            if (sigRows.length) continue;
            await connection.query(
                'INSERT INTO radiologist_signatures (user_id, signature_image) VALUES (?, ?)',
                [userId, signatureImage]
            );
        }

        for (const [role, permissions] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
            const [existingPermissionRows] = await connection.query(
                'SELECT COUNT(*) AS total FROM role_permissions WHERE role = ?',
                [role]
            );
            const hasConfiguredPermissions = Number(existingPermissionRows?.[0]?.total || 0) > 0;
            if (hasConfiguredPermissions) continue;
            const inserts = permissions.map(permission => [role, permission]);
            if (inserts.length) {
                await connection.query(
                    'INSERT IGNORE INTO role_permissions (role, permission) VALUES ?',
                    [inserts]
                );
            }
        }
        await connection.query(
            'DELETE FROM role_permissions WHERE role = ? AND permission = ?',
            ['radiologist', 'view_settings']
        );
        await connection.query(
            'DELETE FROM role_permissions WHERE role = ? AND permission = ?',
            ['clinician', 'view_backup_restore']
        );
        await connection.query(
            'INSERT IGNORE INTO role_permissions (role, permission) VALUES ?',
            [[
                ['administrator', 'view_backup_restore'],
                ['administrator', 'manage_backup_restore'],
                ['administrator', 'restore_dicom_manager_operation'],
            ]]
        );
        const roleGroupInserts = Object.entries(DEFAULT_ROLE_DOCTOR_GROUPS).map(([role, doctorGroup]) => [
            role,
            doctorGroup,
        ]);
        if (roleGroupInserts.length) {
            await connection.query(
                'INSERT IGNORE INTO role_doctor_groups (role, doctor_group) VALUES ?',
                [roleGroupInserts]
            );
        }
        const roleLandingPageInserts = Object.entries(DEFAULT_ROLE_LANDING_PAGES).map(([role, defaultLandingPage]) => [
            role,
            defaultLandingPage,
        ]);
        if (roleLandingPageInserts.length) {
            await connection.query(
                'INSERT IGNORE INTO role_settings (role, default_landing_page) VALUES ?',
                [roleLandingPageInserts]
            );
        }
        await connection.query(
            'DELETE FROM role_permissions WHERE role IN ("admin", "viewer", "editor")'
        );
        await connection.query(
            'DELETE FROM role_doctor_groups WHERE role IN ("admin", "viewer", "editor")'
        );
        await connection.query(
            'DELETE FROM role_settings WHERE role IN ("admin", "viewer", "editor")'
        );

        connection.release();
    } catch (err) {
        console.error('Error connecting to PostgreSQL:', err.message);
    }
})();

const getRoleFromRequest = req => {
    const headerValue = req?.headers?.['x-user-role'];
    const role = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (!role || typeof role !== 'string') return null;
    return normalizeUserRole(role);
};

const getUsernameFromRequest = req => {
    const headerValue = req?.headers?.['x-user-username'];
    const username = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (!username || typeof username !== 'string') return null;
    return username.slice(0, 100);
};

const normalizeNullableString = (value, maxLength = 255) => {
    if (value === undefined || value === null) return null;
    const normalized = String(value).trim();
    return normalized ? normalized.slice(0, maxLength) : null;
};

const getPacsCredentialKey = () => {
    const keySeed =
        process.env.PACS_CREDENTIAL_SECRET ||
        process.env.SIMRS_API_KEY ||
        process.env.JWT_SECRET ||
        'nexia-local-pacs-credential-secret';
    return crypto.createHash('sha256').update(String(keySeed)).digest();
};

const encryptPacsCredential = value => {
    const secret = normalizeNullableString(value, 512);
    if (!secret) return null;
    const key = getPacsCredentialKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
};

const decryptPacsCredential = value => {
    const stored = normalizeNullableString(value, 2048);
    if (!stored) return null;
    if (!stored.startsWith('enc:v1:')) return stored;
    const [, version, ivValue, tagValue, encryptedValue] = stored.split(':');
    if (version !== 'v1' || !ivValue || !tagValue || !encryptedValue) {
        throw new Error('PACS viewer credential format is invalid. Save the PACS password again in User Management.');
    }
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', getPacsCredentialKey(), Buffer.from(ivValue, 'base64'));
        decipher.setAuthTag(Buffer.from(tagValue, 'base64'));
        return Buffer.concat([
            decipher.update(Buffer.from(encryptedValue, 'base64')),
            decipher.final(),
        ]).toString('utf8');
    } catch {
        throw new Error('PACS viewer credential cannot be decrypted. Save the PACS password again in User Management.');
    }
};

const rolePermissionCache = new Map();
const roleDoctorGroupCache = new Map();
const roleLandingPageCache = new Map();
const ROLE_PERMISSION_TTL_MS = 30000;

function getRolePermissions(role) {
    const normalizedRole = normalizeUserRole(role || 'clinician');
    const cached = rolePermissionCache.get(normalizedRole);
    if (cached && cached.expiresAt > Date.now()) {
        return Promise.resolve(cached.permissions);
    }
    return pool
        .query('SELECT permission FROM role_permissions WHERE role = ?', [normalizedRole])
        .then(([rows]) => {
            const storedPermissions = rows.map(row => row.permission);
            const permissions = storedPermissions.length
                ? storedPermissions
                : (DEFAULT_ROLE_PERMISSIONS[normalizedRole] || []);
            rolePermissionCache.set(normalizedRole, {
                permissions,
                expiresAt: Date.now() + ROLE_PERMISSION_TTL_MS,
            });
            return permissions;
        });
}

function getRoleDoctorGroup(role) {
    role = normalizeUserRole(role || 'clinician');
    const cached = roleDoctorGroupCache.get(role);
    if (cached && cached.expiresAt > Date.now()) {
        return Promise.resolve(cached.doctorGroup);
    }
    return pool
        .query('SELECT doctor_group FROM role_doctor_groups WHERE role = ? LIMIT 1', [role])
        .then(([rows]) => {
            const doctorGroup = rows?.[0]?.doctor_group ? String(rows[0].doctor_group).trim().toUpperCase() : null;
            roleDoctorGroupCache.set(role, {
                doctorGroup,
                expiresAt: Date.now() + ROLE_PERMISSION_TTL_MS,
            });
            return doctorGroup;
        });
}

function getRoleLandingPage(role, permissions = null) {
    role = normalizeUserRole(role || 'clinician');
    const cached = roleLandingPageCache.get(role);
    if (cached && cached.expiresAt > Date.now() && Array.isArray(permissions)) {
        return Promise.resolve(resolveAllowedRoleLandingPage(role, permissions, cached.landingPage));
    }
    const permissionsPromise = Array.isArray(permissions)
        ? Promise.resolve(permissions)
        : getRolePermissions(role);
    return Promise.all([
        permissionsPromise,
        pool.query('SELECT default_landing_page FROM role_settings WHERE role = ? LIMIT 1', [role]),
    ]).then(([resolvedPermissions, [rows]]) => {
        const configuredLandingPage = rows?.[0]?.default_landing_page
            ? String(rows[0].default_landing_page).trim()
            : null;
        const landingPage = resolveAllowedRoleLandingPage(role, resolvedPermissions, configuredLandingPage);
        roleLandingPageCache.set(role, {
            landingPage,
            expiresAt: Date.now() + ROLE_PERMISSION_TTL_MS,
        });
        return landingPage;
    });
}

const requirePermission = permission => async (req, res, next) => {
    try {
        if (req.simrsAuthenticated) {
            return next();
        }
        const role = getRoleFromRequest(req);
        if (!role) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        const permissions = await getRolePermissions(role);
        if (permissions.includes(permission)) {
            return next();
        }
        return res.status(403).json({ error: 'Forbidden' });
    } catch (err) {
        return res.status(500).json({ error: err.message || 'Permission check failed' });
    }
};

const requireAnyPermission = (...permissionsList) => async (req, res, next) => {
    try {
        if (req.simrsAuthenticated) {
            return next();
        }
        const role = getRoleFromRequest(req);
        if (!role) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        const permissions = await getRolePermissions(role);
        if (permissionsList.some(permission => permissions.includes(permission))) {
            return next();
        }
        return res.status(403).json({ error: 'Forbidden' });
    } catch (err) {
        return res.status(500).json({ error: err.message || 'Permission check failed' });
    }
};

const normalizeClientIp = value =>
    String(value || '')
        .replace(/^::ffff:/, '')
        .trim();

const requireSimrsApiKey = (req, res, next) => {
    const internalWorker = String(req.headers['x-ris-order-worker'] || '') === '1';
    const requestIp = normalizeClientIp(req.ip || req.socket?.remoteAddress || '');
    if (internalWorker && ['127.0.0.1', '::1'].includes(requestIp)) {
        req.headers['x-user-role'] = 'administrator';
        req.headers['x-user-username'] = 'order-in-worker';
        return next();
    }
    const appLinkSettings = readAppLinkSettings();
    const simrsApi = appLinkSettings.simrsApi || {};
    const configuredKey = String(process.env.SIMRS_API_KEY || simrsApi.apiKey || '').trim();
    const providedKey = String(req.headers['x-api-key'] || '').trim();
    if (!configuredKey) {
        return res.status(503).json({ error: 'SIMRS API key is not configured' });
    }
    if (!providedKey || providedKey !== configuredKey) {
        return res.status(401).json({ error: 'Invalid SIMRS API key' });
    }

    const allowedIps = process.env.SIMRS_ALLOWED_IPS
        ? String(process.env.SIMRS_ALLOWED_IPS || '')
            .split(',')
            .map(normalizeClientIp)
            .filter(Boolean)
        : (Array.isArray(simrsApi.allowedIps) ? simrsApi.allowedIps.map(normalizeClientIp).filter(Boolean) : []);
    if (allowedIps.length > 0) {
        const clientIps = [
            req.ip,
            req.socket?.remoteAddress,
            String(req.headers['x-forwarded-for'] || '').split(',')[0],
        ]
            .map(normalizeClientIp)
            .filter(Boolean);
        const isAllowed = clientIps.some(ip => allowedIps.includes(ip));
        if (!isAllowed) {
            return res.status(403).json({ error: 'SIMRS client IP is not allowed' });
        }
    }

    req.headers['x-user-role'] = req.headers['x-user-role'] || process.env.SIMRS_API_ROLE || simrsApi.role || 'administrator';
    req.headers['x-user-username'] = req.headers['x-user-username'] || process.env.SIMRS_API_USERNAME || simrsApi.username || 'simrs-integration';
    req.simrsAuthenticated = true;
    next();
};

async function ensureAuditLogTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        event_type VARCHAR(64) NOT NULL,
        outcome VARCHAR(16) NOT NULL DEFAULT 'success',
        username VARCHAR(100) NULL,
        role VARCHAR(50) NULL,
        ip_address VARCHAR(64) NULL,
        user_agent VARCHAR(255) NULL,
        study_instance_uid VARCHAR(128) NULL,
        series_instance_uid VARCHAR(128) NULL,
        sop_instance_uid VARCHAR(128) NULL,
        target_type VARCHAR(64) NULL,
        target_id VARCHAR(255) NULL,
        details_json JSON NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_audit_created_at (created_at),
        INDEX idx_audit_event_type (event_type),
        INDEX idx_audit_study (study_instance_uid),
        INDEX idx_audit_username (username)
      )
    `);
}

async function writeAuditLog(req, event) {
    try {
        await ensureAuditLogTable();
        const details = event.details && typeof event.details === 'object' ? event.details : null;
        await pool.query(
            `
            INSERT INTO audit_logs (
              event_type, outcome, username, role, ip_address, user_agent,
              study_instance_uid, series_instance_uid, sop_instance_uid,
              target_type, target_id, details_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
                event.eventType,
                event.outcome || 'success',
                event.username || getUsernameFromRequest(req),
                event.role || getRoleFromRequest(req),
                req?.ip || req?.socket?.remoteAddress || null,
                String(req?.headers?.['user-agent'] || '').slice(0, 255) || null,
                event.studyInstanceUid || null,
                event.seriesInstanceUid || null,
                event.sopInstanceUid || null,
                event.targetType || null,
                event.targetId || null,
                details ? JSON.stringify(details) : null,
            ]
        );
    } catch (error) {
        console.error('[audit] failed to write audit log:', error.message);
    }
}

function summarizeSimrsPayload(payload = {}) {
    const source = payload && typeof payload === 'object' ? payload : {};
    const fields = [
        'no_rm',
        'nama_pasien',
        'tanggal_lahir',
        'no_register',
        'no_rontgen',
        'accession_number',
        'kode_pemeriksaan',
        'nama_pemeriksaan',
        'modality',
        'kode_dokter',
        'nama_dokter',
        'kode_dokter_radiolog',
        'nama_radiolog',
        'kode_radiografer',
        'nama_radiografer',
        'update_ris',
    ];
    return fields.reduce((result, field) => {
        if (source[field] !== undefined && source[field] !== null && String(source[field]).trim() !== '') {
            result[field] = source[field];
        }
        return result;
    }, {});
}

async function writeSimrsFailureLog(req, options = {}) {
    const reason = String(options.reason || options.error || 'SIMRS integration failed').trim();
    await writeAuditLog(req, {
        eventType: options.eventType || 'simrs_integration_failed',
        outcome: 'failure',
        targetType: options.targetType || 'simrs_integration',
        targetId: options.targetId || options.noRontgen || options.noRm || null,
        details: {
            source: options.source || (req?.simrsAuthenticated ? 'simrs-api' : 'ris'),
            direction: options.direction || null,
            no_rontgen: options.noRontgen || null,
            no_rm: options.noRm || null,
            reason,
            payload: summarizeSimrsPayload(options.payload || req?.body || {}),
            ...(options.details && typeof options.details === 'object' ? options.details : {}),
        },
    });
}

async function sendSimrsFailure(res, req, status, message, options = {}) {
    await writeSimrsFailureLog(req, {
        ...options,
        reason: message,
    });
    return res.status(status).json({ error: message });
}

function getDeleteReason(req) {
    return String(req.body?.deleteReason || req.body?.reason || '').trim();
}

function requireDeleteReason(req, res) {
    const deleteReason = getDeleteReason(req);
    if (!deleteReason) {
        res.status(400).json({ error: 'Delete reason is required' });
        return null;
    }
    return deleteReason;
}

const getDicomString = (item, tag) => {
    if (!item || !tag) return '';
    const element = item[tag];
    const value = Array.isArray(element?.Value) ? element.Value[0] : undefined;
    return (value ?? '').toString();
};

const getDicomNumber = (item, tag) => {
    if (!item || !tag) return 0;
    const element = item[tag];
    const value = Array.isArray(element?.Value) ? element.Value[0] : undefined;
    const numeric = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
};

const getPersonName = (item, tag) => {
    if (!item || !tag) return '';
    const element = item[tag];
    const value = Array.isArray(element?.Value) ? element.Value[0] : undefined;
    if (value && typeof value === 'object' && value.Alphabetic) {
        return String(value.Alphabetic);
    }
    return (value ?? '').toString();
};

const mapDicomStudyToWorklist = study => {
    const patientName = getPersonName(study, '00100010');
    const referringName = getPersonName(study, '00080090');
    return {
        patientId: getDicomString(study, '00100020'),
        patientName,
        otherPatientIds: getDicomString(study, '00101000'),
        accessionNumber: getDicomString(study, '00080050'),
        institutionName: getDicomString(study, '00080080'),
        modalityCode:
            getDicomString(study, '00080060') || getDicomString(study, '00080061'),
        studyDescription: getDicomString(study, '00081030'),
        imageCount: getDicomNumber(study, '00201208'),
        seriesCount: getDicomNumber(study, '00201206'),
        referringPhysician: referringName,
        studyDate: getDicomString(study, '00080020'),
        studyTime: getDicomString(study, '00080030'),
        studyId: getDicomString(study, '00200010'),
        birthDate: getDicomString(study, '00100030'),
        sex: getDicomString(study, '00100040'),
        studyInstanceUid: getDicomString(study, '0020000D'),
    };
};

const normalizeReconcileValue = value =>
    String(value || '')
        .trim()
        .toUpperCase();

const getDicomStudyIdentity = study => ({
    studyInstanceUid: getDicomString(study, '0020000D'),
    patientId: getDicomString(study, '00100020'),
    patientName: getPersonName(study, '00100010'),
    accessionNumber: getDicomString(study, '00080050'),
    modality: getDicomString(study, '00080060') || getDicomString(study, '00080061'),
    studyDescription: getDicomString(study, '00081030'),
    studyDate: getDicomString(study, '00080020'),
});

const mapMwlOrderReconcileRow = row => ({
    id: row.id,
    orderId: row.id,
    patientId: row.no_rm || '',
    patientName: row.nama_pasien || '',
    accessionNumber: row.accession_number || '',
    plannedStudyInstanceUid: row.study_instance_uid || '',
    actualStudyInstanceUid: row.actual_study_instance_uid || '',
    modality: row.modality || '',
    studyDescription: row.procedure_desc || row.study_master_description || '',
    studyDate: row.study_date || '',
    status: row.status || '',
    reconcileStatus: row.reconcile_status || '',
    matchReason: row.match_reason || '',
});

const normalizeDashboardModalities = (...values) => {
    const cleaned = [];
    values.forEach(value => {
        String(value || '')
            .split('\\')
            .map(item => item.trim().toUpperCase())
            .filter(Boolean)
            .forEach(item => {
                if (item !== 'SR') {
                    cleaned.push(item);
                }
            });
    });
    return Array.from(new Set(cleaned));
};

const ensurePacsMwlTables = async () => {
    const db = dicomwebPacs.getPacsMetadataDb();
    await db.query(`
        CREATE TABLE IF NOT EXISTS mwl_worklists (
          id VARCHAR(191) NOT NULL PRIMARY KEY,
          active TINYINT(1) NOT NULL DEFAULT 1,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          accession_number VARCHAR(128) NULL,
          study_instance_uid VARCHAR(128) NULL,
          patient_id VARCHAR(128) NULL,
          patient_name VARCHAR(255) NULL,
          modality VARCHAR(32) NULL,
          station_aet VARCHAR(64) NULL,
          scheduled_date VARCHAR(32) NULL,
          scheduled_time VARCHAR(32) NULL,
          tags_json LONGTEXT NULL,
          dicom_tags_json LONGTEXT NULL,
          meta_json LONGTEXT NULL,
          source_payload_json LONGTEXT NULL,
          INDEX idx_mwl_worklists_active (active),
          INDEX idx_mwl_worklists_updated_at (updated_at),
          INDEX idx_mwl_worklists_accession (accession_number),
          INDEX idx_mwl_worklists_study_uid (study_instance_uid),
          INDEX idx_mwl_worklists_patient_id (patient_id),
          INDEX idx_mwl_worklists_modality (modality),
          INDEX idx_mwl_worklists_station_aet (station_aet)
        )
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS mwl_query_logs (
          id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          calling_ae_title VARCHAR(64) NULL,
          called_ae_title VARCHAR(64) NULL,
          remote_address VARCHAR(128) NULL,
          remote_port INT NULL,
          patient_id VARCHAR(128) NULL,
          patient_name VARCHAR(255) NULL,
          accession_number VARCHAR(128) NULL,
          study_instance_uid VARCHAR(128) NULL,
          modality VARCHAR(32) NULL,
          scheduled_station_ae_title VARCHAR(64) NULL,
          scheduled_date VARCHAR(128) NULL,
          scheduled_time VARCHAR(128) NULL,
          match_count INT NOT NULL DEFAULT 0,
          outcome VARCHAR(32) NOT NULL,
          status_code VARCHAR(32) NULL,
          reason_code VARCHAR(64) NULL,
          error_message TEXT NULL,
          recommendation TEXT NULL,
          matched_worklist_ids LONGTEXT NULL,
          active_worklist_count INT NULL,
          filter_summary_json LONGTEXT NULL,
          query_json LONGTEXT NULL,
          INDEX idx_mwl_query_logs_created_at (created_at),
          INDEX idx_mwl_query_logs_calling_ae (calling_ae_title),
          INDEX idx_mwl_query_logs_called_ae (called_ae_title),
          INDEX idx_mwl_query_logs_accession (accession_number),
          INDEX idx_mwl_query_logs_patient_id (patient_id),
          INDEX idx_mwl_query_logs_study_uid (study_instance_uid),
          INDEX idx_mwl_query_logs_modality (modality),
          INDEX idx_mwl_query_logs_station_aet (scheduled_station_ae_title),
          INDEX idx_mwl_query_logs_outcome (outcome)
        )
    `);
    await db.query('ALTER TABLE mwl_query_logs ADD COLUMN IF NOT EXISTS reason_code VARCHAR(64) NULL');
    await db.query('ALTER TABLE mwl_query_logs ADD COLUMN IF NOT EXISTS recommendation TEXT NULL');
    await db.query('ALTER TABLE mwl_query_logs ADD COLUMN IF NOT EXISTS active_worklist_count INT NULL');
    await db.query('ALTER TABLE mwl_query_logs ADD COLUMN IF NOT EXISTS filter_summary_json LONGTEXT NULL');
    await db.query(`
        CREATE TABLE IF NOT EXISTS dicom_traffic_logs (
          id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          service VARCHAR(64) NULL,
          event_type VARCHAR(64) NOT NULL,
          outcome VARCHAR(32) NOT NULL,
          status_code VARCHAR(32) NULL,
          calling_ae_title VARCHAR(64) NULL,
          called_ae_title VARCHAR(64) NULL,
          remote_address VARCHAR(128) NULL,
          remote_port INT NULL,
          patient_id VARCHAR(128) NULL,
          patient_name VARCHAR(255) NULL,
          accession_number VARCHAR(128) NULL,
          study_instance_uid VARCHAR(128) NULL,
          series_instance_uid VARCHAR(128) NULL,
          sop_instance_uid VARCHAR(128) NULL,
          sop_class_uid VARCHAR(128) NULL,
          transfer_syntax VARCHAR(128) NULL,
          modality VARCHAR(32) NULL,
          destination_ae_title VARCHAR(64) NULL,
          message TEXT NULL,
          error_message TEXT NULL,
          details_json LONGTEXT NULL,
          INDEX idx_dicom_traffic_created_at (created_at),
          INDEX idx_dicom_traffic_event_type (event_type),
          INDEX idx_dicom_traffic_outcome (outcome),
          INDEX idx_dicom_traffic_calling_ae (calling_ae_title),
          INDEX idx_dicom_traffic_remote_address (remote_address),
          INDEX idx_dicom_traffic_study_uid (study_instance_uid),
          INDEX idx_dicom_traffic_sop_uid (sop_instance_uid)
        )
    `);
};

const normalizeSex = sex => {
    const normalized = String(sex || '')
        .trim()
        .toUpperCase();
    if (normalized === 'M' || normalized === 'F' || normalized === 'O') {
        return normalized;
    }
    return 'O';
};

const MWL_DOCTOR_ROLES = new Set(['ADMINISTRATOR', 'CLINICIAN', 'RADIOLOGIST', 'TECHNOLOGIST', 'FISMED']);

const normalizeMwlDoctorRole = value => {
    const normalized = String(value || '')
        .trim()
        .toUpperCase()
        .replace(/\s+/g, '_');
    if (normalized === 'MEDICAL_PHYSICS') return 'FISMED';
    return MWL_DOCTOR_ROLES.has(normalized) ? normalized : '';
};

async function resolveDoctorByCodeOrId({ id = null, kodeDokter = null, role = '' } = {}) {
    const normalizedRole = normalizeMwlDoctorRole(role);
    if (id !== null && Number.isFinite(Number(id)) && Number(id) > 0) {
        const [rows] = await pool.query(
            'SELECT id, kode_dokter, nama_dokter, role FROM mwl_doctors WHERE id = ?',
            [Number(id)]
        );
        const row = rows[0] || null;
        if (!row) return null;
        if (normalizedRole && row.role !== normalizedRole) return null;
        return row;
    }
    const kode = String(kodeDokter || '').trim();
    if (!kode) return null;
    const params = [kode];
    let sql = 'SELECT id, kode_dokter, nama_dokter, role FROM mwl_doctors WHERE kode_dokter = ?';
    if (normalizedRole) {
        sql += ' AND role = ?';
        params.push(normalizedRole);
    }
    const [rows] = await pool.query(sql, params);
    return rows[0] || null;
}

async function resolveStudyMasterByCodeOrId({ id = null, procedureCode = null } = {}) {
    if (id !== null && Number.isFinite(Number(id)) && Number(id) > 0) {
        const [rows] = await pool.query(
            'SELECT id, procedure_code, modality_code, study_description FROM mwl_studies WHERE id = ?',
            [Number(id)]
        );
        return rows[0] || null;
    }
    const code = String(procedureCode || '').trim();
    if (!code) return null;
    const [rows] = await pool.query(
        'SELECT id, procedure_code, modality_code, study_description FROM mwl_studies WHERE procedure_code = ?',
        [code]
    );
    return rows[0] || null;
}

const normalizeStrictCompareText = value =>
    String(value || '')
        .trim()
        .replace(/\s+/g, ' ')
        .toUpperCase();

const normalizeStudyDate = value => {
    if (!value) return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        const yyyy = value.getFullYear();
        const mm = String(value.getMonth() + 1).padStart(2, '0');
        const dd = String(value.getDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
    }
    const asText = String(value).trim();
    const matcher = asText.match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})$/);
    if (matcher) {
        return `${matcher[1]}-${matcher[2]}-${matcher[3]}`;
    }
    const parsed = new Date(asText);
    if (Number.isNaN(parsed.getTime())) return null;
    const yyyy = parsed.getFullYear();
    const mm = String(parsed.getMonth() + 1).padStart(2, '0');
    const dd = String(parsed.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
};

const normalizeStudyTime = value => {
    if (!value) return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        const hh = String(value.getHours()).padStart(2, '0');
        const mm = String(value.getMinutes()).padStart(2, '0');
        const ss = String(value.getSeconds()).padStart(2, '0');
        return `${hh}:${mm}:${ss}`;
    }
    const asText = String(value).trim().replace(/\./g, ':');
    const matcher = asText.match(/^(\d{2}):?(\d{2})(?::?(\d{2}))?$/);
    if (matcher) {
        const second = matcher[3] || '00';
        return `${matcher[1]}:${matcher[2]}:${second}`;
    }
    const parsed = new Date(asText);
    if (Number.isNaN(parsed.getTime())) return null;
    const hh = String(parsed.getHours()).padStart(2, '0');
    const mm = String(parsed.getMinutes()).padStart(2, '0');
    const ss = String(parsed.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
};

const normalizeDateTime = value => {
    if (!value) return null;
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) return null;
        const yyyy = String(value.getFullYear()).padStart(4, '0');
        const mm = String(value.getMonth() + 1).padStart(2, '0');
        const dd = String(value.getDate()).padStart(2, '0');
        const hh = String(value.getHours()).padStart(2, '0');
        const min = String(value.getMinutes()).padStart(2, '0');
        const ss = String(value.getSeconds()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
    }
    const asText = String(value).trim().replace('T', ' ');
    const matcher = asText.match(
        /^(\d{4})[-/]?(\d{2})[-/]?(\d{2})(?:\s+(\d{2}):?(\d{2})(?::?(\d{2}))?)?$/
    );
    if (!matcher) return null;
    const hh = matcher[4] || '00';
    const mm = matcher[5] || '00';
    const ss = matcher[6] || '00';
    return `${matcher[1]}-${matcher[2]}-${matcher[3]} ${hh}:${mm}:${ss}`;
};

const toDicomDate = value => {
    if (!value) return '';
    const pad2 = n => String(n).padStart(2, '0');
    const formatDate = date => {
        if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
        return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
    };
    if (value instanceof Date) {
        return formatDate(value);
    }
    const text = String(value).trim();
    if (!text) return '';
    if (/^\d{8}$/.test(text)) {
        return text;
    }
    const ymd = text.match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})$/);
    if (ymd) {
        return `${ymd[1]}${ymd[2]}${ymd[3]}`;
    }
    const parsed = new Date(text);
    const parsedFormatted = formatDate(parsed);
    if (parsedFormatted) {
        return parsedFormatted;
    }
    return String(text).replace(/[^0-9]/g, '').slice(0, 8);
};
const toDicomTime = value => String(value || '').replace(/[^0-9]/g, '').slice(0, 6);

const normalizeModality = modality => {
    const normalized = String(modality || '').trim();
    if (!normalized) return 'OT';
    return normalized.slice(0, 16);
};

const normalizeCito = value => {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'boolean') return value ? '1' : '0';
    const normalized = String(value || '').trim().toUpperCase();
    if (['1', 'Y', 'YES', 'TRUE', 'S', 'E', 'CITO', 'EMERGENCY'].includes(normalized)) {
        return '1';
    }
    return '0';
};

const generateAccessionNumber = () => {
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const random = Math.floor(Math.random() * 9000 + 1000);
    return `ACC-${stamp}-${random}`;
};

const generateStudyInstanceUid = () => {
    const root = String(process.env.MWL_UID_ROOT || '1.2.826.0.1.3680043.10.5432').replace(/[^0-9.]/g, '');
    const now = Date.now().toString();
    const random = Math.floor(Math.random() * 1e9).toString();
    return `${root}.${now}.${random}`;
};

const getSafeAet = aet => {
    const fallback = process.env.DEFAULT_MODALITY_AET || '';
    const value = String(aet || fallback).trim();
    return value ? value.slice(0, 16) : null;
};

const toDicomAet = aet => {
    const safe = getSafeAet(aet);
    return safe || null;
};

const buildMwlDicomPayload = ({ order, patient, technologist, modalityStationAet }) => {
    const studyDateDicom = toDicomDate(order.study_date);
    const studyTimeDicom = toDicomTime(order.study_time);
    const patientDobDicom = toDicomDate(patient.tanggal_lahir);
    const requestedProcedureCode = order.procedure_code || order.modality || 'RISPROC';
    const requestedProcedureDesc = order.procedure_desc || 'RADIOLOGY PROCEDURE';
    const modality = String(order.modality || 'OT').trim().toUpperCase().slice(0, 16);
    const stationAet = toDicomAet(modalityStationAet || order.modality_station_ae);
    const studyInstanceUid = String(order.study_instance_uid || '').trim() || generateStudyInstanceUid();
    const spsId = String(order.accession_number || studyInstanceUid || 'SPS')
        .replace(/[^A-Za-z0-9_.-]/g, '')
        .slice(0, 16) || 'SPS';
    const orthancRequest = {
        Tags: {
            PatientName: patient.nama_pasien,
            PatientID: patient.no_rm,
            PatientBirthDate: patientDobDicom,
            PatientSex: normalizeSex(patient.kelamin),
            AccessionNumber: order.accession_number,
            RequestedProcedureDescription: requestedProcedureDesc,
            RequestedProcedureID: requestedProcedureCode,
            StudyInstanceUID: studyInstanceUid,
            ReferringPhysicianName: order.referring_physician || '',
            ScheduledProcedureStepSequence: [
                {
                    Modality: modality,
                    ScheduledStationAETitle: stationAet || '',
                    ScheduledProcedureStepStartDate: studyDateDicom,
                    ScheduledProcedureStepStartTime: studyTimeDicom || '000000',
                    ScheduledProcedureStepDescription: requestedProcedureDesc,
                    ScheduledProcedureStepID: spsId,
                    ScheduledPerformingPhysicianName:
                        technologist?.name || technologist?.username || '',
                },
            ],
        },
    };
    return {
        accessionNumber: order.accession_number,
        studyInstanceUid,
        orthancRequest,
        dicomTags: {
            '0008,0050': order.accession_number,
            '0020,000D': studyInstanceUid,
            '0008,0090': order.referring_physician || '',
            '0008,0020': studyDateDicom,
            '0008,0030': studyTimeDicom,
            '0010,0010': patient.nama_pasien,
            '0010,0020': patient.no_rm,
            '0010,0030': patientDobDicom,
            '0010,0040': normalizeSex(patient.kelamin),
            '0040,0100': [
                {
                    '0040,0001': stationAet || '',
                    '0040,0002': studyDateDicom,
                    '0040,0003': studyTimeDicom,
                    '0040,0006': modality,
                    '0040,0007': technologist?.name || technologist?.username || '',
                    '0040,0009': spsId,
                    '0040,0008': requestedProcedureDesc,
                },
            ],
            '0032,1064': requestedProcedureCode,
            '0032,1060': requestedProcedureDesc,
        },
        meta: {
            patientId: patient.no_rm,
            patientName: patient.nama_pasien,
            modality,
            procedureCode: requestedProcedureCode,
            procedureDescription: requestedProcedureDesc,
            referringPhysician: order.referring_physician || '',
            studyInstanceUid,
            technologist: technologist
                ? {
                      id: technologist.id,
                      username: technologist.username,
                      name: technologist.name,
                  }
                : null,
            stationAet,
        },
    };
};

const persistMwlPayloadToFile = (payload, suffix = '.json') => {
    const configuredDir = process.env.ORTHANC_MWL_DEBUG_DIR;
    const fallbackDir = path.resolve(__dirname, 'mwl-debug-outbox');
    const targetDir = configuredDir ? path.resolve(configuredDir) : fallbackDir;
    fs.mkdirSync(targetDir, { recursive: true });
    const safeAccession = String(payload.accessionNumber || 'UNKNOWN').replace(/[^A-Za-z0-9_-]/g, '_');
    const fileName = `${safeAccession}_${Date.now()}${suffix}`;
    const fullPath = path.join(targetDir, fileName);
    fs.writeFileSync(fullPath, JSON.stringify(payload, null, 2), 'utf8');
    return fileName;
};

const getOrthancAuthHeaders = () => {
    const username = process.env.ORTHANC_USERNAME;
    const password = process.env.ORTHANC_PASSWORD;
    if (!username && !password) return {};
    const token = Buffer.from(`${username || ''}:${password || ''}`).toString('base64');
    return {
        Authorization: `Basic ${token}`,
    };
};

const tryPostWorklist = async (url, body) => {
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...getOrthancAuthHeaders(),
        },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        const error = new Error(text || `Failed MWL POST (${response.status})`);
        error.status = response.status;
        throw error;
    }
    let parsed = null;
    try {
        parsed = await response.json();
    } catch (err) {
        parsed = null;
    }
    return {
        status: response.status,
        body: parsed,
    };
};

const dispatchMwlToOrthanc = async payload => {
    const requestPayload = payload;
    const dicomwebRoot = String(DICOMWEB_PACS_ROOT || 'http://127.0.0.1:5001').replace(/\/+$/, '');
    const root = String(ORTHANC_ROOT || 'http://127.0.0.1:8042').replace(/\/+$/, '');
    const configuredEndpoint = process.env.ORTHANC_MWL_ENDPOINT
        ? [process.env.ORTHANC_MWL_ENDPOINT]
        : [];
    const configuredDicomwebEndpoint = process.env.DICOMWEB_PACS_MWL_ENDPOINT
        ? [process.env.DICOMWEB_PACS_MWL_ENDPOINT]
        : [`${dicomwebRoot}/mwl/worklists`];
    const orthancFallbackEnabled = ['1', 'true', 'yes', 'on'].includes(
        String(process.env.MWL_ENABLE_ORTHANC_FALLBACK || 'false').toLowerCase()
    );
    const candidateEndpoints = [
        ...configuredDicomwebEndpoint,
        ...(orthancFallbackEnabled
            ? [
                  ...configuredEndpoint,
                  `${root}/plugins/oe2/worklists`,
                  `${root}/worklists/create`,
              ]
            : []),
    ];
    let lastError = null;
    for (const endpoint of candidateEndpoints) {
        try {
            const isDicomwebPacsEndpoint = endpoint.includes('/mwl/worklists');
            const result = await tryPostWorklist(
                endpoint,
                isDicomwebPacsEndpoint ? requestPayload : payload.orthancRequest || {}
            );
            const debugFileName = persistMwlPayloadToFile({
                ...payload,
                dispatchEndpoint: endpoint,
                dispatchResponse: result.body || null,
            });
            return {
                orthancFileName: result.body?.ID || result.body?.Path || debugFileName,
                transportMethod: isDicomwebPacsEndpoint
                    ? 'REST_DICOMWEB_PACS_MWL'
                    : endpoint.includes('/plugins/oe2/worklists')
                    ? 'REST_OE2'
                    : endpoint.includes('/worklists/create')
                      ? 'REST_WORKLISTS_PLUGIN'
                      : 'REST_CUSTOM',
                orthancStatus: isDicomwebPacsEndpoint ? 'SENT_TO_DICOMWEB_PACS' : 'SENT_TO_ORTHANC',
                endpoint,
            };
        } catch (err) {
            lastError = err;
        }
    }
    const debugFileName = persistMwlPayloadToFile({
        ...payload,
        dispatchError: lastError?.message || 'Unknown error',
    });
    const error = new Error(
        `Failed to send MWL to dicomweb-pacs. Last error: ${lastError?.message || 'Unknown error'}. Debug: ${debugFileName}`
    );
    error.status = lastError?.status || 502;
    throw error;
};

const deleteOrthancWorklistEntry = async entryRef => {
    const dicomwebRoot = String(DICOMWEB_PACS_ROOT || 'http://127.0.0.1:5001').replace(/\/+$/, '');
    const root = String(ORTHANC_ROOT || 'http://127.0.0.1:8042').replace(/\/+$/, '');
    const raw = String(entryRef || '').trim();
    if (!raw) return;
    const candidates = [];
    if (raw.startsWith('/')) {
        candidates.push(`${dicomwebRoot}${raw}`);
        candidates.push(`${root}${raw}`);
    } else if (/^[0-9a-fA-F-]{8,}$/.test(raw)) {
        candidates.push(`${dicomwebRoot}/mwl/worklists/${raw}`);
        candidates.push(`${root}/worklists/${raw}`);
        candidates.push(`${root}/plugins/oe2/worklists/${raw}`);
    } else if (/^https?:\/\//i.test(raw)) {
        candidates.push(raw);
    } else {
        candidates.push(`${dicomwebRoot}/mwl/worklists/${raw}`);
        candidates.push(`${root}/worklists/${raw}`);
    }
    for (const url of candidates) {
        try {
            await fetch(url, {
                method: 'DELETE',
                headers: {
                    ...getOrthancAuthHeaders(),
                },
            });
        } catch {
            // Best effort cleanup only.
        }
    }
};

const validateMwlPayloadForSend = payload => {
    const tags = payload?.orthancRequest?.Tags || {};
    const sequence = Array.isArray(tags.ScheduledProcedureStepSequence)
        ? tags.ScheduledProcedureStepSequence[0]
        : null;
    const required = [
        ['PatientName', tags.PatientName],
        ['PatientID', tags.PatientID],
        ['PatientBirthDate', tags.PatientBirthDate],
        ['PatientSex', tags.PatientSex],
        ['AccessionNumber', tags.AccessionNumber],
        ['RequestedProcedureDescription', tags.RequestedProcedureDescription],
        ['StudyInstanceUID', tags.StudyInstanceUID],
        ['ScheduledProcedureStepSequence[0].Modality', sequence?.Modality],
        ['ScheduledProcedureStepSequence[0].ScheduledProcedureStepStartDate', sequence?.ScheduledProcedureStepStartDate],
        ['ScheduledProcedureStepSequence[0].ScheduledProcedureStepStartTime', sequence?.ScheduledProcedureStepStartTime],
    ];
    const missing = required
        .filter(([, value]) => !String(value || '').trim())
        .map(([key]) => key);
    if (missing.length) {
        const error = new Error(`Missing MWL required fields: ${missing.join(', ')}`);
        error.status = 400;
        throw error;
    }
    if (!/^\d{8}$/.test(String(tags.PatientBirthDate || ''))) {
        const error = new Error('PatientBirthDate must be YYYYMMDD');
        error.status = 400;
        throw error;
    }
    if (!/^\d{8}$/.test(String(sequence?.ScheduledProcedureStepStartDate || ''))) {
        const error = new Error('ScheduledProcedureStepStartDate must be YYYYMMDD');
        error.status = 400;
        throw error;
    }
    if (!/^\d{6}$/.test(String(sequence?.ScheduledProcedureStepStartTime || ''))) {
        const error = new Error('ScheduledProcedureStepStartTime must be HHMMSS');
        error.status = 400;
        throw error;
    }
    if (!/^[0-9.]+$/.test(String(tags.StudyInstanceUID || ''))) {
        const error = new Error('StudyInstanceUID must be a valid numeric UID');
        error.status = 400;
        throw error;
    }
    return {
        ok: true,
    };
};

async function loadMwlOrderForReconcile(orderId) {
    const [rows] = await pool.query(
        `
        SELECT
          o.*,
          oi.no_rm,
          oi.nama_pasien,
          s.study_description AS study_master_description
        FROM mwl_orders o
        LEFT JOIN order_in oi ON oi.no_rontgen = o.no_rontgen
        LEFT JOIN mwl_studies s ON s.procedure_code = COALESCE(o.kode_pemeriksaan, o.procedure_code, oi.kode_pemeriksaan)
        WHERE o.id = ?
        LIMIT 1
        `,
        [orderId]
    );
    return rows[0] || null;
}

async function closeMwlLogsForOrder(orderId, message, status = 'COMPLETED') {
    const [activeLogs] = await pool.query(
        `
        SELECT id, order_id, orthanc_file_name
        FROM mwl_logs
        WHERE order_id = ? AND is_active = 1
        `,
        [orderId]
    );
    for (const log of activeLogs) {
        await deleteOrthancWorklistEntry(log.orthanc_file_name);
    }
    await pool.query(
        `
        UPDATE mwl_logs
        SET is_active = 0,
            orthanc_status = ?,
            message = ?,
            sync_date = NOW()
        WHERE order_id = ? AND is_active = 1
        `,
        [status, message || 'Study reconciled with dicomweb-pacs', orderId]
    );
}

async function reconcileMwlOrderWithPacsStudy({
    orderId,
    actualStudyInstanceUid,
    method,
    status = 'MANUAL_MATCHED',
    reconciledBy = null,
    req = null,
    message = null,
    details = null,
} = {}) {
    const uid = String(actualStudyInstanceUid || '').trim();
    const numericOrderId = Number(orderId);
    if (!Number.isFinite(numericOrderId) || !uid) {
        const error = new Error('Order and PACS StudyInstanceUID are required for reconciliation');
        error.status = 400;
        throw error;
    }
    await ensureMwlTables();
    const order = await loadMwlOrderForReconcile(numericOrderId);
    if (!order) {
        const error = new Error('MWL order not found');
        error.status = 404;
        throw error;
    }
    if (order.status === 'CANCELLED') {
        const error = new Error('Cancelled MWL order cannot be reconciled');
        error.status = 409;
        throw error;
    }
    await pool.query(
        `
        UPDATE mwl_orders
        SET actual_study_instance_uid = ?,
            reconcile_status = ?,
            reconcile_method = ?,
            reconciled_at = NOW(),
            reconciled_by = ?,
            status = 'COMPLETED',
            radiografer_datetime_end = COALESCE(radiografer_datetime_end, NOW())
        WHERE id = ?
        `,
        [uid, status, method || null, reconciledBy || getUsernameFromRequest(req) || null, numericOrderId]
    );
    await closeMwlLogsForOrder(numericOrderId, message || `Study reconciled by ${method || 'manual'}`);
    try {
        await syncOrderInForOrder({ orderId: numericOrderId, updateRis: 'Y' });
    } catch (err) {
        console.warn(`Failed to sync order_in for reconciled MWL order ${numericOrderId}:`, err.message);
    }
    try {
        await syncOrderOutForOrder({ orderId: numericOrderId, req });
    } catch (err) {
        console.warn(`Failed to sync order_out for reconciled MWL order ${numericOrderId}:`, err.message);
    }
    await sendAutoRadiologistWhatsappForOrder(numericOrderId, req).catch(err => {
        console.warn(`Failed to send auto radiologist WhatsApp for reconciled order ${numericOrderId}:`, err.message);
    });
    await writeAuditLog(req, {
        eventType: status === 'AUTO_MATCHED' ? 'mwl_reconcile_auto' : 'mwl_reconcile_manual',
        outcome: 'success',
        username: reconciledBy || undefined,
        studyInstanceUid: uid,
        targetType: 'mwl_order',
        targetId: String(numericOrderId),
        details: {
            planned_study_instance_uid: order.study_instance_uid,
            actual_study_instance_uid: uid,
            accession_number: order.accession_number,
            patient_id: order.no_rm,
            patient_name: order.nama_pasien,
            method: method || null,
            ...details,
        },
    });
    return loadMwlOrderForReconcile(numericOrderId);
}

async function findMwlReconcileCandidates({ accessionNumber, patientId, studyInstanceUid } = {}) {
    await ensureMwlTables();
    const accession = String(accessionNumber || '').trim();
    const patient = String(patientId || '').trim();
    const studyUid = String(studyInstanceUid || '').trim();
    if (!accession && !patient && !studyUid) {
        return { exact: null, candidates: [] };
    }
    const params = [];
    const candidateWhere = [];
    if (studyUid) {
        candidateWhere.push('(o.study_instance_uid = ? OR o.actual_study_instance_uid = ?)');
        params.push(studyUid, studyUid);
    }
    if (accession) {
        candidateWhere.push('o.accession_number = ?');
        params.push(accession);
    }
    if (patient) {
        candidateWhere.push('oi.no_rm = ?');
        params.push(patient);
    }
    const [rows] = await pool.query(
        `
        SELECT
          o.*,
          oi.no_rm,
          oi.nama_pasien,
          s.study_description AS study_master_description,
          CASE
            WHEN UPPER(TRIM(o.accession_number)) = UPPER(TRIM(?)) AND UPPER(TRIM(oi.no_rm)) = UPPER(TRIM(?)) THEN 'exact_accession_patient'
            WHEN UPPER(TRIM(o.accession_number)) = UPPER(TRIM(?)) THEN 'same_accession_patient_differs'
            WHEN UPPER(TRIM(oi.no_rm)) = UPPER(TRIM(?)) THEN 'same_patient_accession_differs'
            WHEN o.study_instance_uid = ? OR o.actual_study_instance_uid = ? THEN 'same_study_uid'
            ELSE 'candidate'
          END AS match_reason
        FROM mwl_orders o
        LEFT JOIN order_in oi ON oi.no_rontgen = o.no_rontgen
        LEFT JOIN mwl_studies s ON s.procedure_code = COALESCE(o.kode_pemeriksaan, o.procedure_code, oi.kode_pemeriksaan)
        WHERE o.status <> 'CANCELLED'
          AND (${candidateWhere.join(' OR ')})
        ORDER BY
          CASE
            WHEN UPPER(TRIM(o.accession_number)) = UPPER(TRIM(?)) AND UPPER(TRIM(oi.no_rm)) = UPPER(TRIM(?)) THEN 0
            WHEN UPPER(TRIM(o.accession_number)) = UPPER(TRIM(?)) THEN 1
            WHEN UPPER(TRIM(oi.no_rm)) = UPPER(TRIM(?)) THEN 2
            ELSE 3
          END,
          o.updated_at DESC
        LIMIT 20
        `,
        [accession, patient, accession, patient, studyUid, studyUid, ...params, accession, patient, accession, patient]
    );
    const mapped = rows.map(mapMwlOrderReconcileRow);
    const exact =
        mapped.find(
            row =>
                normalizeReconcileValue(row.accessionNumber) === normalizeReconcileValue(accession) &&
                normalizeReconcileValue(row.patientId) === normalizeReconcileValue(patient)
        ) || null;
    return {
        exact,
        candidates: mapped,
    };
}

const syncCompletedMwlOrdersFromOrthanc = async (options = {}) => {
    const limitRaw = Number(options.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 500) : 200;
    const [pendingRows] = await pool.query(
        `
        SELECT o.id, o.study_instance_uid, o.accession_number, o.actual_study_instance_uid, p.no_rm
        FROM mwl_orders o
        INNER JOIN patients p ON p.id = o.patient_record_id
        WHERE o.status = 'SENT_TO_MWL'
          AND study_instance_uid IS NOT NULL
          AND study_instance_uid <> ''
        ORDER BY o.updated_at DESC
        LIMIT ?
        `,
        [limit]
    );
    if (!pendingRows.length) {
        return { checked: 0, completed: 0 };
    }
    const completedOrderIds = [];
    for (const row of pendingRows) {
        try {
            const instanceCount = await dicomwebPacs.getStudyInstanceCount(row.study_instance_uid);
            if (instanceCount > 0) {
                await reconcileMwlOrderWithPacsStudy({
                    orderId: row.id,
                    actualStudyInstanceUid: row.study_instance_uid,
                    method: 'planned_study_uid',
                    status: 'MWL_MATCHED',
                    message: 'Study completed by scheduled MWL StudyInstanceUID',
                    details: { instanceCount },
                });
                completedOrderIds.push(row.id);
            }
        } catch (err) {
            // Planned UID completion is best-effort and should not block MWL listing.
        }
    }
    return { checked: pendingRows.length, completed: completedOrderIds.length };
};

let mwlCompletionSyncState = {
    running: false,
    lastStartedAt: 0,
    lastResult: null,
};

function shouldForceMwlCompletionSync(req) {
    const value = String(req?.query?.sync || req?.query?.refresh || '').trim().toLowerCase();
    return ['1', 'true', 'yes', 'force'].includes(value);
}

async function triggerMwlCompletionSync(req, options = {}) {
    const force = Boolean(options.force || shouldForceMwlCompletionSync(req));
    const throttleMs = Number(options.throttleMs || 30000);
    const now = Date.now();
    if (mwlCompletionSyncState.running) {
        return { status: 'running', result: mwlCompletionSyncState.lastResult };
    }
    if (!force && now - mwlCompletionSyncState.lastStartedAt < throttleMs) {
        return { status: 'throttled', result: mwlCompletionSyncState.lastResult };
    }
    mwlCompletionSyncState.running = true;
    mwlCompletionSyncState.lastStartedAt = now;
    try {
        const result = await syncCompletedMwlOrdersFromOrthanc(options);
        mwlCompletionSyncState.lastResult = result;
        return { status: 'completed', result };
    } catch (error) {
        mwlCompletionSyncState.lastResult = { error: error.message || 'MWL completion sync failed' };
        throw error;
    } finally {
        mwlCompletionSyncState.running = false;
    }
}

function scheduleMwlCompletionSync(req, options = {}) {
    if (shouldForceMwlCompletionSync(req)) {
        return triggerMwlCompletionSync(req, { ...options, force: true });
    }
    triggerMwlCompletionSync(req, options).catch(err => {
        console.warn('[mwl] background completion sync failed:', err.message);
    });
    return Promise.resolve({ status: 'scheduled' });
}

async function reconcileMwlOrderForManagerStudy(studyInstanceUid, options = {}) {
    const uid = String(studyInstanceUid || '').trim();
    if (!uid) return null;
    await ensureMwlTables();
    const [rows] = await pool.query(
        `
        SELECT id, status
        FROM mwl_orders
        WHERE (study_instance_uid = ? OR actual_study_instance_uid = ?)
          AND status <> 'CANCELLED'
        ORDER BY
          CASE status
            WHEN 'SENT_TO_MWL' THEN 1
            WHEN 'PENDING' THEN 2
            WHEN 'COMPLETED' THEN 3
            ELSE 4
          END,
          updated_at DESC,
          id DESC
        LIMIT 1
        `,
        [uid, uid]
    );
    const order = rows?.[0] || null;
    if (!order) return null;
    if (order.status === 'COMPLETED') return { id: order.id, alreadyCompleted: true };
    const reconciled = await reconcileMwlOrderWithPacsStudy({
        orderId: order.id,
        actualStudyInstanceUid: uid,
        method: options.method || 'dicom_manager_fill',
        status: 'MANUAL_MATCHED',
        req: options.req || null,
        message: options.message || 'Study completed by DICOM Manager',
        details: {
            source: 'dicom_manager',
            ...(options.details || {}),
        },
    });
    return { id: order.id, status: reconciled?.status || 'COMPLETED' };
}

async function safeReconcileMwlOrderForManagerStudy(studyInstanceUid, options = {}) {
    try {
        return await reconcileMwlOrderForManagerStudy(studyInstanceUid, options);
    } catch (error) {
        console.warn('[dicom-manager] post-move MWL reconcile failed:', error.message || error);
        return {
            ok: false,
            error: error.message || 'Failed to reconcile MWL order after DICOM move',
        };
    }
}

async function getLatestPublicShareLinkForStudy(studyInstanceUid, reqLike) {
    if (!studyInstanceUid) return null;
    await ensurePublicShareTable();
    const [rows] = await pool.query(
        `
        SELECT token, study_instance_uid, created_by, created_at, expires_at, patient_phone
        FROM public_share_links
        WHERE study_instance_uid = ?
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [studyInstanceUid]
    );
    const latest = rows[0] || null;
    if (!latest) return null;
    const appLinkSettings = readAppLinkSettings();
    const baseUrl = reqLike ? await resolvePublicBaseUrl(reqLike) : appLinkSettings.publicBaseUrl;
    return {
        token: latest.token,
        url: buildPublicAppUrl(baseUrl, appLinkSettings.publicStudyPath, latest.token),
        expires_at: latest.expires_at,
        patient_phone: latest.patient_phone,
    };
}

async function ensureViewerAccessTokenTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS viewer_access_links (
        token VARCHAR(64) PRIMARY KEY,
        accession_number VARCHAR(64) NOT NULL,
        study_instance_uid VARCHAR(128) NULL,
        created_by VARCHAR(100) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NULL DEFAULT NULL,
        revoked_at TIMESTAMP NULL DEFAULT NULL,
        revoke_reason VARCHAR(255) NULL,
        usage_count INT NOT NULL DEFAULT 0,
        last_used_at TIMESTAMP NULL DEFAULT NULL,
        INDEX idx_viewer_access_accession (accession_number),
        INDEX idx_viewer_access_study (study_instance_uid),
        INDEX idx_viewer_access_expires (expires_at)
      )
    `);
}

async function readViewerAccessLink(token) {
    await ensureViewerAccessTokenTable();
    const [rows] = await pool.query(
        `
        SELECT token, accession_number, study_instance_uid, created_by, created_at, expires_at, revoked_at, revoke_reason, usage_count, last_used_at
        FROM viewer_access_links
        WHERE token = ?
        LIMIT 1
        `,
        [token]
    );
    return rows[0] || null;
}

async function revokeViewerAccessLinksByAccession(accessionNumber, reason = null) {
    const accession = String(accessionNumber || '').trim();
    if (!accession) return 0;
    await ensureViewerAccessTokenTable();
    const [result] = await pool.query(
        `
        UPDATE viewer_access_links
        SET revoked_at = NOW(),
            revoke_reason = ?
        WHERE accession_number = ?
          AND revoked_at IS NULL
        `,
        [reason || 'regenerated', accession]
    );
    return Number(result?.affectedRows || 0);
}

async function getViewerAccessExpiryDate() {
    const appLinkSettings = readAppLinkSettings();
    const settingsDays = Number(appLinkSettings?.viewerAccessToken?.expiresInDays);
    if (Number.isFinite(settingsDays) && settingsDays >= 0) {
        if (settingsDays <= 0) return null;
        return new Date(Date.now() + settingsDays * 24 * 60 * 60 * 1000);
    }

    let configDays = null;
    try {
        const uiSettings = await readUiSettings();
        configDays = uiSettings?.viewerAccessLinkDays;
    } catch (err) {
        configDays = null;
    }
    const envDaysRaw = process.env.VIEWER_ACCESS_LINK_DAYS;
    const daysRaw =
        Number.isFinite(Number(configDays)) && Number(configDays) >= 0
            ? Number(configDays)
            : Number(envDaysRaw);
    if (!Number.isFinite(daysRaw) || daysRaw <= 0) {
        return null;
    }
    return new Date(Date.now() + daysRaw * 24 * 60 * 60 * 1000);
}

async function getOrCreateViewerAccessLinkForAccession(accessionNumber, studyInstanceUid, reqLike, createdBy = null) {
    const accession = String(accessionNumber || '').trim();
    if (!accession) return null;
    await ensureViewerAccessTokenTable();

    const [existingRows] = await pool.query(
        `
        SELECT token, accession_number, study_instance_uid, created_by, created_at, expires_at, revoked_at, revoke_reason, usage_count, last_used_at
        FROM viewer_access_links
        WHERE accession_number = ?
          AND revoked_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [accession]
    );

    let accessLink = existingRows[0] || null;
    const expiresAt = await getViewerAccessExpiryDate();
    const now = Date.now();
    const isExpired =
        accessLink?.expires_at && Number.isFinite(new Date(accessLink.expires_at).getTime())
            ? new Date(accessLink.expires_at).getTime() <= now
            : false;

    if (!accessLink || isExpired) {
        let token = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const candidate = crypto.randomBytes(24).toString('hex');
            try {
                await pool.query(
                    `
                    INSERT INTO viewer_access_links (token, accession_number, study_instance_uid, created_by, expires_at)
                    VALUES (?, ?, ?, ?, ?)
                    `,
                    [candidate, accession, studyInstanceUid || null, createdBy || null, expiresAt]
                );
                token = candidate;
                break;
            } catch (err) {
                if (err.code !== 'ER_DUP_ENTRY' || attempt === 2) {
                    throw err;
                }
            }
        }
        if (!token) return null;
        accessLink = await readViewerAccessLink(token);
    } else {
        const existingExpiryMs = accessLink?.expires_at ? new Date(accessLink.expires_at).getTime() : null;
        const desiredExpiryMs = expiresAt ? expiresAt.getTime() : null;
        if ((studyInstanceUid && accessLink.study_instance_uid !== studyInstanceUid) || existingExpiryMs !== desiredExpiryMs) {
            await pool.query(
                `
                UPDATE viewer_access_links
                SET study_instance_uid = ?, expires_at = ?, created_by = COALESCE(?, created_by)
                WHERE token = ?
                `,
                [studyInstanceUid || accessLink.study_instance_uid || null, expiresAt, createdBy || null, accessLink.token]
            );
            accessLink = await readViewerAccessLink(accessLink.token);
        }
    }

    const appLinkSettings = readAppLinkSettings();
    const publicBaseUrl = reqLike
        ? await resolvePublicBaseUrl(reqLike)
        : appLinkSettings.publicBaseUrl;
    const baseUrl = resolveViewerTokenBaseUrl(publicBaseUrl);

    return accessLink
        ? {
              ...accessLink,
              url: buildPublicAppUrl(baseUrl, appLinkSettings.viewerTokenPath, accessLink.token),
          }
        : null;
}

async function regenerateViewerAccessLinkForAccession(accessionNumber, studyInstanceUid, reqLike, createdBy = null, reason = null) {
    const accession = String(accessionNumber || '').trim();
    if (!accession) return null;
    await revokeViewerAccessLinksByAccession(accession, reason || 'manual_retry');
    return getOrCreateViewerAccessLinkForAccession(accession, studyInstanceUid, reqLike, createdBy);
}

const ORDER_IN_SOURCE_JOIN = 'LEFT JOIN order_in oi ON oi.no_rontgen = o.no_rontgen';

const ORDER_IN_SOURCE_SELECT = `
          oi.tanggal_order AS order_in_tanggal_order,
          oi.tanggal_aktivasi AS order_in_tanggal_aktivasi,
          oi.polirawat,
          oi.kode_ruangan,
          oi.nama_ruangan,
          oi.kode_dokter,
          oi.nama_dokter,
          oi.kode_pemeriksaan,
          oi.nama_pemeriksaan,
          oi.cara_bayar,
          oi.kode_asuransi,
          oi.nama_asuransi,
          oi.kode_instalasi_radiologi,
          oi.nama_instalasi_radiologi,
          oi.waktu_update_orderin,
`;

const MWL_MASTER_SOURCE_JOINS = `
        LEFT JOIN mwl_doctors dref ON dref.kode_dokter = COALESCE(o.kode_dokter, oi.kode_dokter)
        LEFT JOIN mwl_doctors drad ON drad.kode_dokter = COALESCE(o.kode_dokter_radiolog, oi.kode_dokter_radiolog)
        LEFT JOIN mwl_doctors dtech ON dtech.kode_dokter = COALESCE(o.kode_radiografer, oi.kode_radiografer)
        LEFT JOIN mwl_studies s ON s.procedure_code = COALESCE(o.kode_pemeriksaan, o.procedure_code, oi.kode_pemeriksaan)
        LEFT JOIN mwl_modalities m ON (
            m.ae_title_station <=> o.modality_station_ae
            OR (o.modality_station_ae IS NULL AND m.nama_ruangan = o.modality_station_room)
        )
`;

// Do NOT aggregate the whole mwl_logs table here. A `LEFT JOIN (SELECT order_id,
// MAX(is_active) FROM mwl_logs GROUP BY order_id)` forces PostgreSQL to scan every
// log row before it can honour ORDER BY ... LIMIT, which made the technologist
// worklist O(total logs) instead of O(page size) — measured 414-960 ms with
// 150k orders, collapsing under the 30 s auto-refresh. A correlated LATERAL
// probe uses idx_mwl_logs_order and only touches the rows on the current page
// (same result, ~8x faster). Keep this a LATERAL probe of the page, not a
// table-wide aggregate.
// Server-side replacement for the date filtering the worklist used to do in the
// browser. Filtering client-side meant the SQL `LIMIT` never applied to the
// filtered set: every request shipped the newest 300 rows and the UI then threw
// away what did not match, so "Today" cost as much as "All dates" and paging had
// nothing to page through. These bounds let the database use
// idx_mwl_orders_deleted_created (deleted_at, created_at).
function toSqlDate(value) {
    const text = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const parsed = new Date(`${text}T00:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? null : text;
}

function buildWorklistDateBounds(mode, from, to) {
    const now = new Date();
    const toDateString = date => date.toISOString().slice(0, 10);
    const startOfDaysAgo = days => {
        const start = new Date(now);
        start.setUTCDate(start.getUTCDate() - days);
        return toDateString(start);
    };
    const normalized = String(mode || '').trim().toLowerCase();
    switch (normalized) {
        case 'today':
            return { from: toDateString(now), to: toDateString(now) };
        case 'yesterday':
            return { from: startOfDaysAgo(1), to: startOfDaysAgo(1) };
        case '7days':
            return { from: startOfDaysAgo(7), to: toDateString(now) };
        case '30days':
            return { from: startOfDaysAgo(30), to: toDateString(now) };
        case '1month': {
            const start = new Date(now);
            start.setUTCMonth(start.getUTCMonth() - 1);
            return { from: toDateString(start), to: toDateString(now) };
        }
        case '2months': {
            const start = new Date(now);
            start.setUTCMonth(start.getUTCMonth() - 2);
            return { from: toDateString(start), to: toDateString(now) };
        }
        case 'range': {
            const fromDate = toSqlDate(from);
            const toDate = toSqlDate(to);
            // A custom range that is incomplete (one end missing, or the value is not
            // a real date) or inverted must NOT widen to "everything": the UI shows a
            // placeholder until both ends are picked, and any other caller has to get
            // an empty page instead of the newest rows. `empty: true` makes the route
            // answer with [].
            if (!fromDate || !toDate || fromDate > toDate) return { empty: true };
            return { from: fromDate, to: toDate };
        }
        default:
            // 'all' (legacy) or anything unrecognised: no date restriction.
            return null;
    }
}

const MWL_ACTIVE_LOG_JOIN = `
        LEFT JOIN LATERAL (
            SELECT MAX(ml_log.is_active) AS has_active_mwl
            FROM mwl_logs ml_log
            WHERE ml_log.order_id = o.id
        ) ml ON true
`;

async function loadOrderOutSource({ orderId = null, studyInstanceUid = null, noRontgen = null, accessionNumber = null } = {}) {
    const filters = [];
    const params = [];
    if (orderId) {
        filters.push('o.id = ?');
        params.push(orderId);
    }
    if (studyInstanceUid) {
        filters.push('(o.study_instance_uid = ? OR o.actual_study_instance_uid = ?)');
        params.push(studyInstanceUid, studyInstanceUid);
    }
    if (noRontgen) {
        filters.push('o.no_rontgen = ?');
        params.push(noRontgen);
    }
    if (accessionNumber) {
        filters.push('o.accession_number = ?');
        params.push(accessionNumber);
    }
    if (!filters.length) return null;
    const [orderRows] = await pool.query(
        `
        SELECT
          o.*,
${ORDER_IN_SOURCE_SELECT}
          p.no_rm,
          p.nama_pasien,
          p.tanggal_lahir,
          p.kelamin,
          p.alamat,
          p.kecamatan,
          p.kabupaten,
          p.provinsi,
          p.kode_pos,
          p.no_hp,
          dref.kode_dokter AS referring_doctor_code,
          dref.nama_dokter AS referring_doctor_name,
          drad.kode_dokter AS radiologist_doctor_code,
          drad.nama_dokter AS radiologist_doctor_name,
          dtech.kode_dokter AS technologist_username,
          dtech.nama_dokter AS technologist_name
        FROM mwl_orders o
        INNER JOIN patients p ON p.id = o.patient_record_id
        ${ORDER_IN_SOURCE_JOIN}
        ${MWL_MASTER_SOURCE_JOINS}
        WHERE ${filters.join(' OR ')}
        ORDER BY o.id DESC
        LIMIT 1
        `,
        params
    );
    return orderRows[0] || null;
}

async function upsertOrderInPayload(orderInPayload, options = {}) {
    if (!orderInPayload?.no_rontgen) return null;
    await ensureOrderInTable();
    const payload = {
        tanggal_order: toNullableDateTime(orderInPayload.tanggal_order || null),
        tanggal_aktivasi: toNullableDateTime(orderInPayload.tanggal_aktivasi || null),
        no_rm: orderInPayload.no_rm || null,
        nama_pasien: orderInPayload.nama_pasien || null,
        tanggal_lahir: orderInPayload.tanggal_lahir || null,
        kelamin: orderInPayload.kelamin || null,
        alamat: orderInPayload.alamat || null,
        kecamatan: orderInPayload.kecamatan || null,
        kabupaten: orderInPayload.kabupaten || null,
        provinsi: orderInPayload.provinsi || null,
        kode_pos: orderInPayload.kode_pos || null,
        no_hp: orderInPayload.no_hp || null,
        no_register: orderInPayload.no_register || null,
        no_rontgen: orderInPayload.no_rontgen,
        klinis: orderInPayload.klinis || null,
        diagnosa: orderInPayload.diagnosa || null,
        kode_pemeriksaan: orderInPayload.kode_pemeriksaan || orderInPayload.procedure_code || orderInPayload.study_master_procedure_code || null,
        nama_pemeriksaan: orderInPayload.nama_pemeriksaan || orderInPayload.procedure_desc || orderInPayload.study_master_description || null,
        modality: orderInPayload.modality || orderInPayload.study_master_modality_code || null,
        cito: normalizeCito(orderInPayload.cito),
        polirawat: orderInPayload.polirawat || null,
        kode_ruangan: orderInPayload.kode_ruangan || null,
        nama_ruangan: orderInPayload.nama_ruangan || null,
        kode_dokter: orderInPayload.kode_dokter || orderInPayload.referring_doctor_code || null,
        nama_dokter: orderInPayload.nama_dokter || orderInPayload.referring_doctor_name || orderInPayload.referring_physician || null,
        kode_admin: orderInPayload.kode_admin || null,
        nama_admin: orderInPayload.nama_admin || null,
        kode_dokter_radiolog: orderInPayload.kode_dokter_radiolog || orderInPayload.radiologist_doctor_code || null,
        nama_radiolog: orderInPayload.nama_radiolog || orderInPayload.radiologist_doctor_name || null,
        kode_radiografer: orderInPayload.kode_radiografer || orderInPayload.technologist_username || null,
        nama_radiografer: orderInPayload.nama_radiografer || orderInPayload.technologist_name || null,
        cara_bayar: orderInPayload.cara_bayar || null,
        kode_asuransi: orderInPayload.kode_asuransi || null,
        nama_asuransi: orderInPayload.nama_asuransi || null,
        kode_instalasi_radiologi: orderInPayload.kode_instalasi_radiologi || null,
        nama_instalasi_radiologi: orderInPayload.nama_instalasi_radiologi || null,
        alasan: options.alasan || null,
        update_ris: options.updateRis || orderInPayload.update_ris || 'N',
    };
    await pool.query(
        `
        INSERT INTO order_in (
            tanggal_order, tanggal_aktivasi, no_rm, nama_pasien, tanggal_lahir, kelamin,
            alamat, kecamatan, kabupaten, provinsi, kode_pos, no_hp, no_register, no_rontgen,
            klinis, diagnosa, kode_pemeriksaan, nama_pemeriksaan, modality, cito, polirawat,
            kode_ruangan, nama_ruangan, kode_dokter, nama_dokter, kode_admin, nama_admin,
            kode_dokter_radiolog, nama_radiolog, kode_radiografer, nama_radiografer,
            cara_bayar, kode_asuransi,
            nama_asuransi, kode_instalasi_radiologi, nama_instalasi_radiologi, alasan, update_ris
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            tanggal_order = COALESCE(VALUES(tanggal_order), tanggal_order),
            tanggal_aktivasi = COALESCE(VALUES(tanggal_aktivasi), tanggal_aktivasi),
            no_rm = VALUES(no_rm),
            nama_pasien = VALUES(nama_pasien),
          tanggal_lahir = VALUES(tanggal_lahir),
          kelamin = VALUES(kelamin),
          alamat = VALUES(alamat),
          kecamatan = VALUES(kecamatan),
          kabupaten = VALUES(kabupaten),
            provinsi = VALUES(provinsi),
            kode_pos = VALUES(kode_pos),
            no_hp = VALUES(no_hp),
            no_register = VALUES(no_register),
            klinis = VALUES(klinis),
            diagnosa = VALUES(diagnosa),
            kode_pemeriksaan = VALUES(kode_pemeriksaan),
            nama_pemeriksaan = VALUES(nama_pemeriksaan),
            modality = VALUES(modality),
          cito = VALUES(cito),
          polirawat = VALUES(polirawat),
          kode_ruangan = VALUES(kode_ruangan),
          nama_ruangan = VALUES(nama_ruangan),
          kode_dokter = VALUES(kode_dokter),
          nama_dokter = VALUES(nama_dokter),
          kode_admin = VALUES(kode_admin),
          nama_admin = VALUES(nama_admin),
          kode_dokter_radiolog = VALUES(kode_dokter_radiolog),
          nama_radiolog = VALUES(nama_radiolog),
          kode_radiografer = VALUES(kode_radiografer),
          nama_radiografer = VALUES(nama_radiografer),
          cara_bayar = VALUES(cara_bayar),
          kode_asuransi = VALUES(kode_asuransi),
          nama_asuransi = VALUES(nama_asuransi),
          kode_instalasi_radiologi = VALUES(kode_instalasi_radiologi),
          nama_instalasi_radiologi = VALUES(nama_instalasi_radiologi),
          alasan = VALUES(alasan),
          update_ris = VALUES(update_ris),
          waktu_update_orderin = CURRENT_TIMESTAMP
        `,
        [
            payload.tanggal_order,
            payload.tanggal_aktivasi,
            payload.no_rm,
            payload.nama_pasien,
            payload.tanggal_lahir,
            payload.kelamin,
            payload.alamat,
            payload.kecamatan,
            payload.kabupaten,
            payload.provinsi,
            payload.kode_pos,
            payload.no_hp,
            payload.no_register,
            payload.no_rontgen,
            payload.klinis,
            payload.diagnosa,
            payload.kode_pemeriksaan,
            payload.nama_pemeriksaan,
            payload.modality,
            payload.cito,
            payload.polirawat,
            payload.kode_ruangan,
            payload.nama_ruangan,
            payload.kode_dokter,
            payload.nama_dokter,
            payload.kode_admin,
            payload.nama_admin,
            payload.kode_dokter_radiolog,
            payload.nama_radiolog,
            payload.kode_radiografer,
            payload.nama_radiografer,
            payload.cara_bayar,
            payload.kode_asuransi,
            payload.nama_asuransi,
            payload.kode_instalasi_radiologi,
            payload.nama_instalasi_radiologi,
            payload.alasan,
            payload.update_ris,
        ]
    );
    const [rows] = await pool.query('SELECT * FROM order_in WHERE no_rontgen = ?', [payload.no_rontgen]);
    return rows[0] || null;
}

async function upsertOrderInFromOrder(order, options = {}) {
    if (!order?.no_rontgen) return null;
    return upsertOrderInPayload(
        {
            tanggal_order: order.order_in_tanggal_order || order.tanggal_order || null,
            tanggal_aktivasi: order.order_in_tanggal_aktivasi || order.tanggal_aktivasi || null,
            no_rm: order.no_rm || null,
            nama_pasien: order.nama_pasien || null,
            tanggal_lahir: order.tanggal_lahir || null,
            kelamin: order.kelamin || null,
            alamat: order.alamat || null,
            kecamatan: order.kecamatan || null,
            kabupaten: order.kabupaten || null,
            provinsi: order.provinsi || null,
            kode_pos: order.kode_pos || null,
            no_hp: order.no_hp || null,
            no_register: order.no_register || null,
            no_rontgen: order.no_rontgen,
            klinis: order.klinis || null,
            diagnosa: order.diagnosa || null,
            kode_pemeriksaan: order.kode_pemeriksaan || order.procedure_code || order.study_master_procedure_code || null,
            nama_pemeriksaan: order.nama_pemeriksaan || order.procedure_desc || order.study_master_description || null,
            modality: order.modality || order.study_master_modality_code || null,
            cito: order.cito || null,
            polirawat: order.polirawat || null,
            kode_ruangan: order.kode_ruangan || null,
            nama_ruangan: order.nama_ruangan || null,
            kode_dokter: order.kode_dokter || order.referring_doctor_code || null,
            nama_dokter: order.nama_dokter || order.referring_doctor_name || order.referring_physician || null,
            kode_admin: order.kode_admin || null,
            nama_admin: order.nama_admin || null,
            kode_dokter_radiolog: order.kode_dokter_radiolog || order.radiologist_doctor_code || null,
            nama_radiolog: order.nama_radiolog || order.radiologist_doctor_name || null,
            kode_radiografer: order.kode_radiografer || order.technologist_username || null,
            nama_radiografer: order.nama_radiografer || order.technologist_name || null,
            cara_bayar: order.cara_bayar || null,
            kode_asuransi: order.kode_asuransi || null,
            nama_asuransi: order.nama_asuransi || null,
            kode_instalasi_radiologi: order.kode_instalasi_radiologi || null,
            nama_instalasi_radiologi: order.nama_instalasi_radiologi || null,
            update_ris: order.update_ris || 'N',
            referring_physician: order.referring_physician || null,
        },
        options
    );
}

async function upsertMwlOrderFromOrderIn({ orderIn, patientRecordId, studyMasterId = null, referringDoctorId = null, radiologistDoctorId = null, referringPhysician = null }) {
    if (!orderIn?.no_rontgen) return null;
    await ensureMwlTables();
    const noRontgen = String(orderIn.no_rontgen || '').trim();
    const accessionNumber = noRontgen;
    const tanggalOrder = normalizeDateTime(orderIn.tanggal_order) || normalizeDateTime(new Date().toISOString());
    const tanggalAktivasi = normalizeDateTime(orderIn.tanggal_aktivasi);
    const modality = normalizeModality(orderIn.modality);
    const procedureCode = String(orderIn.kode_pemeriksaan || '').trim() || null;
    const procedureDesc = String(orderIn.nama_pemeriksaan || '').trim() || null;
    const klinis = String(orderIn.klinis || '').trim() || null;
    const diagnosa = String(orderIn.diagnosa || '').trim() || null;
    const cito = normalizeCito(orderIn.cito);
    const polirawat = String(orderIn.polirawat || '').trim() || null;
    const kodeRuangan = String(orderIn.kode_ruangan || '').trim() || null;
    const namaRuangan = String(orderIn.nama_ruangan || '').trim() || null;
    const noRegister = String(orderIn.no_register || '').trim() || null;
    const caraBayar = String(orderIn.cara_bayar || '').trim() || null;
    const kodeAsuransi = String(orderIn.kode_asuransi || '').trim() || null;
    const namaAsuransi = String(orderIn.nama_asuransi || '').trim() || null;
    const kodeInstalasiRadiologi = String(orderIn.kode_instalasi_radiologi || '').trim() || null;
    const namaInstalasiRadiologi = String(orderIn.nama_instalasi_radiologi || '').trim() || null;
    const updateRisRaw = String(orderIn.update_ris || '').trim().toUpperCase();
    const updateRis = updateRisRaw === 'Y' || updateRisRaw === 'C' ? updateRisRaw : 'N';
    const resolvedReferringPhysician = String(referringPhysician || orderIn.nama_dokter || '').trim() || null;
    const resolvedKodeDokter = String(orderIn.kode_dokter || '').trim() || null;
    const resolvedNamaDokter = String(orderIn.nama_dokter || '').trim() || null;
    const resolvedKodeDokterRadiolog = String(orderIn.kode_dokter_radiolog || '').trim() || null;
    const resolvedNamaRadiolog = String(orderIn.nama_radiolog || '').trim() || null;
    const resolvedKodeRadiografer = String(orderIn.kode_radiografer || '').trim() || null;
    const resolvedNamaRadiografer = String(orderIn.nama_radiografer || '').trim() || null;

    const [existingRows] = await pool.query(
        `
        SELECT id, study_instance_uid, status, study_date, study_time
        FROM mwl_orders
        WHERE no_rontgen = ? OR accession_number = ?
        ORDER BY CASE WHEN no_rontgen = ? THEN 0 ELSE 1 END, id DESC
        LIMIT 1
        `,
        [noRontgen, accessionNumber, noRontgen]
    );
    const existingOrder = existingRows[0] || null;
    const [dupAccessionRows] = existingOrder
        ? await pool.query(
            'SELECT id FROM mwl_orders WHERE accession_number = ? AND id <> ?',
            [accessionNumber, existingOrder.id]
        )
        : await pool.query('SELECT id FROM mwl_orders WHERE accession_number = ?', [accessionNumber]);
    if (dupAccessionRows.length) {
        const error = new Error('Accession number already exists');
        error.status = 409;
        throw error;
    }
    const [dupNoRontgenRows] = existingOrder
        ? await pool.query(
            'SELECT id FROM mwl_orders WHERE no_rontgen = ? AND id <> ?',
            [noRontgen, existingOrder.id]
        )
        : await pool.query('SELECT id FROM mwl_orders WHERE no_rontgen = ?', [noRontgen]);
    if (dupNoRontgenRows.length) {
        const error = new Error('No rontgen already exists');
        error.status = 409;
        throw error;
    }

    if (existingOrder) {
        const studyDate = existingOrder.study_date || null;
        const studyTime = existingOrder.study_time || null;
        await pool.query(
            `
            UPDATE mwl_orders
            SET patient_record_id = ?, accession_number = ?, no_register = ?, no_rontgen = ?, tanggal_order = ?, tanggal_aktivasi = ?, study_date = ?, study_time = ?, modality = ?, cito = ?, polirawat = ?, kode_ruangan = ?, nama_ruangan = ?, procedure_code = ?, procedure_desc = ?, klinis = ?, diagnosa = ?, kode_pemeriksaan = ?, nama_pemeriksaan = ?, kode_dokter = ?, nama_dokter = ?, kode_dokter_radiolog = ?, nama_radiolog = ?, kode_radiografer = ?, nama_radiografer = ?, cara_bayar = ?, kode_asuransi = ?, nama_asuransi = ?, kode_instalasi_radiologi = ?, nama_instalasi_radiologi = ?, update_ris = ?, referring_physician = ?
            WHERE id = ?
            `,
            [
                patientRecordId,
                accessionNumber,
                noRegister,
                noRontgen,
                tanggalOrder,
                tanggalAktivasi,
                studyDate,
                studyTime,
                modality,
                cito,
                polirawat,
                kodeRuangan,
                namaRuangan,
                procedureCode,
                procedureDesc,
                klinis,
                diagnosa,
                procedureCode,
                procedureDesc,
                resolvedKodeDokter,
                resolvedNamaDokter,
                resolvedKodeDokterRadiolog,
                resolvedNamaRadiolog,
                resolvedKodeRadiografer,
                resolvedNamaRadiografer,
                caraBayar,
                kodeAsuransi,
                namaAsuransi,
                kodeInstalasiRadiologi,
                namaInstalasiRadiologi,
                updateRis,
                resolvedReferringPhysician,
                existingOrder.id,
            ]
        );
        return { id: existingOrder.id, created: false };
    }

    const studyInstanceUid = generateStudyInstanceUid();
    const [dupStudyRows] = await pool.query('SELECT id FROM mwl_orders WHERE study_instance_uid = ?', [studyInstanceUid]);
    if (dupStudyRows.length) {
        const error = new Error('Generated StudyInstanceUID collided, retry request');
        error.status = 409;
        throw error;
    }
    const studyDate = null;
    const studyTime = null;
    const [result] = await pool.query(
        `
        INSERT INTO mwl_orders (
            patient_record_id,
            accession_number,
            no_register,
            no_rontgen,
            study_instance_uid,
            tanggal_order,
            tanggal_aktivasi,
            study_date,
            study_time,
            modality,
            cito,
            polirawat,
            kode_ruangan,
            nama_ruangan,
            procedure_code,
            procedure_desc,
            klinis,
            diagnosa,
            kode_pemeriksaan,
            nama_pemeriksaan,
            kode_dokter,
            nama_dokter,
            kode_dokter_radiolog,
            nama_radiolog,
            kode_radiografer,
            nama_radiografer,
            cara_bayar,
            kode_asuransi,
            nama_asuransi,
            kode_instalasi_radiologi,
            nama_instalasi_radiologi,
            update_ris,
            referring_physician
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
            patientRecordId,
            accessionNumber,
            noRegister,
            noRontgen,
            studyInstanceUid,
            tanggalOrder,
            tanggalAktivasi,
            studyDate,
            studyTime,
            modality,
            cito,
            polirawat,
            kodeRuangan,
            namaRuangan,
            procedureCode,
            procedureDesc,
            klinis,
            diagnosa,
            procedureCode,
            procedureDesc,
            resolvedKodeDokter,
            resolvedNamaDokter,
            resolvedKodeDokterRadiolog,
            resolvedNamaRadiolog,
            resolvedKodeRadiografer,
            resolvedNamaRadiografer,
            caraBayar,
            kodeAsuransi,
            namaAsuransi,
            kodeInstalasiRadiologi,
            namaInstalasiRadiologi,
            updateRis,
            resolvedReferringPhysician,
        ]
    );
    return { id: result.insertId, created: true };
}

async function syncOrderInForOrder(options = {}) {
    const order = await loadOrderOutSource(options);
    if (!order) return null;
    return upsertOrderInFromOrder(order, options);
}

async function backfillOrderInFromMwl(limit = 2000) {
    await ensureOrderInTable();
    const [rows] = await pool.query(
        `
        SELECT id
        FROM mwl_orders
        WHERE no_rontgen IS NOT NULL AND no_rontgen <> ''
        ORDER BY id DESC
        LIMIT ?
        `,
        [limit]
    );
    for (const row of rows) {
        try {
            await syncOrderInForOrder({ orderId: row.id });
        } catch (err) {
            console.warn(`Failed to backfill order_in for order ${row.id}:`, err.message);
        }
    }
    return rows.length;
}

async function upsertOrderOutFromOrderSource(order, options = {}) {
    if (!order?.no_rontgen) return null;
    await ensureOrderOutTable();
    const effectiveStudyInstanceUid = order.actual_study_instance_uid || order.study_instance_uid || null;
    let hasPacsImages = false;
    if (effectiveStudyInstanceUid) {
        try {
            hasPacsImages = (await dicomwebPacs.getStudyInstanceCount(effectiveStudyInstanceUid)) > 0;
        } catch (err) {
            hasPacsImages = false;
        }
    }
    let assignedStaff = [];
    try {
        const parsedAssigned = parseJsonValue(order.assigned_staff_json, []);
        assignedStaff = Array.isArray(parsedAssigned) ? parsedAssigned : [];
    } catch (error) {
        assignedStaff = [];
    }
    const assignedRadiologist = assignedStaff.find(item => item?.role === 'RADIOLOGIST');
    const assignedTechnologists = assignedStaff.filter(item => item?.role === 'TECHNOLOGIST');
    const [reportRows] = await pool.query(
        `
        SELECT r.*, u.name AS radiologist_name
        FROM radiology_reports r
        LEFT JOIN users u ON u.id = r.radiologist_id
        WHERE r.study_instance_uid = ?
        LIMIT 1
        `,
        [effectiveStudyInstanceUid]
    );
    const report = reportRows[0] || null;
    const share = effectiveStudyInstanceUid ? await getLatestPublicShareLinkForStudy(effectiveStudyInstanceUid, options.req || null) : null;
    const [existingRows] = await pool.query('SELECT * FROM order_out WHERE no_rontgen = ? LIMIT 1', [order.no_rontgen]);
    const existing = existingRows[0] || null;
    const appLinkSettings = readAppLinkSettings();
    const publicBaseUrl = appLinkSettings.publicBaseUrl;
    const needsViewerAccessLink = Object.values(appLinkSettings.orderOutLinks || {}).some(rule => rule?.enabled && rule.type === 'viewer');
    const viewerAccessLink =
        needsViewerAccessLink && (order.status === 'COMPLETED' || hasPacsImages) && order.accession_number
            ? await getOrCreateViewerAccessLinkForAccession(
                  order.accession_number,
                  effectiveStudyInstanceUid,
                  options.req || null,
                  order.kode_dokter_radiolog || order.kode_admin || null
              )
            : null;
    const orderOutLinks = buildOrderOutLinks({
        order,
        appLinkSettings,
        publicBaseUrl,
        viewerAccessLink,
        share,
        existing,
    });
    const payload = {
        no_rm: order.no_rm || existing?.no_rm || null,
        no_rontgen: order.no_rontgen,
        no_register: order.no_register || existing?.no_register || null,
        kode_user_admin: order.kode_admin || existing?.kode_user_admin || null,
        nama_user_admin: order.nama_admin || existing?.nama_user_admin || null,
        admin_datetime_start: toNullableDateTime(order.tanggal_order || existing?.admin_datetime_start || null),
        admin_datetime_end: toNullableDateTime(order.tanggal_aktivasi || order.waktu_update_orderin || existing?.admin_datetime_end || null),
        kode_radiografer: order.kode_radiografer || assignedTechnologists[0]?.kode_dokter || existing?.kode_radiografer || null,
        nama_radiografer:
            order.nama_radiografer ||
            assignedTechnologists.map(item => item?.nama_dokter).filter(Boolean).join(', ') ||
            order.technologist_name ||
            existing?.nama_radiografer ||
            null,
        radiografer_datetime_start: toNullableDateTime(order.radiografer_datetime_start || existing?.radiografer_datetime_start || null),
        radiografer_datetime_end: toNullableDateTime(order.radiografer_datetime_end || existing?.radiografer_datetime_end || null),
        kode_radiolog:
            order.kode_dokter_radiolog || assignedRadiologist?.kode_dokter || order.radiologist_doctor_code || existing?.kode_radiolog || null,
        nama_radiolog:
            order.nama_radiolog || assignedRadiologist?.nama_dokter || report?.radiologist_name || order.radiologist_doctor_name || existing?.nama_radiolog || null,
        radiolog_datetime_start: toNullableDateTime(report?.created_at || existing?.radiolog_datetime_start || null),
        radiolog_datetime_end: toNullableDateTime(report?.finalized_at || report?.updated_at || existing?.radiolog_datetime_end || null),
        klinis: String(order.klinis || existing?.klinis || '').trim().slice(0, 15) || null,
        cito: normalizeCito(order.cito ?? existing?.cito ?? '0') || '0',
        kritis: String(report?.kritis ?? existing?.kritis ?? '0') === '1' ? '1' : '0',
        expertise_text_finding: toPlainTextReport(report?.findings) ?? existing?.expertise_text_finding ?? null,
        expertise_text_conclusion: toPlainTextReport(report?.conclusion) ?? existing?.expertise_text_conclusion ?? null,
        expertise_html_finding: toHtmlParagraphs(report?.findings) ?? existing?.expertise_html_finding ?? null,
        expertise_html_conclusion: toHtmlParagraphs(report?.conclusion) ?? existing?.expertise_html_conclusion ?? null,
        urllink1: orderOutLinks.urllink1,
        urllink2: orderOutLinks.urllink2,
        urllink3: orderOutLinks.urllink3,
        urllink4: orderOutLinks.urllink4,
        urllink5: orderOutLinks.urllink5,
        urllink6: orderOutLinks.urllink6,
        alasan: existing?.alasan || null,
        update_ris: existing?.update_ris || 'N',
    };

    await pool.query(
        `
        INSERT INTO order_out (
          no_rm, no_rontgen, no_register, kode_user_admin, nama_user_admin,
          admin_datetime_start, admin_datetime_end, kode_radiografer, nama_radiografer,
          radiografer_datetime_start, radiografer_datetime_end, kode_radiolog, nama_radiolog,
          radiolog_datetime_start, radiolog_datetime_end, klinis, cito, kritis,
          expertise_text_finding, expertise_text_conclusion, expertise_html_finding, expertise_html_conclusion,
          urllink1, urllink2, urllink3, urllink4, urllink5, urllink6, alasan, update_ris
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          no_rm = VALUES(no_rm),
          no_register = VALUES(no_register),
          kode_user_admin = VALUES(kode_user_admin),
          nama_user_admin = VALUES(nama_user_admin),
          admin_datetime_start = VALUES(admin_datetime_start),
          admin_datetime_end = VALUES(admin_datetime_end),
          kode_radiografer = VALUES(kode_radiografer),
          nama_radiografer = VALUES(nama_radiografer),
          radiografer_datetime_start = VALUES(radiografer_datetime_start),
          radiografer_datetime_end = VALUES(radiografer_datetime_end),
          kode_radiolog = VALUES(kode_radiolog),
          nama_radiolog = VALUES(nama_radiolog),
          radiolog_datetime_start = VALUES(radiolog_datetime_start),
          radiolog_datetime_end = VALUES(radiolog_datetime_end),
          klinis = VALUES(klinis),
          cito = VALUES(cito),
          kritis = VALUES(kritis),
          expertise_text_finding = VALUES(expertise_text_finding),
          expertise_text_conclusion = VALUES(expertise_text_conclusion),
          expertise_html_finding = VALUES(expertise_html_finding),
          expertise_html_conclusion = VALUES(expertise_html_conclusion),
          urllink1 = VALUES(urllink1),
          urllink2 = VALUES(urllink2),
          urllink3 = VALUES(urllink3),
          urllink4 = VALUES(urllink4),
          urllink5 = VALUES(urllink5),
          urllink6 = VALUES(urllink6),
          alasan = VALUES(alasan),
          update_ris = VALUES(update_ris),
          waktu_update_orderout = CURRENT_TIMESTAMP
        `,
        [
            payload.no_rm,
            payload.no_rontgen,
            payload.no_register,
            payload.kode_user_admin,
            payload.nama_user_admin,
            payload.admin_datetime_start,
            payload.admin_datetime_end,
            payload.kode_radiografer,
            payload.nama_radiografer,
            payload.radiografer_datetime_start,
            payload.radiografer_datetime_end,
            payload.kode_radiolog,
            payload.nama_radiolog,
            payload.radiolog_datetime_start,
            payload.radiolog_datetime_end,
            payload.klinis,
            payload.cito,
            payload.kritis,
            payload.expertise_text_finding,
            payload.expertise_text_conclusion,
            payload.expertise_html_finding,
            payload.expertise_html_conclusion,
            payload.urllink1,
            payload.urllink2,
            payload.urllink3,
            payload.urllink4,
            payload.urllink5,
            payload.urllink6,
            payload.alasan,
            payload.update_ris,
        ]
    );
    const [rows] = await pool.query('SELECT * FROM order_out WHERE no_rontgen = ?', [order.no_rontgen]);
    return { order_out: rows[0] || null, report_status: report?.status || null, assigned_staff: assignedStaff };
}

async function syncOrderOutForOrder(options = {}) {
    const order = await loadOrderOutSource(options);
    if (!order) return null;
    return upsertOrderOutFromOrderSource(order, options);
}

// === Authentication ===

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await pool.query(
            'SELECT id, username, name, role, theme FROM users WHERE username = ? AND password = ?',
            [username, password]
        );

        if (rows.length > 0) {
            const permissions = await getRolePermissions(rows[0].role);
            const defaultLandingPage = await getRoleLandingPage(rows[0].role, permissions);
            await writeAuditLog(req, {
                eventType: 'login',
                outcome: 'success',
                username: rows[0].username,
                role: rows[0].role,
                targetType: 'user',
                targetId: rows[0].username,
            });
            res.json({
                success: true,
                user: {
                    username: rows[0].username,
                    role: rows[0].role,
                    fullName: rows[0].name,
                    theme: rows[0].theme || 'light',
                    permissions,
                    defaultLandingPage,
                }
            });
        } else {
            await writeAuditLog(req, {
                eventType: 'login',
                outcome: 'failure',
                username,
                targetType: 'user',
                targetId: username,
                details: { reason: 'invalid_credentials' },
            });
            res.status(401).json({ success: false, message: 'Invalid username or password' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Google OAuth Login
app.post('/api/auth/google', async (req, res) => {
    const { idToken } = req.body;
    if (!idToken || typeof idToken !== 'string') {
        return res.status(400).json({ success: false, message: 'ID token is required' });
    }
    try {
        const { OAuth2Client } = require('google-auth-library');
        const googleClientId = process.env.GOOGLE_CLIENT_ID;
        if (!googleClientId) {
            console.error('Google OAuth: GOOGLE_CLIENT_ID is not configured');
            return res.status(500).json({ success: false, message: 'Google OAuth is not configured' });
        }
        const client = new OAuth2Client(googleClientId);
        const ticket = await client.verifyIdToken({
            idToken,
            audience: googleClientId,
        });
        const payload = ticket.getPayload();
        if (!payload || !payload.sub || !payload.email) {
            return res.status(401).json({ success: false, message: 'Invalid Google token payload' });
        }
        const googleId = payload.sub;
        const email = payload.email;
        const name = payload.name || email;

        // Cari user berdasarkan google_id atau email
        const [rows] = await pool.query(
            'SELECT id, username, name, role, theme, email, google_id FROM users WHERE google_id = ? OR email = ?',
            [googleId, email]
        );

        let user;
        if (rows.length > 0) {
            user = rows[0];
            // Update google_id jika user ditemukan via email tapi belum punya google_id
            if (!user.google_id) {
                await pool.query(
                    'UPDATE users SET google_id = ? WHERE id = ?',
                    [googleId, user.id]
                );
            }
            // Update email jika belum terisi
            if (!user.email) {
                await pool.query(
                    'UPDATE users SET email = ? WHERE id = ?',
                    [email, user.id]
                );
            }
        } else {
            return res.status(401).json({ success: false, message: 'This email is not registered in the system. Please contact your administrator.' });
        }

        const permissions = await getRolePermissions(user.role);
        const defaultLandingPage = await getRoleLandingPage(user.role, permissions);
        await writeAuditLog(req, {
            eventType: 'login',
            outcome: 'success',
            username: user.username,
            role: user.role,
            targetType: 'user',
            targetId: user.username,
            details: { method: 'google' },
        });
        res.json({
            success: true,
            user: {
                username: user.username,
                role: user.role,
                fullName: user.name,
                theme: user.theme || 'light',
                permissions,
                defaultLandingPage,
            },
        });
    } catch (err) {
        console.error('[Google OAuth] Error:', err.message);
        await writeAuditLog(req, {
            eventType: 'login',
            outcome: 'failure',
            username: 'google-unknown',
            targetType: 'user',
            targetId: 'google-unknown',
            details: { method: 'google', error: err.message },
        });
        res.status(401).json({ success: false, message: 'Google authentication failed: ' + err.message });
    }
});
const toOptionalPositiveInt = value => {
    if (value === undefined || value === null || value === '') return null;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return numeric;
};

const syncRadiologistAssignmentForStudy = async ({ studyInstanceUid, radiologistDoctorId, radiologistDoctorCode = null, assignedBy, db }) => {
    const query = db && typeof db.query === 'function' ? db.query.bind(db) : pool.query.bind(pool);
    const uid = String(studyInstanceUid || '').trim();
    if (!uid) return;
    await ensureRadiologistAssignmentTable();
    const doctorId = toOptionalPositiveInt(radiologistDoctorId);
    const doctorCode = String(radiologistDoctorCode || '').trim() || null;
    if (!doctorId && !doctorCode) {
        await query('DELETE FROM radiologist_assignments WHERE study_instance_uid = ?', [uid]);
        return;
    }
    const [doctorRows] = await query(
        doctorId
            ? 'SELECT user_id FROM mwl_doctors WHERE id = ? AND role = "RADIOLOGIST"'
            : 'SELECT user_id FROM mwl_doctors WHERE kode_dokter = ? AND role = "RADIOLOGIST"',
        [doctorId || doctorCode]
    );
    const radiologistUserId = toOptionalPositiveInt(doctorRows?.[0]?.user_id);
    if (!radiologistUserId) {
        await query('DELETE FROM radiologist_assignments WHERE study_instance_uid = ?', [uid]);
        return;
    }
    await query(
        `
        INSERT INTO radiologist_assignments (study_instance_uid, radiologist_id, assigned_by, assigned_at)
        VALUES (?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          radiologist_id = VALUES(radiologist_id),
          assigned_by = VALUES(assigned_by),
          assigned_at = NOW()
        `,
        [uid, radiologistUserId, assignedBy || null]
    );
};

const syncRadiologistAssignmentsForDoctor = async ({ radiologistDoctorId, radiologistDoctorCode = null, radiologistUserId, assignedBy, db }) => {
    const query = db && typeof db.query === 'function' ? db.query.bind(db) : pool.query.bind(pool);
    const doctorId = toOptionalPositiveInt(radiologistDoctorId);
    let doctorCode = String(radiologistDoctorCode || '').trim() || null;
    if (!doctorCode && doctorId) {
        const [doctorRows] = await query('SELECT kode_dokter FROM mwl_doctors WHERE id = ? LIMIT 1', [doctorId]);
        doctorCode = String(doctorRows?.[0]?.kode_dokter || '').trim() || null;
    }
    if (!doctorId && !doctorCode) return;
    await ensureRadiologistAssignmentTable();
    if (!toOptionalPositiveInt(radiologistUserId)) {
        await query(
            `
            DELETE ra
            FROM radiologist_assignments ra
            INNER JOIN mwl_orders o ON o.study_instance_uid = ra.study_instance_uid
            WHERE o.kode_dokter_radiolog = ?
            `,
            [doctorCode]
        );
        return;
    }
    await query(
        `
        INSERT INTO radiologist_assignments (study_instance_uid, radiologist_id, assigned_by, assigned_at)
        SELECT DISTINCT o.study_instance_uid, CAST(? AS INTEGER), CAST(? AS VARCHAR), NOW()
        FROM mwl_orders o
        WHERE o.kode_dokter_radiolog = ?
          AND o.study_instance_uid IS NOT NULL
          AND o.study_instance_uid <> ''
          AND o.status <> 'CANCELLED'
        ON DUPLICATE KEY UPDATE
          radiologist_id = VALUES(radiologist_id),
          assigned_by = VALUES(assigned_by),
          assigned_at = NOW()
        `,
        [radiologistUserId, assignedBy || null, doctorCode || null]
    );
};

const resolveRadiologistUserId = async ({ radiologistId = null, radiologistUsername = null, db } = {}) => {
    const query = db && typeof db.query === 'function' ? db.query.bind(db) : pool.query.bind(pool);
    const numericId = toOptionalPositiveInt(radiologistId);
    if (numericId) {
        return numericId;
    }
    const username = String(radiologistUsername || '').trim();
    if (!username) return null;
    const [userRows] = await query('SELECT id FROM users WHERE username = ?', [username]);
    return toOptionalPositiveInt(userRows?.[0]?.id);
};

const resolveLinkedRadiologistDoctorByUserId = async ({ userId, db } = {}) => {
    const query = db && typeof db.query === 'function' ? db.query.bind(db) : pool.query.bind(pool);
    const numericId = toOptionalPositiveInt(userId);
    if (!numericId) return null;
    const [rows] = await query(
        `
        SELECT id, kode_dokter, nama_dokter
        FROM mwl_doctors
        WHERE user_id = ?
          AND role = 'RADIOLOGIST'
        LIMIT 1
        `,
        [numericId]
    );
    return rows[0] || null;
};

const assignRadiologistOwnershipForStudy = async ({ studyInstanceUid, radiologistUserId, assignedBy, db } = {}) => {
    const query = db && typeof db.query === 'function' ? db.query.bind(db) : pool.query.bind(pool);
    const uid = String(studyInstanceUid || '').trim();
    const numericUserId = toOptionalPositiveInt(radiologistUserId);
    if (!uid || !numericUserId) {
        throw new Error('studyInstanceUid and radiologistUserId are required');
    }
    await ensureRadiologistAssignmentTable();
    await ensureMwlTables();
    await query(
        `
        INSERT INTO radiologist_assignments (study_instance_uid, radiologist_id, assigned_by, assigned_at)
        VALUES (?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          radiologist_id = VALUES(radiologist_id),
          assigned_by = VALUES(assigned_by),
          assigned_at = VALUES(assigned_at)
        `,
        [uid, numericUserId, assignedBy || null]
    );

    const linkedDoctor = await resolveLinkedRadiologistDoctorByUserId({ userId: numericUserId, db });
    if (linkedDoctor?.id) {
        await query(
            `
            UPDATE mwl_orders
            SET kode_dokter_radiolog = ?,
                nama_radiolog = ?
            WHERE study_instance_uid = ?
            `,
            [linkedDoctor.kode_dokter || null, linkedDoctor.nama_dokter || null, uid]
        );
    }

    await query(
        `
        UPDATE radiology_reports
        SET radiologist_id = ?
        WHERE study_instance_uid = ?
        `,
        [numericUserId, uid]
    );

    const [rows] = await query(
        `
        SELECT ra.study_instance_uid, ra.radiologist_id, u.username AS radiologist_username, u.name AS radiologist_name
        FROM radiologist_assignments ra
        LEFT JOIN users u ON ra.radiologist_id = u.id
        WHERE ra.study_instance_uid = ?
        `,
        [uid]
    );
    return rows[0] || null;
};

// === User Management (CRUD) ===

app.get('/api/users', requirePermission('view_users'), async (req, res) => {
    try {
        await ensureMwlTables();
        const [rows] = await pool.query(
            `
            SELECT
              u.id,
              u.username,
              u.name,
              u.phone_number,
              u.usernamepacs,
              CASE WHEN u.passwordpacs IS NULL OR u.passwordpacs = '' THEN 0 ELSE 1 END AS has_passwordpacs,
              u.role,
              u.theme,
              u.created_at,
              d.id AS doctor_id,
              d.kode_dokter AS doctor_code,
              d.nama_dokter AS doctor_name
            FROM users u
            LEFT JOIN mwl_doctors d ON d.user_id = u.id
            ORDER BY u.created_at DESC, u.id DESC
            `
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/users', requirePermission('manage_users'), async (req, res) => {
    const body = req.body || {};
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const name = String(body.name || '').trim() || username;
    const phoneNumber = String(body.phoneNumber || '').trim() || null;
    const usernamePacs = normalizeNullableString(body.usernamepacs, 100);
    const passwordPacs = encryptPacsCredential(body.passwordpacs);
    const role = normalizeUserRole(body.role || 'clinician');
    const doctorId = toOptionalPositiveInt(body.doctorId);
    if (!username || !password) {
        return res.status(400).json({ error: 'username and password are required' });
    }
    const roleDoctorGroup = await getRoleDoctorGroup(role);
    if (roleDoctorGroup && !doctorId) {
        return res.status(400).json({ error: `doctorId is required for role mapped to ${roleDoctorGroup}` });
    }
    const connection = await pool.getConnection();
    try {
        await ensureMwlTables();
        await connection.beginTransaction();
        if (roleDoctorGroup && doctorId) {
            const [doctorRows] = await connection.query(
                'SELECT id, role, user_id FROM mwl_doctors WHERE id = ?',
                [doctorId]
            );
            if (!doctorRows.length || doctorRows[0].role !== roleDoctorGroup) {
                await connection.rollback();
                return res.status(400).json({ error: `Selected doctor must belong to ${roleDoctorGroup}` });
            }
            if (doctorRows[0].user_id) {
                await connection.rollback();
                return res.status(409).json({ error: 'Selected doctor is already linked to another user' });
            }
        }
        const [result] = await connection.query(
            'INSERT INTO users (username, password, name, phone_number, usernamepacs, passwordpacs, role) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [username, password, name, phoneNumber, usernamePacs, passwordPacs, role]
        );
        if (roleDoctorGroup && doctorId) {
            await connection.query('UPDATE mwl_doctors SET user_id = ? WHERE id = ?', [result.insertId, doctorId]);
            if (roleDoctorGroup === 'RADIOLOGIST') {
                await syncRadiologistAssignmentsForDoctor({
                    radiologistDoctorId: doctorId,
                    radiologistUserId: result.insertId,
                    assignedBy: username,
                    db: connection,
                });
            }
        }
        await connection.commit();
        res.json({ id: result.insertId, message: 'User created' });
    } catch (err) {
        try {
            await connection.rollback();
        } catch (rollbackErr) {}
        res.status(500).json({ error: err.message });
    } finally {
        connection.release();
    }
});

app.post('/api/users/change-password', requirePermission('change_password'), async (req, res) => {
    const { username, currentPassword, newPassword } = req.body;
    if (!username || !currentPassword || !newPassword) {
        res.status(400).send('Missing required fields');
        return;
    }
    try {
        const [rows] = await pool.query(
            'SELECT id FROM users WHERE username = ? AND password = ?',
            [username, currentPassword]
        );
        if (rows.length === 0) {
            res.status(401).send('Current password is incorrect');
            return;
        }
        await pool.query('UPDATE users SET password = ? WHERE username = ?', [newPassword, username]);
        res.json({ message: 'Password updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/users/theme', requireAnyPermission('change_password', 'view_dose_monitor', 'view_dose_report', 'view_dose_idrl'), async (req, res) => {
    const { username, theme } = req.body || {};
    const normalizedTheme = theme === 'dark' ? 'dark' : 'light';
    if (!username || typeof username !== 'string') {
        res.status(400).json({ error: 'Username is required' });
        return;
    }
    try {
        const [result] = await pool.query(
            'UPDATE users SET theme = ? WHERE username = ?',
            [normalizedTheme, username]
        );
        if (result.affectedRows === 0) {
            res.status(404).json({ error: 'User not found' });
            return;
        }
        res.json({ message: 'Theme updated', theme: normalizedTheme });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// === User Preferences API ===

app.get('/api/user/preferences', async (req, res) => {
    try {
        const username = getUsernameFromRequest(req);
        if (!username) {
            return res.status(400).json({ error: 'User not identified' });
        }
        const [rows] = await pool.query('SELECT preferences FROM users WHERE username = ?', [username]);
        if (!rows.length) {
            return res.json({ preferences: {} });
        }
        let preferences = {};
        if (rows[0].preferences) {
            try { preferences = JSON.parse(rows[0].preferences); } catch {}
        }
        res.json({ preferences });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/user/preferences', async (req, res) => {
    try {
        const username = getUsernameFromRequest(req);
        if (!username) {
            return res.status(400).json({ error: 'User not identified' });
        }
        const newPrefs = (req.body && req.body.preferences) || {};
        const [rows] = await pool.query('SELECT preferences FROM users WHERE username = ?', [username]);
        if (!rows.length) {
            return res.status(404).json({ error: 'User not found' });
        }
        let existing = {};
        if (rows[0].preferences) {
            try { existing = JSON.parse(rows[0].preferences); } catch {}
        }
        const merged = { ...existing, ...newPrefs };
        await pool.query('UPDATE users SET preferences = ? WHERE username = ?', [JSON.stringify(merged), username]);
        res.json({ preferences: merged });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/users/:id', requirePermission('manage_users'), async (req, res) => {
    const body = req.body || {};
    const userId = Number(req.params.id);
    const username = String(body.username || '').trim();
    const name = String(body.name || '').trim() || username;
    const phoneNumber = String(body.phoneNumber || '').trim() || null;
    const usernamePacs = normalizeNullableString(body.usernamepacs, 100);
    const shouldUpdatePacsPassword = Object.prototype.hasOwnProperty.call(body, 'passwordpacs');
    const passwordPacs = shouldUpdatePacsPassword ? encryptPacsCredential(body.passwordpacs) : undefined;
    const role = normalizeUserRole(body.role || 'clinician');
    const password = typeof body.password === 'string' ? body.password : '';
    const doctorId = toOptionalPositiveInt(body.doctorId);
    if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(400).json({ error: 'Invalid user id' });
    }
    if (!username) {
        return res.status(400).json({ error: 'username is required' });
    }
    const roleDoctorGroup = await getRoleDoctorGroup(role);
    if (roleDoctorGroup && !doctorId) {
        return res.status(400).json({ error: `doctorId is required for role mapped to ${roleDoctorGroup}` });
    }
    const connection = await pool.getConnection();
    try {
        await ensureMwlTables();
        await connection.beginTransaction();
        const [currentUserRows] = await connection.query(
            'SELECT id, username, role FROM users WHERE id = ? LIMIT 1',
            [userId]
        );
        if (!currentUserRows.length) {
            await connection.rollback();
            return res.status(404).json({ error: 'User not found' });
        }
        const [linkedDoctorRows] = await connection.query(
            'SELECT id FROM mwl_doctors WHERE user_id = ? LIMIT 1',
            [userId]
        );
        const prevDoctorId = toOptionalPositiveInt(linkedDoctorRows?.[0]?.id);
        if (roleDoctorGroup && doctorId) {
            const [doctorRows] = await connection.query(
                'SELECT id, role, user_id FROM mwl_doctors WHERE id = ?',
                [doctorId]
            );
            if (!doctorRows.length || doctorRows[0].role !== roleDoctorGroup) {
                await connection.rollback();
                return res.status(400).json({ error: `Selected doctor must belong to ${roleDoctorGroup}` });
            }
            if (doctorRows[0].user_id && Number(doctorRows[0].user_id) !== userId) {
                await connection.rollback();
                return res.status(409).json({ error: 'Selected doctor is already linked to another user' });
            }
        }
        if (password && password.trim() !== "") {
            const query = shouldUpdatePacsPassword
                ? 'UPDATE users SET username = ?, name = ?, phone_number = ?, usernamepacs = ?, passwordpacs = ?, role = ?, password = ? WHERE id = ?'
                : 'UPDATE users SET username = ?, name = ?, phone_number = ?, usernamepacs = ?, role = ?, password = ? WHERE id = ?';
            const params = shouldUpdatePacsPassword
                ? [username, name, phoneNumber, usernamePacs, passwordPacs, role, password, userId]
                : [username, name, phoneNumber, usernamePacs, role, password, userId];
            await connection.query(query, params);
        } else {
            const query = shouldUpdatePacsPassword
                ? 'UPDATE users SET username = ?, name = ?, phone_number = ?, usernamepacs = ?, passwordpacs = ?, role = ? WHERE id = ?'
                : 'UPDATE users SET username = ?, name = ?, phone_number = ?, usernamepacs = ?, role = ? WHERE id = ?';
            const params = shouldUpdatePacsPassword
                ? [username, name, phoneNumber, usernamePacs, passwordPacs, role, userId]
                : [username, name, phoneNumber, usernamePacs, role, userId];
            await connection.query(query, params);
        }
        if (prevDoctorId && (!roleDoctorGroup || prevDoctorId !== doctorId)) {
            await connection.query('UPDATE mwl_doctors SET user_id = NULL WHERE id = ? AND user_id = ?', [
                prevDoctorId,
                userId,
            ]);
            const [prevDoctorRows] = await connection.query(
                'SELECT role FROM mwl_doctors WHERE id = ? LIMIT 1',
                [prevDoctorId]
            );
            if (prevDoctorRows.length && prevDoctorRows[0].role === 'RADIOLOGIST') {
                await syncRadiologistAssignmentsForDoctor({
                    radiologistDoctorId: prevDoctorId,
                    radiologistUserId: null,
                    assignedBy: username,
                    db: connection,
                });
            }
        }
        if (roleDoctorGroup && doctorId) {
            await connection.query('UPDATE mwl_doctors SET user_id = ? WHERE id = ?', [userId, doctorId]);
            if (roleDoctorGroup === 'RADIOLOGIST') {
                await syncRadiologistAssignmentsForDoctor({
                    radiologistDoctorId: doctorId,
                    radiologistUserId: userId,
                    assignedBy: username,
                    db: connection,
                });
            }
        }
        await connection.commit();
        res.json({ message: 'User updated' });
    } catch (err) {
        try {
            await connection.rollback();
        } catch (rollbackErr) {}
        res.status(500).json({ error: err.message });
    } finally {
        connection.release();
    }
});

app.delete('/api/users/:id', requirePermission('manage_users'), async (req, res) => {
    const deleteReason = requireDeleteReason(req, res);
    if (!deleteReason) return;
    const userId = Number(req.params.id);
    if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(400).json({ error: 'Invalid user id' });
    }
    const connection = await pool.getConnection();
    try {
        await ensureMwlTables();
        await connection.beginTransaction();
        const [linkedDoctorRows] = await connection.query(
            'SELECT id FROM mwl_doctors WHERE user_id = ?',
            [userId]
        );
        for (const row of linkedDoctorRows) {
            await connection.query('UPDATE mwl_doctors SET user_id = NULL WHERE id = ?', [row.id]);
            await syncRadiologistAssignmentsForDoctor({
                radiologistDoctorId: row.id,
                radiologistUserId: null,
                assignedBy: null,
                db: connection,
            });
        }
        await connection.query('DELETE FROM radiologist_assignments WHERE radiologist_id = ?', [userId]);
        await connection.query('DELETE FROM users WHERE id = ?', [userId]);
        await connection.commit();
        await writeAuditLog(req, {
            eventType: 'delete_user',
            outcome: 'success',
            targetType: 'user',
            targetId: String(userId),
            details: { deleteReason },
        });
        res.json({ message: 'User deleted' });
    } catch (err) {
        try {
            await connection.rollback();
        } catch (rollbackErr) {}
        await writeAuditLog(req, {
            eventType: 'delete_user',
            outcome: 'failure',
            targetType: 'user',
            targetId: String(userId),
            details: { deleteReason, error: err.message || 'Failed to delete user' },
        });
        res.status(500).json({ error: err.message });
    } finally {
        connection.release();
    }
});

// === Role Permissions ===

app.get('/api/roles', requirePermission('manage_roles'), async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT rp.role, rp.permission, rdg.doctor_group, rs.default_landing_page
            FROM role_permissions rp
            LEFT JOIN role_doctor_groups rdg ON rdg.role = rp.role
            LEFT JOIN role_settings rs ON rs.role = rp.role
        `);
        const grouped = rows.reduce((acc, row) => {
            if (!acc[row.role]) acc[row.role] = [];
            acc[row.role].push(row.permission);
            return acc;
        }, {});
        const roleGroupMap = rows.reduce((acc, row) => {
            if (!(row.role in acc)) {
                acc[row.role] = row.doctor_group ? String(row.doctor_group).trim().toUpperCase() : null;
            }
            return acc;
        }, {});
        const roleLandingPageMap = rows.reduce((acc, row) => {
            if (!(row.role in acc)) {
                acc[row.role] = row.default_landing_page ? String(row.default_landing_page).trim() : null;
            }
            return acc;
        }, {});
        const payload = Object.entries(grouped).map(([role, permissions]) => ({
            role,
            permissions,
            doctor_group: roleGroupMap[role] || null,
            default_landing_page: resolveAllowedRoleLandingPage(
                role,
                permissions,
                roleLandingPageMap[role]
            ),
        }));
        res.json(payload);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/roles/:role', async (req, res) => {
    try {
        const role = normalizeUserRole(req.params.role);
        const permissions = await getRolePermissions(role);
        const doctorGroup = await getRoleDoctorGroup(role);
        const defaultLandingPage = await getRoleLandingPage(role, permissions);
        res.json({
            role,
            permissions,
            doctor_group: doctorGroup,
            default_landing_page: defaultLandingPage,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/roles/:role', requirePermission('manage_roles'), async (req, res) => {
    const { permissions, doctorGroup, defaultLandingPage } = req.body || {};
    if (!Array.isArray(permissions)) {
        res.status(400).json({ error: 'Invalid permissions payload' });
        return;
    }
    const role = normalizeUserRole(req.params.role);
    const filtered = Array.from(new Set(
        permissions.filter(p => typeof p === 'string' && p.trim()).map(permission => permission.trim())
    ));
    const normalizedDoctorGroup =
        doctorGroup == null || doctorGroup === '' ? null : normalizeMwlDoctorRole(doctorGroup);
    if (doctorGroup != null && doctorGroup !== '' && !normalizedDoctorGroup) {
        res.status(400).json({ error: 'Invalid doctor group' });
        return;
    }
    const requestedLandingPage = String(defaultLandingPage || '').trim();
    if (requestedLandingPage) {
        const requestedLandingOption = ROLE_LANDING_PAGE_OPTIONS.find(
            option => option.path === requestedLandingPage
        );
        if (!requestedLandingOption) {
            res.status(400).json({ error: 'Invalid default landing page' });
            return;
        }
        if (!filtered.includes(requestedLandingOption.permission)) {
            res.status(400).json({
                error: `Default landing page requires permission ${requestedLandingOption.permission}`,
            });
            return;
        }
    }
    const resolvedLandingPage = requestedLandingPage || await getRoleLandingPage(role, filtered);
    const safeLandingPage = resolveAllowedRoleLandingPage(role, filtered, resolvedLandingPage);
    if (!safeLandingPage) {
        res.status(400).json({ error: 'Select at least one page permission for this role' });
        return;
    }
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        await connection.query('DELETE FROM role_permissions WHERE role = ?', [role]);
        if (filtered.length > 0) {
            const inserts = filtered.map(permission => [role, permission]);
            await connection.query('INSERT INTO role_permissions (role, permission) VALUES ?', [inserts]);
        }
        await connection.query(
            `
            INSERT INTO role_doctor_groups (role, doctor_group)
            VALUES (?, ?)
            ON DUPLICATE KEY UPDATE doctor_group = VALUES(doctor_group)
            `,
            [role, normalizedDoctorGroup]
        );
        await connection.query(
            `
            INSERT INTO role_settings (role, default_landing_page)
            VALUES (?, ?)
            ON DUPLICATE KEY UPDATE default_landing_page = VALUES(default_landing_page)
            `,
            [role, safeLandingPage]
        );
        await connection.commit();
        rolePermissionCache.delete(req.params.role);
        rolePermissionCache.delete(role);
        roleDoctorGroupCache.delete(req.params.role);
        roleDoctorGroupCache.delete(role);
        roleLandingPageCache.delete(req.params.role);
        roleLandingPageCache.delete(role);
        res.json({
            message: 'Role permissions updated',
            default_landing_page: safeLandingPage,
        });
    } catch (err) {
        try {
            await connection.rollback();
        } catch (rollbackErr) {}
        res.status(500).json({ error: err.message });
    } finally {
        connection.release();
    }
});

// === Modality Worklist (MWL) ===

const dosePermissions = [
    'view_dose_monitor',
    'view_dose_report',
    'view_dose_idrl',
];

// Mesin aturan ekstraksi dose. Aturan boleh diubah di server tanpa build ulang:
// C:\ProgramData\VEXAPACS\dose-rules.json (atau env VEXA_DOSE_RULES_PATH).
// Default tertanam di src/services/doseRules.js, jadi file itu bersifat opsional.
const doseRuleEngine = require('./src/services/doseRules');

const DOSE_ADMIN_TAGS = [
    '00080020', '00080030', '00080050', '00080060', '00080070', '00081010', '00081030',
    '00100010', '00100020', '00100040', '00181000', '00181020', '00186000',
    '0020000D', '0020000E', '00200010',
];

// Dibaca ulang tiap request: mengubah dose-rules.json langsung berlaku tanpa
// restart service VexaRISBackend.
const loadDoseRuleState = () => {
    const state = doseRuleEngine.readDoseRules({ log: message => console.log(message) });
    if (state.warnings.length) {
        console.warn(`[dose-rules] ${state.path} (${state.source}): ${state.warnings.join(' | ')}`);
    }
    return state;
};

const countFilledDoseValues = values => Object.values(values || {})
    .filter(value => String(value ?? '').trim() !== '').length;

const mergeDoseValues = (target, incoming, mode = 'fill-empty') => {
    const merged = { ...(target || {}) };
    for (const [key, value] of Object.entries(incoming || {})) {
        if (String(value ?? '').trim() === '') continue;
        if (mode === 'replace' || String(merged[key] ?? '').trim() === '') merged[key] = value;
    }
    return merged;
};

const parseDoseJson = value => {
    if (!value) return {};
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch (_) {
        return {};
    }
};

const mapDoseReportRow = row => ({
    id: String(row.id),
    patientId: row.patient_id || '',
    patientName: row.patient_name || '',
    accessionNumber: row.accession_number || '',
    modalityCode: row.modality_code || '',
    studyDescription: row.study_description || '',
    studyDate: row.study_date || '',
    studyTime: row.study_time || '',
    sex: row.sex || 'M',
    birthDate: row.birth_date || '',
    cito: Boolean(row.cito),
    radiologist: row.radiologist || '',
    technologist: row.technologist || '',
    medicalPhysicist: row.medical_physicist || '',
    room: row.room || '',
    aeTitle: row.ae_title || '',
    studyInstanceUid: row.study_instance_uid || '',
    savedAt: row.saved_at ? new Date(row.saved_at).toISOString() : '',
    captureMode: row.capture_mode === 'auto' ? 'auto' : 'manual',
    values: parseDoseJson(row.values_json),
});

const mapDoseIdrlRow = row => ({
    id: String(row.id),
    modalityCode: row.modality_code || '',
    exam: row.exam || '',
    metric: row.metric || '',
    limit: row.dose_limit || '',
    unit: row.unit || '',
    bodyRegion: row.body_region || '',
    reference: row.reference_text || '',
    effectiveDate: row.effective_date || '',
});

const mapDoseIdrlStudyLinkRow = row => ({
    id: String(row.id),
    modalityCode: row.modality_code || '',
    idrlExam: row.idrl_exam || '',
    studyMasterId: Number(row.study_master_id),
    procedureCode: row.procedure_code || '',
    studyDescription: row.study_description || '',
});

// Helper DICOM JSON/SR dipindah ke src/services/dicomSr.js supaya flatten SR
// bisa diuji dengan file .dcm nyata tanpa menyalakan server/PACS.
const dicomSr = require('./src/services/dicomSr');
const {
    getDicomJsonValue,
    getDicomCodeMeaning,
    getDicomNumericMeasurement,
    pushDoseSrContent,
} = dicomSr;

const asDicomRows = value => Array.isArray(value) ? value : value ? [value] : [];

const getDicomNumberValue = element => {
    const raw = getDicomJsonValue(element).trim();
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
};

const formatDoseNumber = value => Number.isFinite(value) ? String(Number(value.toFixed(3))) : '';
const hasDoseValue = values => Object.values(values || {}).some(value => String(value ?? '').trim() !== '');

// Tag level teratas diprioritaskan; kalau tidak ada, cari ke dalam sequence
// (mis. CTDIvol Enhanced CT di dalam 0018,9321) lewat dicomSr.deepFindElement.
const firstDicomValue = (metadata, tags) => {
    for (const tag of tags) {
        const element = metadata?.[tag] || dicomSr.deepFindElement(metadata, tag);
        const value = getDicomJsonValue(element);
        if (value !== '') return value;
    }
    return '';
};

const firstDicomNumber = (metadata, tags) => {
    for (const tag of tags) {
        const element = metadata?.[tag] || dicomSr.deepFindElement(metadata, tag);
        const value = getDicomNumberValue(element);
        if (value !== null) return value;
    }
    return null;
};

// Kandidat lokasi .metadata-backups. Root dari konfigurasi dipakai lebih dulu,
// lalu lokasi lain yang masuk akal -- supaya fallback baca file .dcm tetap
// ketemu walaupun storagePath di .env/settings tidak sinkron dengan PACS
// (penyebab umum sesudah install: D:\...\DATA vs D:\...\PACS\DATA vs E:\VEXADATA).
const dicomBackupRoots = () => {
    const candidates = [
        String(dicomConfig.dicomweb.pacsStoragePath || ''),
        String(dicomConfig.dicomweb.pacsPackageRoot || process.env.DICOMWEB_PACS_PACKAGE_ROOT || '') && path.join(String(dicomConfig.dicomweb.pacsPackageRoot || process.env.DICOMWEB_PACS_PACKAGE_ROOT), 'DATA'),
        String(process.env.DICOM_STORAGE_PATH || ''),
        path.join(__dirname, '..', '..', 'DATA'),
        path.join(__dirname, '..', '..', 'PACS', 'DATA'),
    ];
    const roots = [];
    for (const candidate of candidates) {
        const root = String(candidate || '').trim();
        if (!root || roots.includes(root)) continue;
        try {
            if (fs.existsSync(path.join(root, '.metadata-backups'))) roots.push(root);
        } catch { /* folder tidak terbaca: lewati */ }
    }
    return roots;
};

const findDicomBackupFile = (sopInstanceUid, studyUid = '') => {
    const sop = String(sopInstanceUid || '').trim();
    if (!sop) return '';
    const preferredStudy = String(studyUid || '').trim();
    for (const root of dicomBackupRoots()) {
        const backupRoot = path.join(root, '.metadata-backups');
        const stack = preferredStudy && fs.existsSync(path.join(backupRoot, preferredStudy))
            ? [path.join(backupRoot, preferredStudy), backupRoot]
            : [backupRoot];
        const visited = new Set();
        while (stack.length) {
            const current = stack.pop();
            if (!current || visited.has(current)) continue;
            visited.add(current);
            let entries = [];
            try {
                entries = fs.readdirSync(current, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const entry of entries) {
                const fullPath = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    stack.push(fullPath);
                    continue;
                }
                if (entry.isFile() && entry.name.startsWith(`${sop}.`) && entry.name.toLowerCase().endsWith('.dcm')) {
                    return fullPath;
                }
            }
        }
    }
    return '';
};

const dicomParserTagKey = tag => `x${String(tag).toLowerCase()}`;

// Daftar tag yang dibaca dari file .dcm cadangan (dipakai kalau DICOMweb tidak
// menyediakan tag dose). Tag dose sendiri datang dari dose-rules.json, jadi
// menambah tag vendor = edit JSON, bukan edit file ini.
const readDicomFileMetadata = (filePath, extraTags = []) => {
    if (!filePath) return null;
    try {
        const dataSet = dicomParser.parseDicom(fs.readFileSync(filePath));
        const metadata = {};
        const wantedTags = Array.from(new Set([...DOSE_ADMIN_TAGS, ...extraTags]));
        for (const tag of wantedTags) {
            const parserTag = dicomParserTagKey(tag);
            const element = dataSet.elements[parserTag];
            if (!element) continue;
            let raw = '';
            try {
                raw = dataSet.string(parserTag) || '';
            } catch {
                raw = '';
            }
            if (!raw) continue;
            const values = raw.split('\\').map(value => value.trim()).filter(Boolean);
            if (values.length) metadata[tag] = { Value: values };
        }
        return Object.keys(metadata).length ? metadata : null;
    } catch (err) {
        console.warn('[dose] failed to parse fallback DICOM file:', err.message);
        return null;
    }
};

const buildProjectionDoseValuesFromMetadata = (metadata, rules, profile) => {
    const lookup = {
        number: tag => firstDicomNumber(metadata, [tag]),
        text: tag => firstDicomValue(metadata, [tag]),
    };
    return doseRuleEngine.computeProjectionValues(rules, profile, lookup);
};

const buildCtDoseValuesFromSr = (srContent, rules, profile) => doseRuleEngine.computeSrValues(rules, profile, srContent);

async function fetchDicomwebJson(pathname) {
    const root = String(dicomConfig.dicomweb.pacsRsRoot || `${DICOMWEB_PACS_ROOT}/rs`).replace(/\/+$/, '');
    const response = await fetch(`${root}${pathname}`);
    if (!response.ok) {
        const error = new Error(`DICOMweb request failed (${response.status})`);
        error.status = response.status;
        throw error;
    }
    return response.json();
}

async function extractDoseFromDicomSr(studyInstanceUid) {
    const studyUid = String(studyInstanceUid || '').trim();
    if (!studyUid) {
        const error = new Error('studyInstanceUid is required');
        error.status = 400;
        throw error;
    }
    // Rules dibaca ulang tiap study: edit dose-rules.json langsung berlaku.
    const doseRulesState = loadDoseRuleState();
    const ruleSet = doseRulesState.rules;
    const seriesRows = asDicomRows(await fetchDicomwebJson(`/studies/${encodeURIComponent(studyUid)}/series`));
    const doseSeries = seriesRows.find(series => {
        const modality = getDicomJsonValue(series?.['00080060']).toUpperCase();
        const description = getDicomJsonValue(series?.['0008103E']);
        return modality === 'SR' && doseRuleEngine.matchesSeriesKeywords(description, ruleSet, null);
    });
    if (!doseSeries) {
        return extractDoseFromImageMetadata(studyUid, seriesRows, doseRulesState);
    }
    const seriesInstanceUid = getDicomJsonValue(doseSeries?.['0020000E']);
    const instances = asDicomRows(await fetchDicomwebJson(`/studies/${encodeURIComponent(studyUid)}/series/${encodeURIComponent(seriesInstanceUid)}/instances`));
    const doseInstance = instances.find(instance => {
        const sopClass = getDicomJsonValue(instance?.['00080016']);
        return sopClass === '1.2.840.10008.5.1.4.1.1.88.67' || sopClass.startsWith('1.2.840.10008.5.1.4.1.1.88.');
    }) || instances?.[0];
    const sopInstanceUid = getDicomJsonValue(doseInstance?.['00080018']);
    if (!sopInstanceUid) {
        const error = new Error('Dose Report SR instance not found for this study');
        error.status = 404;
        throw error;
    }
    const metadataRows = asDicomRows(await fetchDicomwebJson(`/studies/${encodeURIComponent(studyUid)}/series/${encodeURIComponent(seriesInstanceUid)}/instances/${encodeURIComponent(sopInstanceUid)}/metadata`));
    let metadata = metadataRows[0] || {};
    let srContent = { numeric: [], text: [], code: [] };
    pushDoseSrContent(metadata?.['0040A730']?.Value, [], srContent);
    // Sebagian PACS tidak mengirim Content Sequence (0040,A730) di /metadata
    // (atau hanya sebagian). Kalau isi SR kosong, baca file SR cadangan di
    // arsip supaya study lama tetap menghasilkan nilai dose.
    let doseSrFile = '';
    if (!srContent.numeric.length && !srContent.text.length) {
        doseSrFile = findDicomBackupFile(sopInstanceUid, studyUid);
        if (doseSrFile) {
            try {
                const fromFile = dicomSr.readSrContentFromFile(doseSrFile);
                if (fromFile.srContent.numeric.length || fromFile.srContent.text.length) {
                    srContent = fromFile.srContent;
                    // Metadata DICOMweb menang; file hanya mengisi tag yang tidak ada.
                    metadata = { ...(fromFile.metadata || {}), ...metadata };
                } else {
                    doseSrFile = '';
                }
            } catch (err) {
                console.warn('[dose] gagal baca file SR cadangan:', err.message);
                doseSrFile = '';
            }
        }
    }
    const modality = getDicomJsonValue(metadata?.['00080060']).toUpperCase() || 'SR';
    const seriesDescription = getDicomJsonValue(doseSeries?.['0008103E']);
    // Profil dipilih setelah metadata terbaca, karena Manufacturer (0008,0070)
    // adalah pembeda utama antar alat.
    const profile = doseRuleEngine.resolveProfile(ruleSet, {
        manufacturer: getDicomJsonValue(metadata?.['00080070']),
        modality: modality === 'SR' ? 'CT' : modality,
        seriesDescription,
    });
    const srResult = buildCtDoseValuesFromSr(srContent, ruleSet, profile);
    let values = srResult.values;
    let doseSource = doseSrFile ? 'dose-sr-file' : 'dose-sr';
    let missing = srResult.missing;
    let unknownConcepts = srResult.unknownConcepts;
    let imageFallback = null;
    const filledBySr = countFilledDoseValues(values);
    // SR ketemu tetapi tidak ada nilai yang terbaca (nama konsep vendor berbeda)
    // -> jangan kembalikan kosong; coba metadata image sebelum menyerah.
    if (!filledBySr && ruleSet.settings.fallbackToImageMetadataWhenSrEmpty !== false) {
        try {
            const fallback = await extractDoseFromImageMetadata(studyUid, seriesRows, doseRulesState, {
                seedValues: values,
                skipDiagnosticLog: true,
            });
            if (hasDoseValue(fallback.values)) {
                values = mergeDoseValues(values, fallback.values);
                doseSource = `dose-sr-empty->${fallback.source.doseSource}`;
                missing = Object.keys(values).filter(field => String(values[field] ?? '').trim() === '');
                unknownConcepts = Array.from(new Set([...unknownConcepts, ...(fallback.source.unknownConcepts || [])]));
                imageFallback = {
                    profile: fallback.source.profile,
                    seriesDescription: fallback.source.seriesDescription,
                    fallbackFile: fallback.source.fallbackFile,
                };
            }
        } catch (err) {
            console.warn(`[dose] Dose SR ada tetapi kosong, fallback metadata gagal: ${err.message}`);
        }
    }
    const result = {
        studyInstanceUid: studyUid,
        seriesInstanceUid,
        sopInstanceUid,
        modalityCode: modality === 'SR' ? 'CT' : modality,
        patientId: getDicomJsonValue(metadata?.['00100020']),
        patientName: getDicomJsonValue(metadata?.['00100010']),
        accessionNumber: getDicomJsonValue(metadata?.['00080050']),
        studyDescription: getDicomJsonValue(metadata?.['00081030']),
        studyDate: getDicomJsonValue(metadata?.['00080020']),
        studyTime: getDicomJsonValue(metadata?.['00080030']),
        values,
        source: {
            seriesDescription,
            doseSource,
            profile: profile?.id || '',
            rulesPath: doseRulesState.path,
            rulesSource: doseRulesState.source,
            rulesWarnings: doseRulesState.warnings,
            missing,
            unknownConcepts,
            imageFallback,
            srFile: doseSrFile || undefined,
            numericMeasurements: srContent.numeric,
        },
    };
    logDoseExtraction(result, ruleSet, doseRulesState.path);
    return result;
}

async function extractDoseFromImageMetadata(studyUid, seriesRows, doseRulesState = null, options = {}) {
    const rulesState = doseRulesState || loadDoseRuleState();
    const ruleSet = rulesState.rules;
    const imageSeries = seriesRows.find(series => getDicomJsonValue(series?.['00080060']).toUpperCase() !== 'SR') || seriesRows[0];
    const seriesInstanceUid = getDicomJsonValue(imageSeries?.['0020000E']);
    if (!seriesInstanceUid) {
        const error = new Error('No image series found for dose extraction');
        error.status = 404;
        throw error;
    }
    const instances = asDicomRows(await fetchDicomwebJson(`/studies/${encodeURIComponent(studyUid)}/series/${encodeURIComponent(seriesInstanceUid)}/instances`));
    const imageInstance = instances[0];
    const sopInstanceUid = getDicomJsonValue(imageInstance?.['00080018']);
    if (!sopInstanceUid) {
        const error = new Error('No image instance found for dose extraction');
        error.status = 404;
        throw error;
    }
    const metadataRows = asDicomRows(await fetchDicomwebJson(`/studies/${encodeURIComponent(studyUid)}/series/${encodeURIComponent(seriesInstanceUid)}/instances/${encodeURIComponent(sopInstanceUid)}/metadata`));
    let metadata = metadataRows[0] || imageInstance || imageSeries;
    let doseSource = 'image-metadata';
    let fallbackFile = '';
    const seriesDescription = getDicomJsonValue(imageSeries?.['0008103E']);
    const profileContext = () => ({
        manufacturer: getDicomJsonValue(metadata?.['00080070']),
        modality: getDicomJsonValue(metadata?.['00080060']).toUpperCase()
            || getDicomJsonValue(imageSeries?.['00080060']).toUpperCase(),
        seriesDescription,
    });
    let profile = doseRuleEngine.resolveProfile(ruleSet, profileContext());
    let projection = buildProjectionDoseValuesFromMetadata(metadata, ruleSet, profile);
    let values = projection.values;
    if (!hasDoseValue(values) || countFilledDoseValues(values) <= 3) {
        fallbackFile = findDicomBackupFile(sopInstanceUid, studyUid);
        // Tag yang dibaca dari file .dcm mengikuti rules (termasuk tag vendor).
        const fileMetadata = readDicomFileMetadata(fallbackFile, doseRuleEngine.allProjectionTags(ruleSet, profile));
        if (fileMetadata) {
            metadata = { ...metadata, ...fileMetadata };
            profile = doseRuleEngine.resolveProfile(ruleSet, profileContext());
            projection = buildProjectionDoseValuesFromMetadata(metadata, ruleSet, profile);
            values = projection.values;
            doseSource = 'dicom-file-metadata';
        }
    }
    if (options.seedValues) values = mergeDoseValues(options.seedValues, values);
    const modality = getDicomJsonValue(metadata?.['00080060']).toUpperCase() || getDicomJsonValue(imageSeries?.['00080060']).toUpperCase();
    const result = {
        studyInstanceUid: studyUid,
        seriesInstanceUid,
        sopInstanceUid,
        modalityCode: modality || 'DX',
        patientId: getDicomJsonValue(metadata?.['00100020']),
        patientName: getDicomJsonValue(metadata?.['00100010']),
        accessionNumber: getDicomJsonValue(metadata?.['00080050']),
        studyDescription: getDicomJsonValue(metadata?.['00081030']),
        studyDate: getDicomJsonValue(metadata?.['00080020']),
        studyTime: getDicomJsonValue(metadata?.['00080030']),
        values,
        source: {
            seriesDescription,
            doseSource,
            profile: profile?.id || '',
            rulesPath: rulesState.path,
            rulesSource: rulesState.source,
            rulesWarnings: rulesState.warnings,
            missing: projection.missing,
            usedTags: projection.used,
            manufacturer: getDicomJsonValue(metadata?.['00080070']),
            fallbackFile: fallbackFile ? path.basename(fallbackFile) : '',
            note: 'Dose SR not found; extracted available DX/projection tags from image metadata. If DAP/ESAK is empty, the modality did not send those dose tags.',
        },
    };
    if (!options.skipDiagnosticLog) logDoseExtraction(result, ruleSet, rulesState.path);
    return result;
}

// Satu baris JSON per ekstraksi -> dipakai untuk diagnosa lapangan
// (GET /api/dose/diagnostics). Tidak pernah menggagalkan ekstraksi.
function logDoseExtraction(result, ruleSet, rulesPath) {
    try {
        doseRuleEngine.appendDiagnosticLog(ruleSet, {
            studyInstanceUid: result.studyInstanceUid,
            modalityCode: result.modalityCode,
            seriesDescription: result.source?.seriesDescription || '',
            doseSource: result.source?.doseSource || '',
            profile: result.source?.profile || '',
            manufacturer: result.source?.manufacturer || '',
            filled: Object.entries(result.values || {})
                .filter(([, value]) => String(value ?? '').trim() !== '')
                .map(([field, value]) => `${field}=${value}`),
            missing: result.source?.missing || [],
            unknownConcepts: (result.source?.unknownConcepts || []).slice(0, 25),
        }, { rulesPath, log: message => console.warn(message) });
    } catch (err) {
        console.warn(`[dose] gagal menulis diagnostic log: ${err.message}`);
    }
}

app.post('/api/dose/getdose', requireAnyPermission(...dosePermissions), async (req, res) => {
    const studyInstanceUid = req.body?.studyInstanceUid || req.body?.study_instance_uid || req.query.studyInstanceUid;
    try {
        const result = await extractDoseFromDicomSr(studyInstanceUid);
        res.json(result);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Failed to extract dose report' });
    }
});

// Aturan ekstraksi dose yang sedang berlaku: lokasi file, sumber (default vs
// custom), warning validasi, dan ringkasan profil yang aktif.
app.get('/api/dose/rules', requireAnyPermission(...dosePermissions), (req, res) => {
    try {
        const state = doseRuleEngine.readDoseRules({ log: message => console.log(message) });
        res.json({
            path: state.path,
            source: state.source,
            autoCreated: state.autoCreated,
            warnings: state.warnings,
            summary: doseRuleEngine.summarizeRules(state.rules),
        });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to read dose rules' });
    }
});

// Hasil ekstraksi terakhir (siapa profilnya, field apa yang kosong, konsep SR
// apa yang tidak dikenali) -> dipakai untuk menyusun rule alat baru.
app.get('/api/dose/diagnostics', requireAnyPermission(...dosePermissions), (req, res) => {
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(500, Math.floor(requestedLimit))) : 50;
    try {
        const state = doseRuleEngine.readDoseRules({ log: () => {} });
        const payload = doseRuleEngine.readDiagnosticLog(limit, { rulesPath: state.path });
        res.json({
            rulesPath: state.path,
            logPath: payload.path,
            entries: payload.entries,
            error: payload.error,
            // Root arsip yang benar-benar ada .metadata-backups-nya: kalau ini
            // kosong/salah, fallback baca file .dcm tidak akan pernah ketemu.
            backupRoots: dicomBackupRoots(),
            storagePath: String(dicomConfig.dicomweb.pacsStoragePath || ''),
        });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to read dose diagnostics' });
    }
});

// Buat baris dose_report untuk study yang belum punya record, memakai order MWL
// sebagai sumber identitas (pasien/aksesi/ruangan). Dipakai reextract dengan
// createMissing:true supaya study lama hasil auto-extract bisa dibuatkan barisnya
// setelah rules dose diperbaiki. Return null kalau tidak ada order MWL.
async function findDoseReportOrder(studyUid) {
    const [orderRows] = await pool.query(
        `SELECT o.id, o.accession_number, o.procedure_desc, o.study_date, o.study_time,
                o.modality, o.cito, o.nama_radiolog, o.nama_radiografer, o.nama_ruangan,
                o.modality_station_ae, o.modality_station_room,
                p.no_rm, p.nama_pasien, p.tanggal_lahir, p.kelamin
           FROM mwl_orders o
           LEFT JOIN patients p ON p.id = o.patient_record_id
          WHERE o.study_instance_uid = ?
          LIMIT 1`,
        [studyUid]
    );
    return orderRows?.[0] || null;
}

// return { id, accessionNumber, patientName } kalau berhasil, null kalau tidak ada order MWL
async function createDoseReportFromStudy(studyUid, values, modalityCode = '') {
    const order = await findDoseReportOrder(studyUid);
    if (!order) return null;
    const id = String(order.id);
    // study_date disimpan sebagai teks 'YYYY-MM-DD'. Kalau sumbernya Date,
    // pakai komponen LOKAL -- toISOString() bisa menggeser tanggal satu hari (WIB = UTC+7).
    const asDate = value => {
        if (!value) return null;
        if (value instanceof Date) {
            const year = value.getFullYear();
            const month = String(value.getMonth() + 1).padStart(2, '0');
            const day = String(value.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        }
        return String(value).slice(0, 10);
    };
    const asTime = value => {
        if (!value) return null;
        if (value instanceof Date) return value.toTimeString().slice(0, 8);
        return String(value).slice(0, 8);
    };
    await pool.query(
        `INSERT INTO dose_report (
             id, mwl_order_id, patient_id, patient_name, accession_number, modality_code,
             study_description, study_date, study_time, sex, birth_date, cito,
             radiologist, technologist, room, ae_title, study_instance_uid,
             capture_mode, values_json, saved_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto', ?, NOW())
         ON DUPLICATE KEY UPDATE
             values_json = VALUES(values_json),
             capture_mode = 'auto',
             updated_at = NOW()`,
        [
            id,
            order.id,
            order.no_rm || null,
            order.nama_pasien || null,
            order.accession_number || null,
            normalizeModality(order.modality || modalityCode).toUpperCase(),
            order.procedure_desc || null,
            asDate(order.study_date),
            asTime(order.study_time),
            order.kelamin || null,
            asDate(order.tanggal_lahir),
            order.cito === 'Y' ? 1 : 0,
            order.nama_radiolog || null,
            order.nama_radiografer || null,
            order.nama_ruangan || order.modality_station_room || null,
            order.modality_station_ae || null,
            studyUid,
            JSON.stringify(values || {}),
        ]
    );
    return { id, accessionNumber: order.accession_number || '', patientName: order.nama_pasien || '' };
}

// Ekstrak ulang study lama dengan rules terbaru. Aman secara default:
// - mode "merge" (default) hanya mengisi field yang masih kosong; pakai
//   mode:"replace" untuk menimpa nilai yang sudah ada;
// - includeManual:false (default) melewati laporan manual;
// - dryRun:true untuk melihat rencana perubahan tanpa menulis ke database.
app.post('/api/dose/reextract', requireAnyPermission(...dosePermissions), async (req, res) => {
    const body = req.body || {};
    const dryRun = body.dryRun === true || body.dry_run === true;
    const includeManual = body.includeManual === true || body.include_manual === true;
    const createMissing = body.createMissing === true || body.create_missing === true;
    const mode = body.mode === 'replace' ? 'replace' : 'merge';
    const singleStudyUid = String(body.studyInstanceUid || body.study_instance_uid || '').trim();
    // normalizeModality() memberi default 'OT' untuk input kosong -- di sini
    // kosong harus tetap kosong supaya permintaan tanpa target ditolak 400.
    const rawModality = String(body.modalityCode || body.modality_code || '').trim();
    const modality = rawModality ? normalizeModality(rawModality).toUpperCase() : '';
    const from = String(body.from || body.studyDateFrom || '').trim();
    const to = String(body.to || body.studyDateTo || '').trim();
    const requestedLimit = Number(body.limit);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(200, Math.floor(requestedLimit))) : 25;
    if (!singleStudyUid && !modality) {
        return res.status(400).json({ error: 'studyInstanceUid or modalityCode is required' });
    }
    try {
        let targets = [];
        if (singleStudyUid) {
            const [rows] = await pool.query(
                'SELECT id, study_instance_uid, values_json, capture_mode, study_date, modality_code FROM dose_report WHERE study_instance_uid = ? LIMIT 5',
                [singleStudyUid]
            );
            targets = rows.length ? rows : [{
                id: null,
                study_instance_uid: singleStudyUid,
                values_json: null,
                capture_mode: null,
                study_date: '',
                modality_code: modality,
            }];
        } else {
            const filters = ["COALESCE(study_instance_uid, '') <> ''", 'modality_code = ?'];
            const params = [modality];
            if (from) { filters.push('study_date >= ?'); params.push(from); }
            if (to) { filters.push('study_date <= ?'); params.push(to); }
            if (!includeManual) filters.push("capture_mode = 'auto'");
            const [rows] = await pool.query(
                `SELECT id, study_instance_uid, values_json, capture_mode, study_date, modality_code
                 FROM dose_report
                 WHERE ${filters.join(' AND ')}
                 ORDER BY saved_at DESC
                 LIMIT ?`,
                [...params, limit]
            );
            targets = rows;
        }

        const state = doseRuleEngine.readDoseRules({ log: message => console.log(message) });
        const results = [];
        let updated = 0;
        let created = 0;
        let skipped = 0;
        let failed = 0;
        // Sequensial: satu study sekali jalan supaya PACS tidak dibanjiri.
        for (const row of targets) {
            const rowStudyUid = String(row.study_instance_uid || '').trim();
            try {
                const extraction = await extractDoseFromDicomSr(rowStudyUid);
                const extracted = Object.fromEntries(Object.entries(extraction.values || {})
                    .filter(([, value]) => String(value ?? '').trim() !== ''));
                const previous = parseDoseJson(row.values_json);
                const merged = mergeDoseValues(previous, extracted, mode === 'replace' ? 'replace' : 'fill-empty');
                const changedFields = Object.keys(extracted)
                    .filter(field => String(merged[field] ?? '') !== String(previous[field] ?? ''));
                const baseResult = {
                    id: row.id === null ? '' : String(row.id),
                    studyInstanceUid: rowStudyUid,
                    captureMode: row.capture_mode || 'none',
                    profile: extraction.source?.profile || '',
                    doseSource: extraction.source?.doseSource || '',
                    extractedFields: Object.keys(extracted),
                    missingFields: extraction.source?.missing || [],
                };
                if (!Object.keys(extracted).length) {
                    skipped += 1;
                    results.push({ ...baseResult, status: 'skipped', reason: 'no values could be read from the modality' });
                    continue;
                }
                if (!changedFields.length) {
                    skipped += 1;
                    results.push({ ...baseResult, status: 'skipped', reason: 'values already match' });
                    continue;
                }
                if (!row.id) {
                    if (!createMissing) {
                        skipped += 1;
                        results.push({
                            ...baseResult,
                            status: 'no-record',
                            reason: 'study is not in dose_report yet (use createMissing:true to create the row)',
                            values: merged,
                        });
                        continue;
                    }
                    const orderRef = await findDoseReportOrder(rowStudyUid);
                    if (!orderRef) {
                        skipped += 1;
                        results.push({
                            ...baseResult,
                            status: 'no-record',
                            reason: 'no MWL order for this study, the dose row cannot be created',
                            values: merged,
                        });
                        continue;
                    }
                    if (dryRun) {
                        created += 1;
                        results.push({
                            ...baseResult,
                            id: String(orderRef.id),
                            status: 'would-create',
                            accessionNumber: orderRef.accession_number || '',
                            patientName: orderRef.nama_pasien || '',
                            values: merged,
                        });
                        continue;
                    }
                    const createdRow = await createDoseReportFromStudy(rowStudyUid, merged, row.modality_code || modality);
                    if (!createdRow) {
                        skipped += 1;
                        results.push({
                            ...baseResult,
                            status: 'no-record',
                            reason: 'no MWL order for this study, the dose row cannot be created',
                            values: merged,
                        });
                        continue;
                    }
                    created += 1;
                    results.push({
                        ...baseResult,
                        id: createdRow.id,
                        status: 'created',
                        accessionNumber: createdRow.accessionNumber,
                        patientName: createdRow.patientName,
                    });
                    continue;
                }
                if (dryRun) {
                    results.push({ ...baseResult, status: 'would-update', changedFields, values: merged });
                    continue;
                }
                await pool.query(
                    'UPDATE dose_report SET values_json = ?, updated_at = NOW() WHERE id = ?',
                    [JSON.stringify(merged), row.id]
                );
                updated += 1;
                results.push({ ...baseResult, status: 'updated', changedFields });
            } catch (err) {
                failed += 1;
                results.push({
                    id: row.id === null ? '' : String(row.id),
                    studyInstanceUid: rowStudyUid,
                    status: 'failed',
                    error: err.message || 'extraction failed',
                });
            }
        }
        res.json({
            dryRun,
            mode,
            includeManual,
            createMissing,
            rulesPath: state.path,
            rulesSource: state.source,
            rulesWarnings: state.warnings,
            scanned: targets.length,
            updated,
            created,
            skipped,
            failed,
            results,
        });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to re-extract dose reports' });
    }
});

app.get('/api/dose/reports', requireAnyPermission(...dosePermissions), async (req, res) => {
    const modality = typeof req.query.modality === 'string' ? req.query.modality.trim().toUpperCase() : '';
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(5000, Math.floor(requestedLimit)))
        : 1000;
    const filters = [];
    const params = [];
    if (modality) {
        filters.push('modality_code = ?');
        params.push(modality);
    }
    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    try {
        const [rows] = await pool.query(
            `
            SELECT *
            FROM dose_report
            ${whereClause}
            ORDER BY saved_at DESC, updated_at DESC
            LIMIT ?
            `,
            [...params, limit]
        );
        res.json(rows.map(mapDoseReportRow));
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to fetch dose reports' });
    }
});

app.post('/api/dose/reports', requireAnyPermission(...dosePermissions), async (req, res) => {
    const body = req.body || {};
    const id = String(body.id || body.mwlOrderId || '').trim();
    const modalityCode = normalizeModality(body.modalityCode || body.modality_code).toUpperCase();
    if (!id || !modalityCode) {
        return res.status(400).json({ error: 'id and modalityCode are required' });
    }
    const mwlOrderId = Number(body.mwlOrderId || body.mwl_order_id || id);
    const valuesJson = JSON.stringify(body.values && typeof body.values === 'object' ? body.values : {});
    const captureMode = body.captureMode === 'auto' || body.capture_mode === 'auto' ? 'auto' : 'manual';
    try {
        await pool.query(
            `
            INSERT INTO dose_report (
                id, mwl_order_id, patient_id, patient_name, accession_number, modality_code,
                study_description, study_date, study_time, sex, birth_date, cito, radiologist,
                technologist, medical_physicist, room, ae_title, study_instance_uid, capture_mode, values_json, saved_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
            ON DUPLICATE KEY UPDATE
                mwl_order_id = VALUES(mwl_order_id),
                patient_id = VALUES(patient_id),
                patient_name = VALUES(patient_name),
                accession_number = VALUES(accession_number),
                modality_code = VALUES(modality_code),
                study_description = VALUES(study_description),
                study_date = VALUES(study_date),
                study_time = VALUES(study_time),
                sex = VALUES(sex),
                birth_date = VALUES(birth_date),
                cito = VALUES(cito),
                radiologist = VALUES(radiologist),
                technologist = VALUES(technologist),
                medical_physicist = VALUES(medical_physicist),
                room = VALUES(room),
                ae_title = VALUES(ae_title),
                study_instance_uid = VALUES(study_instance_uid),
                capture_mode = VALUES(capture_mode),
                values_json = VALUES(values_json),
                saved_at = NOW()
            `,
            [
                id,
                Number.isFinite(mwlOrderId) ? mwlOrderId : null,
                body.patientId || body.patient_id || null,
                body.patientName || body.patient_name || null,
                body.accessionNumber || body.accession_number || null,
                modalityCode,
                body.studyDescription || body.study_description || null,
                body.studyDate || body.study_date || null,
                body.studyTime || body.study_time || null,
                body.sex || null,
                body.birthDate || body.birth_date || null,
                body.cito ? 1 : 0,
                body.radiologist || null,
                body.technologist || null,
                body.medicalPhysicist || body.medical_physicist || null,
                body.room || null,
                body.aeTitle || body.ae_title || null,
                body.studyInstanceUid || body.study_instance_uid || null,
                captureMode,
                valuesJson,
            ]
        );
        const [rows] = await pool.query('SELECT * FROM dose_report WHERE id = ? LIMIT 1', [id]);
        res.status(201).json(mapDoseReportRow(rows[0]));
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to save dose report' });
    }
});

app.get('/api/dose/idrl', requireAnyPermission(...dosePermissions), async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM dose_idrl ORDER BY modality_code ASC, exam ASC, metric ASC');
        res.json(rows.map(mapDoseIdrlRow));
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to fetch IDRL records' });
    }
});

app.put('/api/dose/idrl/bulk', requireAnyPermission(...dosePermissions), async (req, res) => {
    const records = Array.isArray(req.body?.records) ? req.body.records : [];
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        for (const record of records) {
            const id = String(record.id || '').trim();
            const modalityCode = normalizeModality(record.modalityCode || record.modality_code).toUpperCase();
            const exam = String(record.exam || '').trim();
            const metric = String(record.metric || '').trim();
            const limit = String(record.limit || record.dose_limit || '').trim();
            if (!id || !modalityCode || !exam || !metric || !limit) continue;
            await connection.query(
                `
                INSERT INTO dose_idrl (id, modality_code, exam, metric, dose_limit, unit, body_region, reference_text, effective_date)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    modality_code = VALUES(modality_code),
                    exam = VALUES(exam),
                    metric = VALUES(metric),
                    dose_limit = VALUES(dose_limit),
                    unit = VALUES(unit),
                    body_region = VALUES(body_region),
                    reference_text = VALUES(reference_text),
                    effective_date = VALUES(effective_date)
                `,
                [id, modalityCode, exam, metric, limit, record.unit || null, record.bodyRegion || record.body_region || null, record.reference || record.reference_text || null, record.effectiveDate || record.effective_date || null]
            );
        }
        await connection.commit();
        const [rows] = await pool.query('SELECT * FROM dose_idrl ORDER BY modality_code ASC, exam ASC, metric ASC');
        res.json(rows.map(mapDoseIdrlRow));
    } catch (err) {
        await connection.rollback();
        res.status(500).json({ error: err.message || 'Failed to save IDRL records' });
    } finally {
        connection.release();
    }
});

app.delete('/api/dose/idrl/:id', requireAnyPermission(...dosePermissions), async (req, res) => {
    try {
        const [result] = await pool.query('DELETE FROM dose_idrl WHERE id = ?', [req.params.id]);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'IDRL record not found' });
        res.json({ message: 'IDRL record deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to delete IDRL record' });
    }
});

app.get('/api/dose/idrl-study-links', requireAnyPermission(...dosePermissions), async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM dose_idrl_study_links ORDER BY modality_code ASC, idrl_exam ASC, study_description ASC');
        res.json(rows.map(mapDoseIdrlStudyLinkRow));
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to fetch IDRL study links' });
    }
});

app.put('/api/dose/idrl-study-links', requireAnyPermission(...dosePermissions), async (req, res) => {
    const target = req.body?.target || {};
    const modalityCode = normalizeModality(target.modalityCode || target.modality_code).toUpperCase();
    const idrlExam = String(target.idrlExam || target.idrl_exam || '').trim();
    const links = Array.isArray(req.body?.links) ? req.body.links : [];
    if (!modalityCode || !idrlExam) {
        return res.status(400).json({ error: 'target modalityCode and idrlExam are required' });
    }
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        await connection.query('DELETE FROM dose_idrl_study_links WHERE modality_code = ? AND idrl_exam = ?', [modalityCode, idrlExam]);
        for (const link of links) {
            const studyMasterId = Number(link.studyMasterId || link.study_master_id);
            if (!Number.isFinite(studyMasterId) || studyMasterId <= 0) continue;
            const id = String(link.id || `${modalityCode}::${idrlExam.toLowerCase()}::${studyMasterId}`).slice(0, 255);
            await connection.query(
                `
                INSERT INTO dose_idrl_study_links (id, modality_code, idrl_exam, study_master_id, procedure_code, study_description)
                VALUES (?, ?, ?, ?, ?, ?)
                `,
                [id, modalityCode, idrlExam, studyMasterId, link.procedureCode || link.procedure_code || null, link.studyDescription || link.study_description || null]
            );
        }
        await connection.commit();
        const [rows] = await pool.query('SELECT * FROM dose_idrl_study_links ORDER BY modality_code ASC, idrl_exam ASC, study_description ASC');
        res.json(rows.map(mapDoseIdrlStudyLinkRow));
    } catch (err) {
        await connection.rollback();
        res.status(500).json({ error: err.message || 'Failed to save IDRL study links' });
    } finally {
        connection.release();
    }
});

app.get(
    '/api/mwl/studies',
    requireAnyPermission('view_mwl_order', 'view_mwl_technologist', 'view_mwl_status', 'view_study_management', 'view_dose_idrl'),
    async (req, res) => {
        const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
        const like = `%${q}%`;
        try {
            await ensureMwlTables();
            const [rows] = q
                ? await pool.query(
                      `
                    SELECT id, procedure_code, modality_code, study_description, created_at, updated_at
                    FROM mwl_studies
                    WHERE study_description LIKE ? OR procedure_code LIKE ? OR modality_code LIKE ?
                    ORDER BY study_description ASC
                    LIMIT 300
                    `,
                      [like, like, like]
                  )
                : await pool.query(
                      `
                    SELECT id, procedure_code, modality_code, study_description, created_at, updated_at
                    FROM mwl_studies
                    ORDER BY study_description ASC
                    LIMIT 300
                    `
                  );
            res.json(rows);
        } catch (err) {
            res.status(500).json({ error: err.message || 'Failed to fetch study masters' });
        }
    }
);

app.post('/api/mwl/studies', requirePermission('manage_study_management'), async (req, res) => {
    const procedureCode = String(req.body?.procedureCode || '').trim();
    const modalityCode = normalizeModality(req.body?.modalityCode);
    const studyDescription = String(req.body?.studyDescription || '').trim();
    if (!procedureCode || !modalityCode || !studyDescription) {
        return res.status(400).json({ error: 'procedureCode, modalityCode, studyDescription are required' });
    }
    try {
        await ensureMwlTables();
        const [dupRows] = await pool.query(
            `
            SELECT id
            FROM mwl_studies
            WHERE study_description = ? AND modality_code = ?
            `,
            [studyDescription, modalityCode]
        );
        if (dupRows.length) {
            return res.status(409).json({ error: 'Study description + modality already exists' });
        }
        const [result] = await pool.query(
            `
            INSERT INTO mwl_studies (procedure_code, modality_code, study_description)
            VALUES (?, ?, ?)
            `,
            [procedureCode, modalityCode, studyDescription]
        );
        const [rows] = await pool.query(
            `
            SELECT id, procedure_code, modality_code, study_description, created_at, updated_at
            FROM mwl_studies
            WHERE id = ?
            `,
            [result.insertId]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to create study master' });
    }
});

app.put('/api/mwl/studies/:id', requirePermission('manage_study_management'), async (req, res) => {
    const id = Number(req.params.id);
    const procedureCode = String(req.body?.procedureCode || '').trim();
    const modalityCode = normalizeModality(req.body?.modalityCode);
    const studyDescription = String(req.body?.studyDescription || '').trim();
    if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid id' });
    }
    if (!procedureCode || !modalityCode || !studyDescription) {
        return res.status(400).json({ error: 'procedureCode, modalityCode, studyDescription are required' });
    }
    try {
        await ensureMwlTables();
        const [dupRows] = await pool.query(
            `
            SELECT id
            FROM mwl_studies
            WHERE study_description = ? AND modality_code = ? AND id <> ?
            `,
            [studyDescription, modalityCode, id]
        );
        if (dupRows.length) {
            return res.status(409).json({ error: 'Study description + modality already exists' });
        }
        const [result] = await pool.query(
            `
            UPDATE mwl_studies
            SET procedure_code = ?, modality_code = ?, study_description = ?
            WHERE id = ?
            `,
            [procedureCode, modalityCode, studyDescription, id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Study master not found' });
        }
        const [rows] = await pool.query(
            `
            SELECT id, procedure_code, modality_code, study_description, created_at, updated_at
            FROM mwl_studies
            WHERE id = ?
            `,
            [id]
        );
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to update study master' });
    }
});

app.delete('/api/mwl/studies/:id', requirePermission('manage_study_management'), async (req, res) => {
    const deleteReason = requireDeleteReason(req, res);
    if (!deleteReason) return;
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid id' });
    }
    try {
        await ensureMwlTables();
        const [result] = await pool.query('DELETE FROM mwl_studies WHERE id = ?', [id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Study master not found' });
        }
        await writeAuditLog(req, {
            eventType: 'delete_mwl_study_master',
            outcome: 'success',
            targetType: 'mwl_study',
            targetId: String(id),
            details: { deleteReason },
        });
        res.json({ message: 'Study master deleted' });
    } catch (err) {
        await writeAuditLog(req, {
            eventType: 'delete_mwl_study_master',
            outcome: 'failure',
            targetType: 'mwl_study',
            targetId: String(id),
            details: { deleteReason, error: err.message || 'Failed to delete study master' },
        });
        res.status(500).json({ error: err.message || 'Failed to delete study master' });
    }
});

app.get(
    '/api/mwl/doctors',
    requireAnyPermission('view_mwl_order', 'view_mwl_technologist', 'view_doctor_management', 'view_users', 'manage_users', 'view_dose_monitor'),
    async (req, res) => {
        const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
        const role = normalizeMwlDoctorRole(req.query.role);
        const filters = [];
        const params = [];
        if (q) {
            const like = `%${q}%`;
            filters.push('(d.kode_dokter LIKE ? OR d.nama_dokter LIKE ?)');
            params.push(like, like);
        }
        if (role) {
            filters.push('d.role = ?');
            params.push(role);
        }
        const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
        try {
            await ensureMwlTables();
            await scheduleMwlCompletionSync(req);
            const [rows] = await pool.query(
                `
                SELECT d.id, d.kode_dokter, d.nama_dokter, d.role, d.user_id, d.created_at, d.updated_at, u.username AS linked_username, u.name AS linked_user_name, u.phone_number AS linked_phone_number
                FROM mwl_doctors d
                LEFT JOIN users u ON u.id = d.user_id
                ${whereClause}
                ORDER BY d.nama_dokter ASC
                LIMIT 500
                `,
                params
            );
            res.json(rows);
        } catch (err) {
            res.status(500).json({ error: err.message || 'Failed to fetch doctors' });
        }
    }
);

app.post('/api/mwl/doctors', requirePermission('manage_doctor_management'), async (req, res) => {
    const kodeDokter = String(req.body?.kodeDokter || '').trim();
    const namaDokter = String(req.body?.namaDokter || '').trim();
    const role = normalizeMwlDoctorRole(req.body?.role);
    if (!kodeDokter || !namaDokter || !role) {
        return res.status(400).json({ error: 'kodeDokter, namaDokter, role are required' });
    }
    try {
        await ensureMwlTables();
        const [dupRows] = await pool.query('SELECT id FROM mwl_doctors WHERE kode_dokter = ?', [kodeDokter]);
        if (dupRows.length) {
            return res.status(409).json({ error: 'Physician code already exists' });
        }
        const [result] = await pool.query(
            `
            INSERT INTO mwl_doctors (kode_dokter, nama_dokter, role)
            VALUES (?, ?, ?)
            `,
            [kodeDokter, namaDokter, role]
        );
        const [rows] = await pool.query(
            `
            SELECT d.id, d.kode_dokter, d.nama_dokter, d.role, d.user_id, d.created_at, d.updated_at, u.username AS linked_username, u.name AS linked_user_name, u.phone_number AS linked_phone_number
            FROM mwl_doctors d
            LEFT JOIN users u ON u.id = d.user_id
            WHERE d.id = ?
            `,
            [result.insertId]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to create doctor' });
    }
});

app.put('/api/mwl/doctors/:id', requirePermission('manage_doctor_management'), async (req, res) => {
    const id = Number(req.params.id);
    const kodeDokter = String(req.body?.kodeDokter || '').trim();
    const namaDokter = String(req.body?.namaDokter || '').trim();
    const role = normalizeMwlDoctorRole(req.body?.role);
    if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid id' });
    }
    if (!kodeDokter || !namaDokter || !role) {
        return res.status(400).json({ error: 'kodeDokter, namaDokter, role are required' });
    }
    try {
        await ensureMwlTables();
        const [dupRows] = await pool.query('SELECT id FROM mwl_doctors WHERE kode_dokter = ? AND id <> ?', [kodeDokter, id]);
        if (dupRows.length) {
            return res.status(409).json({ error: 'Physician code already exists' });
        }
        const [result] = await pool.query(
            `
            UPDATE mwl_doctors
            SET kode_dokter = ?, nama_dokter = ?, role = ?
            WHERE id = ?
            `,
            [kodeDokter, namaDokter, role, id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Doctor not found' });
        }
        const [rows] = await pool.query(
            `
            SELECT d.id, d.kode_dokter, d.nama_dokter, d.role, d.user_id, d.created_at, d.updated_at, u.username AS linked_username, u.name AS linked_user_name, u.phone_number AS linked_phone_number
            FROM mwl_doctors d
            LEFT JOIN users u ON u.id = d.user_id
            WHERE d.id = ?
            `,
            [id]
        );
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to update doctor' });
    }
});

app.delete('/api/mwl/doctors/:id', requirePermission('manage_doctor_management'), async (req, res) => {
    const deleteReason = requireDeleteReason(req, res);
    if (!deleteReason) return;
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid id' });
    }
    try {
        await ensureMwlTables();
        const [doctorRows] = await pool.query('SELECT kode_dokter FROM mwl_doctors WHERE id = ? LIMIT 1', [id]);
        const doctorCode = String(doctorRows[0]?.kode_dokter || '').trim() || null;
        await syncRadiologistAssignmentsForDoctor({
            radiologistDoctorId: id,
            radiologistDoctorCode: doctorCode,
            radiologistUserId: null,
            assignedBy: null,
        });
        const [result] = await pool.query('DELETE FROM mwl_doctors WHERE id = ?', [id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Doctor not found' });
        }
        await writeAuditLog(req, {
            eventType: 'delete_mwl_doctor',
            outcome: 'success',
            targetType: 'mwl_doctor',
            targetId: String(id),
            details: { deleteReason },
        });
        res.json({ message: 'Doctor deleted' });
    } catch (err) {
        await writeAuditLog(req, {
            eventType: 'delete_mwl_doctor',
            outcome: 'failure',
            targetType: 'mwl_doctor',
            targetId: String(id),
            details: { deleteReason, error: err.message || 'Failed to delete doctor' },
        });
        res.status(500).json({ error: err.message || 'Failed to delete doctor' });
    }
});

app.get(
    '/api/mwl/modalities',
    requireAnyPermission('view_mwl_technologist', 'view_modality_management'),
    async (req, res) => {
        const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
        const params = [];
        const whereClause = q ? 'WHERE nama_ruangan LIKE ? OR ae_title_station LIKE ?' : '';
        if (q) {
            const like = `%${q}%`;
            params.push(like, like);
        }
        try {
            await ensureMwlTables();
            const [rows] = await pool.query(
                `
                SELECT id, nama_ruangan, ae_title_station, created_at, updated_at
                FROM mwl_modalities
                ${whereClause}
                ORDER BY nama_ruangan ASC
                LIMIT 500
                `,
                params
            );
            res.json(rows);
        } catch (err) {
            res.status(500).json({ error: err.message || 'Failed to fetch modalities' });
        }
    }
);

app.post('/api/mwl/modalities', requirePermission('manage_modality_management'), async (req, res) => {
    const namaRuangan = String(req.body?.namaRuangan || '').trim();
    const aeTitleStation = getSafeAet(req.body?.aeTitleStation || '') || null;
    if (!namaRuangan) {
        return res.status(400).json({ error: 'namaRuangan is required' });
    }
    try {
        await ensureMwlTables();
        const [dupRows] = aeTitleStation
            ? await pool.query(
                'SELECT id FROM mwl_modalities WHERE nama_ruangan = ? OR ae_title_station = ?',
                [namaRuangan, aeTitleStation]
            )
            : await pool.query(
                'SELECT id FROM mwl_modalities WHERE nama_ruangan = ?',
                [namaRuangan]
            );
        if (dupRows.length) {
            return res.status(409).json({ error: 'Room name or AE Title already exists' });
        }
        const [result] = await pool.query(
            `
            INSERT INTO mwl_modalities (nama_ruangan, ae_title_station)
            VALUES (?, ?)
            `,
            [namaRuangan, aeTitleStation]
        );
        const [rows] = await pool.query(
            `
            SELECT id, nama_ruangan, ae_title_station, created_at, updated_at
            FROM mwl_modalities
            WHERE id = ?
            `,
            [result.insertId]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to create modality' });
    }
});

app.put('/api/mwl/modalities/:id', requirePermission('manage_modality_management'), async (req, res) => {
    const id = Number(req.params.id);
    const namaRuangan = String(req.body?.namaRuangan || '').trim();
    const aeTitleStation = getSafeAet(req.body?.aeTitleStation || '') || null;
    if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid id' });
    }
    if (!namaRuangan) {
        return res.status(400).json({ error: 'namaRuangan is required' });
    }
    try {
        await ensureMwlTables();
        const [dupRows] = aeTitleStation
            ? await pool.query(
                'SELECT id FROM mwl_modalities WHERE (nama_ruangan = ? OR ae_title_station = ?) AND id <> ?',
                [namaRuangan, aeTitleStation, id]
            )
            : await pool.query(
                'SELECT id FROM mwl_modalities WHERE nama_ruangan = ? AND id <> ?',
                [namaRuangan, id]
            );
        if (dupRows.length) {
            return res.status(409).json({ error: 'Room name or AE Title already exists' });
        }
        const [result] = await pool.query(
            `
            UPDATE mwl_modalities
            SET nama_ruangan = ?, ae_title_station = ?
            WHERE id = ?
            `,
            [namaRuangan, aeTitleStation, id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Modality not found' });
        }
        const [rows] = await pool.query(
            `
            SELECT id, nama_ruangan, ae_title_station, created_at, updated_at
            FROM mwl_modalities
            WHERE id = ?
            `,
            [id]
        );
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to update modality' });
    }
});

app.delete('/api/mwl/modalities/:id', requirePermission('manage_modality_management'), async (req, res) => {
    const deleteReason = requireDeleteReason(req, res);
    if (!deleteReason) return;
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid id' });
    }
    try {
        await ensureMwlTables();
        const [result] = await pool.query('DELETE FROM mwl_modalities WHERE id = ?', [id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Modality not found' });
        }
        await writeAuditLog(req, {
            eventType: 'delete_mwl_modality',
            outcome: 'success',
            targetType: 'mwl_modality',
            targetId: String(id),
            details: { deleteReason },
        });
        res.json({ message: 'Modality deleted' });
    } catch (err) {
        await writeAuditLog(req, {
            eventType: 'delete_mwl_modality',
            outcome: 'failure',
            targetType: 'mwl_modality',
            targetId: String(id),
            details: { deleteReason, error: err.message || 'Failed to delete modality' },
        });
        res.status(500).json({ error: err.message || 'Failed to delete modality' });
    }
});

app.get(
    '/api/mwl/patients',
    requireAnyPermission('view_mwl_register', 'view_mwl_order', 'view_mwl_technologist', 'view_mwl_status'),
    async (req, res) => {
        const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
        const like = `%${q}%`;
        try {
            await ensureMwlTables();
            const [rows] = q
                ? await pool.query(
                      `
                    SELECT id, no_rm, nama_pasien, tanggal_lahir, kelamin, alamat, kecamatan, kabupaten, provinsi, kode_pos, no_hp, waktu_update_pasien, update_simrs
                    FROM patients
                    WHERE no_rm LIKE ? OR nama_pasien LIKE ?
                    ORDER BY waktu_update_pasien DESC
                    LIMIT 100
                    `,
                      [like, like]
                  )
                : await pool.query(
                      `
                    SELECT id, no_rm, nama_pasien, tanggal_lahir, kelamin, alamat, kecamatan, kabupaten, provinsi, kode_pos, no_hp, waktu_update_pasien, update_simrs
                    FROM patients
                    ORDER BY waktu_update_pasien DESC
                    LIMIT 100
                    `
                  );
            res.json(rows);
        } catch (err) {
            res.status(500).json({ error: err.message || 'Failed to fetch patients' });
        }
    }
);

app.post('/api/mwl/patients', requirePermission('view_mwl_register'), async (req, res) => {
    const body = req.body || {};
    const noRm = String(body.no_rm || body.noRm || body.patientId || '').trim();
    const namaPasien = String(body.nama_pasien || body.namaPasien || body.patientName || '').trim();
    const tanggalLahir = normalizeStudyDate(body.tanggal_lahir || body.tanggalLahir || body.dob);
    const kelamin = normalizeSex(body.kelamin || body.sex);
    const alamat = body.alamat === undefined || body.alamat === null ? null : String(body.alamat).trim() || null;
    const kecamatan =
        body.kecamatan === undefined || body.kecamatan === null ? null : String(body.kecamatan).trim() || null;
    const kabupaten =
        body.kabupaten === undefined || body.kabupaten === null ? null : String(body.kabupaten).trim() || null;
    const provinsi =
        body.provinsi === undefined || body.provinsi === null ? null : String(body.provinsi).trim() || null;
    const kodePos =
        body.kode_pos === undefined || body.kode_pos === null
            ? body.kodePos === undefined || body.kodePos === null
                ? null
                : String(body.kodePos).trim() || null
            : String(body.kode_pos).trim() || null;
    const noHp =
        body.no_hp === undefined || body.no_hp === null
            ? body.noHp === undefined || body.noHp === null
                ? null
                : String(body.noHp).trim() || null
            : String(body.no_hp).trim() || null;
    const updateSimrsRaw = String(body.update_ris || body.updateSimrs || 'Y').trim().toUpperCase();
    const updateSimrs = updateSimrsRaw === 'N' ? 'N' : 'Y';
    if (!noRm || !namaPasien || !tanggalLahir) {
        return res.status(400).json({
            error: 'noRm, namaPasien and tanggalLahir are required',
        });
    }
    try {
        await ensureMwlTables();
        const [columnRows] = await pool.query(
            `
            SELECT column_name
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE table_schema = current_schema()
              AND TABLE_NAME = 'patients'
            `
        );
        const availableColumns = new Set(columnRows.map(row => row.column_name));
        const [existing] = await pool.query('SELECT id FROM patients WHERE no_rm = ?', [noRm]);
        if (existing.length) {
            return res.status(409).json({ error: 'MRN is already registered' });
        }
        const insertColumns = [];
        const insertValues = [];
        const appendColumn = (column, value) => {
            if (!availableColumns.has(column)) return;
            insertColumns.push(column);
            insertValues.push(value);
        };
        appendColumn('no_rm', noRm);
        appendColumn('nama_pasien', namaPasien);
        appendColumn('tanggal_lahir', tanggalLahir);
        appendColumn('kelamin', kelamin);
        appendColumn('alamat', alamat);
        appendColumn('kecamatan', kecamatan);
        appendColumn('kabupaten', kabupaten);
        appendColumn('provinsi', provinsi);
        appendColumn('kode_pos', kodePos);
        appendColumn('no_hp', noHp);
        appendColumn('update_simrs', updateSimrs);

        // Backward compatibility for legacy schema fields that might still be NOT NULL.
        appendColumn('patient_id', noRm);
        appendColumn('patient_name', namaPasien);
        appendColumn('dob', tanggalLahir);
        appendColumn('sex', kelamin);
        appendColumn('address', alamat);
        appendColumn('weight_kg', null);
        appendColumn('height_cm', null);

        if (!insertColumns.length) {
            return res.status(500).json({ error: 'Patients table schema is invalid or empty' });
        }

        const placeholders = insertColumns.map(() => '?').join(', ');
        const sql = `INSERT INTO patients (${insertColumns.join(', ')}) VALUES (${placeholders})`;
        const [result] = await pool.query(sql, insertValues);
        const [rows] = await pool.query(
            `
            SELECT id, no_rm, nama_pasien, tanggal_lahir, kelamin, alamat, kecamatan, kabupaten, provinsi, kode_pos, no_hp, waktu_update_pasien, update_simrs
            FROM patients
            WHERE id = ?
            `,
            [result.insertId]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to create patient' });
    }
});

app.put('/api/mwl/patients/:id', requirePermission('view_mwl_register'), async (req, res) => {
    const id = Number(req.params.id);
    const body = req.body || {};
    const noRm = String(body.no_rm || body.noRm || body.patientId || '').trim();
    const namaPasien = String(body.nama_pasien || body.namaPasien || body.patientName || '').trim();
    const tanggalLahir = normalizeStudyDate(body.tanggal_lahir || body.tanggalLahir || body.dob);
    const kelamin = normalizeSex(body.kelamin || body.sex);
    const alamat = body.alamat === undefined || body.alamat === null ? null : String(body.alamat).trim() || null;
    const kecamatan = body.kecamatan === undefined || body.kecamatan === null ? null : String(body.kecamatan).trim() || null;
    const kabupaten = body.kabupaten === undefined || body.kabupaten === null ? null : String(body.kabupaten).trim() || null;
    const provinsi = body.provinsi === undefined || body.provinsi === null ? null : String(body.provinsi).trim() || null;
    const kodePos =
        body.kode_pos === undefined || body.kode_pos === null
            ? body.kodePos === undefined || body.kodePos === null
                ? null
                : String(body.kodePos).trim() || null
            : String(body.kode_pos).trim() || null;
    const noHp =
        body.no_hp === undefined || body.no_hp === null
            ? body.noHp === undefined || body.noHp === null
                ? null
                : String(body.noHp).trim() || null
            : String(body.no_hp).trim() || null;
    const updateSimrsRaw = String(body.update_ris || body.updateSimrs || 'Y').trim().toUpperCase();
    const updateSimrs = updateSimrsRaw === 'N' ? 'N' : 'Y';
    if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid patient id' });
    }
    if (!noRm || !namaPasien || !tanggalLahir) {
        return res.status(400).json({ error: 'noRm, namaPasien and tanggalLahir are required' });
    }
    try {
        await ensureMwlTables();
        const [existing] = await pool.query('SELECT id FROM patients WHERE id = ?', [id]);
        if (!existing.length) {
            return res.status(404).json({ error: 'Patient not found' });
        }
        const [dupRows] = await pool.query('SELECT id FROM patients WHERE no_rm = ? AND id <> ?', [noRm, id]);
        if (dupRows.length) {
            return res.status(409).json({ error: 'MRN is already registered' });
        }
        await pool.query(
            `
            UPDATE patients
            SET no_rm = ?, nama_pasien = ?, tanggal_lahir = ?, kelamin = ?, alamat = ?, kecamatan = ?, kabupaten = ?, provinsi = ?, kode_pos = ?, no_hp = ?, update_simrs = ?
            WHERE id = ?
            `,
            [noRm, namaPasien, tanggalLahir, kelamin, alamat, kecamatan, kabupaten, provinsi, kodePos, noHp, updateSimrs, id]
        );
        const [rows] = await pool.query(
            `
            SELECT id, no_rm, nama_pasien, tanggal_lahir, kelamin, alamat, kecamatan, kabupaten, provinsi, kode_pos, no_hp, waktu_update_pasien, update_simrs
            FROM patients
            WHERE id = ?
            `,
            [id]
        );
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to update patient' });
    }
});

app.delete('/api/mwl/patients/:id', requirePermission('view_mwl_register'), async (req, res) => {
    const deleteReason = requireDeleteReason(req, res);
    if (!deleteReason) return;
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid patient id' });
    }
    try {
        await ensureMwlTables();
        const [orderRows] = await pool.query('SELECT id FROM mwl_orders WHERE patient_record_id = ? LIMIT 1', [id]);
        if (orderRows.length) {
            return res.status(409).json({ error: 'This patient cannot be deleted because it is already used by an order' });
        }
        const [result] = await pool.query('DELETE FROM patients WHERE id = ?', [id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Patient not found' });
        }
        await writeAuditLog(req, {
            eventType: 'delete_mwl_patient',
            outcome: 'success',
            targetType: 'mwl_patient',
            targetId: String(id),
            details: { deleteReason },
        });
        res.json({ message: 'Patient deleted' });
    } catch (err) {
        await writeAuditLog(req, {
            eventType: 'delete_mwl_patient',
            outcome: 'failure',
            targetType: 'mwl_patient',
            targetId: String(id),
            details: { deleteReason, error: err.message || 'Failed to delete patient' },
        });
        res.status(500).json({ error: err.message || 'Failed to delete patient' });
    }
});

app.use('/api/simrs', requireSimrsApiKey);

app.post('/api/simrs/integration-log', requireAnyPermission('view_mwl_order', 'view_mwl_status', 'report_export'), async (req, res) => {
    const body = req.body || {};
    const eventType = String(body.event_type || body.eventType || 'simrs_db_bridge_failed').trim();
    const direction = String(body.direction || '').trim() || null;
    const noRontgen = String(body.no_rontgen || body.noRontgen || '').trim() || null;
    const noRm = String(body.no_rm || body.noRm || '').trim() || null;
    const reason = String(body.reason || body.error || body.message || 'SIMRS DB bridge failure').trim();
    await writeSimrsFailureLog(req, {
        eventType,
        targetType: String(body.target_type || body.targetType || 'simrs_db_bridge').trim(),
        targetId: String(body.target_id || body.targetId || noRontgen || noRm || '').trim() || null,
        direction,
        noRontgen,
        noRm,
        source: String(body.source || 'db-bridge').trim(),
        reason,
        payload: body.payload || {},
        details: {
            table: body.table || null,
            database: body.database || null,
        },
    });
    res.json({ ok: true });
});

let orderInWorkerRunning = false;
let orderInWorkerRecoveredAuthErrors = false;

async function runOrderInWorker() {
    if (orderInWorkerRunning) return;
    orderInWorkerRunning = true;
    try {
        await ensureOrderInTable();
        if (!orderInWorkerRecoveredAuthErrors) {
            await pool.query("UPDATE order_in SET sync_status = 'U', sync_message = NULL WHERE sync_status = 'E' AND sync_message = 'Invalid SIMRS API key'");
            orderInWorkerRecoveredAuthErrors = true;
        }
        const [rows] = await pool.query(`
            SELECT * FROM order_in
            WHERE sync_status IN ('N', 'U')
               OR (sync_status = 'P' AND processing_at < DATE_SUB(NOW(), INTERVAL 10 MINUTE))
            ORDER BY waktu_update_orderin ASC, id ASC
            LIMIT 25
        `);
        for (const row of rows) {
            const [claim] = await pool.query(
                `UPDATE order_in SET sync_status = 'P', processing_at = NOW(), sync_message = NULL
                 WHERE id = ? AND (sync_status IN ('N','U') OR (sync_status = 'P' AND processing_at < DATE_SUB(NOW(), INTERVAL 10 MINUTE)))`,
                [row.id]
            );
            if (!claim.affectedRows) continue;
            try {
                const response = await fetch(`http://127.0.0.1:${port}/api/simrs/order-in`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-user-role': 'administrator',
                        'x-user-username': 'order-in-worker',
                        'x-ris-order-worker': '1',
                    },
                    body: JSON.stringify(row),
                });
                const text = await response.text();
                if (!response.ok) {
                    let message = text;
                    try { message = JSON.parse(text)?.error || text; } catch (_) {}
                    throw new Error(message || `Order processing failed (${response.status})`);
                }
                await pool.query("UPDATE order_in SET sync_status = 'Y', sync_message = NULL, synced_at = NOW() WHERE id = ?", [row.id]);
                await writeAuditLog(null, { eventType: 'simrs_order_in_synced', outcome: 'success', username: 'order-in-worker', targetType: 'simrs_order_in', targetId: row.no_rontgen, details: { orderInId: row.id } });
            } catch (error) {
                const message = String(error.message || error).slice(0, 500);
                await pool.query("UPDATE order_in SET sync_status = 'E', sync_message = ?, synced_at = NOW() WHERE id = ?", [message, row.id]);
                await writeAuditLog(null, { eventType: 'simrs_order_in_failed', outcome: 'failure', username: 'order-in-worker', targetType: 'simrs_order_in', targetId: row.no_rontgen, details: { orderInId: row.id, error: message } });
            }
        }
    } finally {
        orderInWorkerRunning = false;
    }
}

app.post('/api/simrs/order-in', requireAnyPermission('view_mwl_register', 'view_mwl_order'), async (req, res, next) => {
    if (String(req.headers['x-ris-order-worker'] || '') === '1') return next();
    try {
        const noRontgen = String(req.body?.no_rontgen || req.body?.accession_number || '').trim();
        if (!noRontgen) return res.status(400).json({ error: 'no_rontgen or accession_number is required' });
        const record = await upsertOrderInPayload({ ...req.body, no_rontgen: noRontgen });
        await pool.query("UPDATE order_in SET sync_status = 'N', sync_message = NULL, processing_at = NULL WHERE id = ?", [record.id]);
        setImmediate(() => runOrderInWorker().catch(error => console.error('[order-in-worker]', error.message)));
        res.status(202).json({ message: 'Order accepted for processing', source: 'order_in', order_in: { ...record, sync_status: 'N' } });
    } catch (error) {
        res.status(error.status || 500).json({ error: error.message || 'Failed to queue order' });
    }
});

app.post('/api/simrs/order-in', requireAnyPermission('view_mwl_register', 'view_mwl_order'), async (req, res) => {
    const body = req.body || {};
    const noRm = String(body.no_rm || '').trim();
    const namaPasien = String(body.nama_pasien || '').trim();
    const tanggalLahir = normalizeStudyDate(body.tanggal_lahir);
    const kelamin = normalizeSex(body.kelamin);
    const alamat = body.alamat === undefined || body.alamat === null ? null : String(body.alamat).trim() || null;
    const kecamatan = body.kecamatan === undefined || body.kecamatan === null ? null : String(body.kecamatan).trim() || null;
    const kabupaten = body.kabupaten === undefined || body.kabupaten === null ? null : String(body.kabupaten).trim() || null;
    const provinsi = body.provinsi === undefined || body.provinsi === null ? null : String(body.provinsi).trim() || null;
    const kodePos = body.kode_pos === undefined || body.kode_pos === null ? null : String(body.kode_pos).trim() || null;
    const noHp = body.no_hp === undefined || body.no_hp === null ? null : String(body.no_hp).trim() || null;
    const updateRis = String(body.update_ris || 'N').trim().toUpperCase();
    const tanggalOrderNormalized = normalizeDateTime(body.tanggal_order);
    const tanggalAktivasiNormalized = normalizeDateTime(body.tanggal_aktivasi);
    const derivedProcedureDesc = String(body.nama_pemeriksaan || body.procedure_desc || '').trim();
    const derivedProcedureCode = String(body.kode_pemeriksaan || body.procedure_code || '').trim() || null;
    const derivedNoRontgen = String(body.no_rontgen || body.accession_number || '').trim();
    const kodeDokterPengirim = String(body.kode_dokter || '').trim() || null;
    const kodeDokterRadiolog = String(body.kode_dokter_radiolog || '').trim() || null;
    const kodeRadiografer = String(body.kode_radiografer || '').trim() || null;
    if (!noRm || !namaPasien || !tanggalLahir) {
        return sendSimrsFailure(res, req, 400, 'no_rm, nama_pasien and tanggal_lahir are required', {
            eventType: 'simrs_order_in_failed',
            targetType: 'simrs_order_in',
            direction: 'order_in',
            noRm,
            noRontgen: derivedNoRontgen,
            payload: body,
        });
    }
    if (!String(body.modality || '').trim() || !derivedProcedureDesc || !String(body.klinis || '').trim()) {
        return sendSimrsFailure(res, req, 400, 'modality, nama_pemeriksaan and klinis are required', {
            eventType: 'simrs_order_in_failed',
            targetType: 'simrs_order_in',
            direction: 'order_in',
            noRm,
            noRontgen: derivedNoRontgen,
            payload: body,
        });
    }
    if (!derivedNoRontgen) {
        return sendSimrsFailure(res, req, 400, 'no_rontgen or accession_number is required', {
            eventType: 'simrs_order_in_failed',
            targetType: 'simrs_order_in',
            direction: 'order_in',
            noRm,
            payload: body,
        });
    }
    try {
        await ensureMwlTables();
        const studyMaster = await resolveStudyMasterByCodeOrId({
            id: body.study_master_id,
            procedureCode: derivedProcedureCode,
        });
        const referringDoctor = await resolveDoctorByCodeOrId({
            id: body.referring_doctor_id,
            kodeDokter: kodeDokterPengirim,
            role: 'CLINICIAN',
        });
        const radiologistDoctor = await resolveDoctorByCodeOrId({
            id: body.radiologist_doctor_id,
            kodeDokter: kodeDokterRadiolog,
            role: 'RADIOLOGIST',
        });
        const technologistDoctor = await resolveDoctorByCodeOrId({
            id: body.technologist_doctor_id,
            kodeDokter: kodeRadiografer,
            role: 'TECHNOLOGIST',
        });
        if (derivedProcedureCode && !studyMaster) {
            return sendSimrsFailure(res, req, 400, `Procedure code '${derivedProcedureCode}' not found in the study master`, {
                eventType: 'simrs_order_in_failed',
                targetType: 'simrs_order_in',
                direction: 'order_in',
                noRm,
                noRontgen: derivedNoRontgen,
                payload: body,
            });
        }
        if (studyMaster && derivedProcedureDesc) {
            const incomingStudyName = normalizeStrictCompareText(derivedProcedureDesc);
            const masterStudyName = normalizeStrictCompareText(studyMaster.study_description);
            if (incomingStudyName && masterStudyName && incomingStudyName !== masterStudyName) {
                return sendSimrsFailure(res, req, 400, `Procedure name '${derivedProcedureDesc}' does not match the study master for code '${studyMaster.procedure_code}' (${studyMaster.study_description})`, {
                    eventType: 'simrs_order_in_failed',
                    targetType: 'simrs_order_in',
                    direction: 'order_in',
                    noRm,
                    noRontgen: derivedNoRontgen,
                    payload: body,
                });
            }
        }
        if (kodeDokterPengirim && !referringDoctor) {
            return sendSimrsFailure(res, req, 400, `Referring physician code '${kodeDokterPengirim}' not found in the physician master`, {
                eventType: 'simrs_order_in_failed',
                targetType: 'simrs_order_in',
                direction: 'order_in',
                noRm,
                noRontgen: derivedNoRontgen,
                payload: body,
            });
        }
        if (referringDoctor && body.nama_dokter) {
            const incomingDoctorName = normalizeStrictCompareText(body.nama_dokter);
            const masterDoctorName = normalizeStrictCompareText(referringDoctor.nama_dokter);
            if (incomingDoctorName && masterDoctorName && incomingDoctorName !== masterDoctorName) {
                return sendSimrsFailure(res, req, 400, `Referring physician name '${body.nama_dokter}' does not match the physician master for code '${referringDoctor.kode_dokter}' (${referringDoctor.nama_dokter})`, {
                    eventType: 'simrs_order_in_failed',
                    targetType: 'simrs_order_in',
                    direction: 'order_in',
                    noRm,
                    noRontgen: derivedNoRontgen,
                    payload: body,
                });
            }
        }
        if (kodeDokterRadiolog && !radiologistDoctor) {
            return sendSimrsFailure(res, req, 400, `Radiologist code '${kodeDokterRadiolog}' not found in the physician master`, {
                eventType: 'simrs_order_in_failed',
                targetType: 'simrs_order_in',
                direction: 'order_in',
                noRm,
                noRontgen: derivedNoRontgen,
                payload: body,
            });
        }
        if (radiologistDoctor && body.nama_radiolog) {
            const incomingRadiologistName = normalizeStrictCompareText(body.nama_radiolog);
            const masterRadiologistName = normalizeStrictCompareText(radiologistDoctor.nama_dokter);
            if (incomingRadiologistName && masterRadiologistName && incomingRadiologistName !== masterRadiologistName) {
                return sendSimrsFailure(res, req, 400, `Radiologist name '${body.nama_radiolog}' does not match the physician master for code '${radiologistDoctor.kode_dokter}' (${radiologistDoctor.nama_dokter})`, {
                    eventType: 'simrs_order_in_failed',
                    targetType: 'simrs_order_in',
                    direction: 'order_in',
                    noRm,
                    noRontgen: derivedNoRontgen,
                    payload: body,
                });
            }
        }
        if (kodeRadiografer && !technologistDoctor) {
            return sendSimrsFailure(res, req, 400, `Technologist code '${kodeRadiografer}' not found in the physician master`, {
                eventType: 'simrs_order_in_failed',
                targetType: 'simrs_order_in',
                direction: 'order_in',
                noRm,
                noRontgen: derivedNoRontgen,
                payload: body,
            });
        }
        if (technologistDoctor && body.nama_radiografer) {
            const incomingTechnologistName = normalizeStrictCompareText(body.nama_radiografer);
            const masterTechnologistName = normalizeStrictCompareText(technologistDoctor.nama_dokter);
            if (incomingTechnologistName && masterTechnologistName && incomingTechnologistName !== masterTechnologistName) {
                return sendSimrsFailure(res, req, 400, `Technologist name '${body.nama_radiografer}' does not match the physician master for code '${technologistDoctor.kode_dokter}' (${technologistDoctor.nama_dokter})`, {
                    eventType: 'simrs_order_in_failed',
                    targetType: 'simrs_order_in',
                    direction: 'order_in',
                    noRm,
                    noRontgen: derivedNoRontgen,
                    payload: body,
                });
            }
        }
        const [existingPatients] = await pool.query('SELECT id FROM patients WHERE no_rm = ? ORDER BY id DESC LIMIT 1', [noRm]);
        let patientId = existingPatients[0]?.id || null;
        if (patientId) {
            await pool.query(
                `
                UPDATE patients
                SET nama_pasien = ?, tanggal_lahir = ?, kelamin = ?, alamat = ?, kecamatan = ?, kabupaten = ?, provinsi = ?, kode_pos = ?, no_hp = ?, update_simrs = ?
                WHERE id = ?
                `,
                [namaPasien, tanggalLahir, kelamin, alamat, kecamatan, kabupaten, provinsi, kodePos, noHp, updateRis === 'Y' ? 'Y' : 'N', patientId]
            );
        } else {
            const [columnRows] = await pool.query(
                `
                SELECT column_name
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE table_schema = current_schema()
                  AND TABLE_NAME = 'patients'
                `
            );
            const availableColumns = new Set(columnRows.map(row => row.column_name));
            const insertColumns = [];
            const insertValues = [];
            const appendColumn = (column, value) => {
                if (!availableColumns.has(column)) return;
                insertColumns.push(column);
                insertValues.push(value);
            };
            appendColumn('no_rm', noRm);
            appendColumn('nama_pasien', namaPasien);
            appendColumn('tanggal_lahir', tanggalLahir);
            appendColumn('kelamin', kelamin);
            appendColumn('alamat', alamat);
            appendColumn('kecamatan', kecamatan);
            appendColumn('kabupaten', kabupaten);
            appendColumn('provinsi', provinsi);
            appendColumn('kode_pos', kodePos);
            appendColumn('no_hp', noHp);
            appendColumn('update_simrs', updateRis === 'Y' ? 'Y' : 'N');
            appendColumn('patient_id', noRm);
            appendColumn('patient_name', namaPasien);
            appendColumn('dob', tanggalLahir);
            appendColumn('sex', kelamin);
            appendColumn('address', alamat);
            appendColumn('weight_kg', null);
            appendColumn('height_cm', null);
            const placeholders = insertColumns.map(() => '?').join(', ');
            const [result] = await pool.query(
                `
                INSERT INTO patients (${insertColumns.join(', ')})
                VALUES (${placeholders})
                `,
                insertValues
            );
            patientId = result.insertId;
        }

        const orderInRecord = await upsertOrderInPayload({
            tanggal_order: tanggalOrderNormalized || body.tanggal_order,
            tanggal_aktivasi: tanggalAktivasiNormalized || body.tanggal_aktivasi,
            no_rm: noRm,
            nama_pasien: namaPasien,
            tanggal_lahir: tanggalLahir,
            kelamin,
            alamat,
            kecamatan,
            kabupaten,
            provinsi,
            kode_pos: kodePos,
            no_hp: noHp,
            no_register: body.no_register,
            no_rontgen: derivedNoRontgen,
            klinis: body.klinis,
            diagnosa: body.diagnosa,
            kode_pemeriksaan: derivedProcedureCode,
            nama_pemeriksaan: derivedProcedureDesc,
            modality: body.modality,
            cito: normalizeCito(body.cito),
            polirawat: body.polirawat || body.rawatinap,
            kode_ruangan: body.kode_ruangan,
            nama_ruangan: body.nama_ruangan,
            kode_dokter: kodeDokterPengirim,
            nama_dokter: body.nama_dokter,
            kode_dokter_radiolog: kodeDokterRadiolog,
            nama_radiolog: body.nama_radiolog,
            kode_radiografer: kodeRadiografer,
            nama_radiografer: body.nama_radiografer,
            cara_bayar: body.cara_bayar,
            kode_asuransi: body.kode_asuransi,
            nama_asuransi: body.nama_asuransi,
            kode_instalasi_radiologi: body.kode_instalasi_radiologi,
            nama_instalasi_radiologi: body.nama_instalasi_radiologi,
            update_ris: updateRis,
            referring_physician: body.nama_dokter || body.referring_physician || null,
        });

        const mwlSync = await upsertMwlOrderFromOrderIn({
            orderIn: orderInRecord,
            patientRecordId: patientId,
            studyMasterId: studyMaster?.id || null,
            referringDoctorId: referringDoctor?.id || null,
            radiologistDoctorId: radiologistDoctor?.id || null,
            referringPhysician: body.nama_dokter || body.referring_physician || null,
        });
        const mwlOrder = mwlSync?.id ? await loadOrderOutSource({ orderId: mwlSync.id }) : null;

        res.status(mwlSync?.created ? 201 : 200).json({
            message: 'SIMRS order-in processed successfully',
            source: 'order_in',
            order_in: orderInRecord,
            mwl_order: mwlOrder,
        });
    } catch (err) {
        await writeSimrsFailureLog(req, {
            eventType: 'simrs_order_in_failed',
            targetType: 'simrs_order_in',
            direction: 'order_in',
            noRm,
            noRontgen: derivedNoRontgen,
            payload: body,
            reason: err.message || 'Failed to process SIMRS order-in',
        });
        res.status(err.status || 500).json({ error: err.message || 'Failed to process SIMRS order-in' });
    }
});

app.get('/api/simrs/order-in', requireAnyPermission('view_mwl_order', 'view_mwl_status'), async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const updateRis = typeof req.query.update_ris === 'string' ? req.query.update_ris.trim().toUpperCase() : '';
    const filters = [];
    const params = [];
    if (q) {
        const like = `%${q}%`;
        filters.push('(no_rm LIKE ? OR nama_pasien LIKE ? OR no_register LIKE ? OR no_rontgen LIKE ?)');
        params.push(like, like, like, like);
    }
    if (updateRis) {
        filters.push('update_ris = ?');
        params.push(updateRis);
    }
    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    try {
        await ensureOrderInTable();
        const [rows] = await pool.query(
            `
            SELECT *
            FROM order_in
            ${whereClause}
            ORDER BY waktu_update_orderin DESC, id DESC
            LIMIT 500
            `,
            params
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to fetch order_in' });
    }
});

app.get('/api/simrs/order-in/:noRontgen', requireAnyPermission('view_mwl_order', 'view_mwl_status'), async (req, res) => {
    const noRontgen = String(req.params.noRontgen || '').trim();
    if (!noRontgen) {
        return res.status(400).json({ error: 'no_rontgen is required' });
    }
    try {
        await ensureOrderInTable();
        const [rows] = await pool.query('SELECT * FROM order_in WHERE no_rontgen = ? LIMIT 1', [noRontgen]);
        if (!rows.length) {
            return res.status(404).json({ error: 'Order-in not found' });
        }
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to fetch SIMRS order-in detail' });
    }
});

app.patch('/api/simrs/order-in/:noRontgen', requireAnyPermission('view_mwl_register', 'view_mwl_order'), async (req, res) => {
    const noRontgen = String(req.params.noRontgen || '').trim();
    const body = req.body || {};
    if (!noRontgen) {
        return res.status(400).json({ error: 'no_rontgen is required' });
    }
    try {
        await ensureOrderInTable();
        await ensureMwlTables();
        const [existingRows] = await pool.query('SELECT * FROM order_in WHERE no_rontgen = ? LIMIT 1', [noRontgen]);
        const existing = existingRows[0] || null;
        if (!existing) {
            return res.status(404).json({ error: 'Order-in not found' });
        }

        const requestedStatus = String(body.status || body.order_status || '').trim().toUpperCase();
        const requestedUpdateRis = String(body.update_ris || body.updateRis || existing.update_ris || 'N').trim().toUpperCase();
        const shouldCancel =
            body.cancel === true ||
            String(body.action || '').trim().toLowerCase() === 'cancel' ||
            requestedStatus === 'CANCELLED' ||
            requestedUpdateRis === 'C';
        const normalizedUpdateRis = shouldCancel ? 'C' : requestedUpdateRis === 'Y' ? 'Y' : 'N';
        const pick = (field, fallback = null) =>
            body[field] === undefined || body[field] === null ? fallback : body[field];

        const merged = {
            ...existing,
            tanggal_order: pick('tanggal_order', existing.tanggal_order),
            tanggal_aktivasi: pick('tanggal_aktivasi', existing.tanggal_aktivasi),
            no_rm: pick('no_rm', existing.no_rm),
            nama_pasien: pick('nama_pasien', existing.nama_pasien),
            tanggal_lahir: pick('tanggal_lahir', existing.tanggal_lahir),
            kelamin: pick('kelamin', existing.kelamin),
            alamat: pick('alamat', existing.alamat),
            kecamatan: pick('kecamatan', existing.kecamatan),
            kabupaten: pick('kabupaten', existing.kabupaten),
            provinsi: pick('provinsi', existing.provinsi),
            kode_pos: pick('kode_pos', existing.kode_pos),
            no_hp: pick('no_hp', existing.no_hp),
            no_register: pick('no_register', existing.no_register),
            no_rontgen: noRontgen,
            klinis: pick('klinis', existing.klinis),
            diagnosa: pick('diagnosa', existing.diagnosa),
            kode_pemeriksaan: pick('kode_pemeriksaan', pick('procedure_code', existing.kode_pemeriksaan)),
            nama_pemeriksaan: pick('nama_pemeriksaan', pick('procedure_desc', existing.nama_pemeriksaan)),
            modality: pick('modality', existing.modality),
            cito: pick('cito', existing.cito),
            polirawat: pick('polirawat', pick('rawatinap', existing.polirawat)),
            kode_ruangan: pick('kode_ruangan', existing.kode_ruangan),
            nama_ruangan: pick('nama_ruangan', existing.nama_ruangan),
            kode_dokter: pick('kode_dokter', existing.kode_dokter),
            nama_dokter: pick('nama_dokter', existing.nama_dokter),
            kode_admin: pick('kode_admin', existing.kode_admin),
            nama_admin: pick('nama_admin', existing.nama_admin),
            kode_dokter_radiolog: pick('kode_dokter_radiolog', existing.kode_dokter_radiolog),
            nama_radiolog: pick('nama_radiolog', existing.nama_radiolog),
            kode_radiografer: pick('kode_radiografer', existing.kode_radiografer),
            nama_radiografer: pick('nama_radiografer', existing.nama_radiografer),
            cara_bayar: pick('cara_bayar', existing.cara_bayar),
            kode_asuransi: pick('kode_asuransi', existing.kode_asuransi),
            nama_asuransi: pick('nama_asuransi', existing.nama_asuransi),
            kode_instalasi_radiologi: pick('kode_instalasi_radiologi', existing.kode_instalasi_radiologi),
            nama_instalasi_radiologi: pick('nama_instalasi_radiologi', existing.nama_instalasi_radiologi),
            alasan: pick('alasan', shouldCancel ? 'Order dibatalkan dari SIMRS' : existing.alasan),
            update_ris: normalizedUpdateRis,
        };

        const orderInRecord = await upsertOrderInPayload(merged, {
            updateRis: normalizedUpdateRis,
            alasan: merged.alasan,
        });

        const [patientRows] = await pool.query('SELECT id FROM patients WHERE no_rm = ? LIMIT 1', [orderInRecord.no_rm]);
        const [mwlRows] = await pool.query(
            'SELECT id, patient_record_id FROM mwl_orders WHERE no_rontgen = ? OR accession_number = ? ORDER BY id DESC LIMIT 1',
            [noRontgen, noRontgen]
        );
        const patientRecordId = patientRows?.[0]?.id || mwlRows?.[0]?.patient_record_id || null;
        const mwlSync = await upsertMwlOrderFromOrderIn({ orderIn: orderInRecord, patientRecordId });
        if (shouldCancel) {
            const affectedOrderIds = Array.from(
                new Set(
                    [mwlSync?.id, ...(mwlRows || []).map(row => row.id)]
                        .map(value => Number(value))
                        .filter(value => Number.isFinite(value) && value > 0)
                )
            );
            for (const orderId of affectedOrderIds) {
                await closeMwlLogsForOrder(orderId, 'Order cancelled from SIMRS', 'CANCELLED');
            }
            await pool.query(
                `
                UPDATE mwl_orders
                SET status = 'CANCELLED', update_ris = 'C'
                WHERE no_rontgen = ? OR accession_number = ?
                `,
                [noRontgen, noRontgen]
            );
        }

        const [updatedRows] = await pool.query('SELECT * FROM order_in WHERE no_rontgen = ? LIMIT 1', [noRontgen]);
        res.json({
            message: shouldCancel ? 'SIMRS order-in cancelled successfully' : 'SIMRS order-in updated successfully',
            order_in: updatedRows[0] || orderInRecord,
            mwl_order_id: mwlSync?.id || mwlRows?.[0]?.id || null,
        });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Failed to update SIMRS order-in' });
    }
});

app.get('/api/simrs/order-out', requireAnyPermission('report_export', 'view_mwl_status'), async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const updateRis = typeof req.query.update_ris === 'string' ? req.query.update_ris.trim().toUpperCase() : '';
    const noRontgen = typeof req.query.no_rontgen === 'string' ? req.query.no_rontgen.trim() : '';
    const noRm = typeof req.query.no_rm === 'string' ? req.query.no_rm.trim() : '';
    const from = normalizeDateTime(req.query.date_from || req.query.from);
    const to = normalizeDateTime(req.query.date_to || req.query.to);
    const pageRaw = Number(req.query.page || 1);
    const limitRaw = Number(req.query.limit || req.query.rows || 100);
    const page = Number.isFinite(pageRaw) ? Math.max(Math.trunc(pageRaw), 1) : 1;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 500) : 100;
    const offset = (page - 1) * limit;
    const filters = [];
    const params = [];

    if (q) {
        const like = `%${q}%`;
        filters.push('(no_rm LIKE ? OR no_register LIKE ? OR no_rontgen LIKE ? OR nama_radiolog LIKE ? OR nama_radiografer LIKE ?)');
        params.push(like, like, like, like, like);
    }
    if (noRontgen) {
        filters.push('no_rontgen = ?');
        params.push(noRontgen);
    }
    if (noRm) {
        filters.push('no_rm = ?');
        params.push(noRm);
    }
    if (updateRis && updateRis !== 'ALL') {
        filters.push('update_ris = ?');
        params.push(updateRis);
    }
    if (from) {
        filters.push('waktu_update_orderout >= ?');
        params.push(from);
    }
    if (to) {
        filters.push('waktu_update_orderout <= ?');
        params.push(to);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    try {
        await ensureOrderOutTable();
        const [countRows] = await pool.query(`SELECT COUNT(*) AS total FROM order_out ${whereClause}`, params);
        const total = Number(countRows?.[0]?.total || 0);
        const [rows] = await pool.query(
            `
            SELECT *
            FROM order_out
            ${whereClause}
            ORDER BY waktu_update_orderout DESC, id DESC
            LIMIT ? OFFSET ?
            `,
            [...params, limit, offset]
        );
        res.json({ rows, total, page, limit });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to fetch SIMRS order-out' });
    }
});

app.post('/api/simrs/order-out', requireAnyPermission('report_export', 'view_mwl_status'), async (req, res) => {
    const body = req.body || {};
    const noRontgen = String(body.no_rontgen || '').trim();
    const updateRis = String(body.update_ris || 'N').trim().toUpperCase();
    const alasan = body.alasan === undefined || body.alasan === null ? null : String(body.alasan).trim() || null;
    if (!noRontgen) {
        return sendSimrsFailure(res, req, 400, 'no_rontgen is required', {
            eventType: 'simrs_order_out_failed',
            targetType: 'simrs_order_out',
            direction: 'order_out',
            payload: body,
        });
    }
    try {
        await ensureMwlTables();
        await ensureOrderOutTable();
        const [orderRows] = await pool.query(
            `
            SELECT
              o.*,
              oi.no_rm,
              oi.nama_pasien,
              dref.kode_dokter AS referring_doctor_code,
              dref.nama_dokter AS referring_doctor_name,
              drad.kode_dokter AS radiologist_doctor_code,
              drad.nama_dokter AS radiologist_doctor_name,
              dtech.kode_dokter AS technologist_username,
              dtech.nama_dokter AS technologist_name
            FROM mwl_orders o
            LEFT JOIN order_in oi ON oi.no_rontgen = o.no_rontgen
            LEFT JOIN mwl_doctors dref ON dref.kode_dokter = COALESCE(o.kode_dokter, oi.kode_dokter)
            LEFT JOIN mwl_doctors drad ON drad.kode_dokter = COALESCE(o.kode_dokter_radiolog, oi.kode_dokter_radiolog)
            LEFT JOIN mwl_doctors dtech ON dtech.kode_dokter = COALESCE(o.kode_radiografer, oi.kode_radiografer)
            WHERE o.no_rontgen = ?
            ORDER BY o.id DESC
            LIMIT 1
            `,
            [noRontgen]
        );
        if (!orderRows.length) {
            return sendSimrsFailure(res, req, 404, 'No order found with that no_rontgen', {
                eventType: 'simrs_order_out_failed',
                targetType: 'simrs_order_out',
                direction: 'order_out',
                noRontgen,
                payload: body,
            });
        }
        const order = orderRows[0];
        let assignedStaff = [];
        try {
            const parsedAssigned = parseJsonValue(order.assigned_staff_json, []);
            assignedStaff = Array.isArray(parsedAssigned) ? parsedAssigned : [];
        } catch (error) {
            assignedStaff = [];
        }
        const assignedRadiologist = assignedStaff.find(item => item?.role === 'RADIOLOGIST');
        const assignedTechnologists = assignedStaff.filter(item => item?.role === 'TECHNOLOGIST');
        const effectiveStudyInstanceUid = order.actual_study_instance_uid || order.study_instance_uid || null;
        const [reportRows] = await pool.query(
            `
            SELECT r.*, u.name AS radiologist_name
            FROM radiology_reports r
            LEFT JOIN users u ON u.id = r.radiologist_id
            WHERE r.study_instance_uid = ?
            LIMIT 1
            `,
            [effectiveStudyInstanceUid]
        );
        const report = reportRows[0] || null;
        let hasPacsImages = false;
        if (effectiveStudyInstanceUid) {
            try {
                hasPacsImages = (await dicomwebPacs.getStudyInstanceCount(effectiveStudyInstanceUid)) > 0;
            } catch (err) {
                hasPacsImages = false;
            }
        }
        const share = effectiveStudyInstanceUid && hasPacsImages
            ? await getOrCreatePublicShareLinkForStudy(effectiveStudyInstanceUid, getRoleFromRequest(req))
            : null;

        const appLinkSettings = readAppLinkSettings();
        const publicBaseUrl = appLinkSettings.publicBaseUrl;
        const needsViewerAccessLink = Object.values(appLinkSettings.orderOutLinks || {}).some(rule => rule?.enabled && rule.type === 'viewer');
        const viewerAccessLink = order.accession_number && effectiveStudyInstanceUid && hasPacsImages
            && needsViewerAccessLink
            ? await getOrCreateViewerAccessLinkForAccession(
                  order.accession_number,
                  effectiveStudyInstanceUid,
                  req,
                  order.kode_dokter_radiolog || order.kode_admin || null
              )
            : null;
        const orderOutLinks = buildOrderOutLinks({
            order,
            appLinkSettings,
            publicBaseUrl,
            viewerAccessLink,
            share,
            body,
        });

        const kodeUserAdmin = String(body.kode_user_admin || body.kode_admin || order.kode_admin || '').trim() || null;
        const namaUserAdmin = String(body.nama_user_admin || body.nama_admin || order.nama_admin || '').trim() || null;
        const kodeRadiografer = String(body.kode_radiografer || order.kode_radiografer || assignedTechnologists[0]?.kode_dokter || '').trim() || null;
        const namaRadiografer = String(body.nama_radiografer || order.nama_radiografer || assignedTechnologists.map(item => item?.nama_dokter).filter(Boolean).join(', ') || order.technologist_name || order.technologist_username || '').trim() || null;
        const kodeRadiolog = String(body.kode_radiolog || body.kode_dokter_radiolog || order.kode_dokter_radiolog || assignedRadiologist?.kode_dokter || order.radiologist_doctor_code || '').trim() || null;
        const namaRadiolog = String(body.nama_radiolog || order.nama_radiolog || assignedRadiologist?.nama_dokter || report?.radiologist_name || order.radiologist_doctor_name || '').trim() || null;

        const payload = {
            no_rm: String(body.no_rm || order.no_rm || '').trim() || null,
            no_rontgen: noRontgen,
            no_register: String(body.no_register || order.no_register || '').trim() || null,
            kode_user_admin: kodeUserAdmin,
            nama_user_admin: namaUserAdmin,
            admin_datetime_start: toNullableDateTime(body.admin_datetime_start || order.tanggal_order || null),
            admin_datetime_end: toNullableDateTime(body.admin_datetime_end || order.tanggal_aktivasi || order.waktu_update_orderin || null),
            kode_radiografer: kodeRadiografer,
            nama_radiografer: namaRadiografer,
            radiografer_datetime_start: toNullableDateTime(body.radiografer_datetime_start || null),
            radiografer_datetime_end: toNullableDateTime(body.radiografer_datetime_end || null),
            kode_radiolog: kodeRadiolog,
            nama_radiolog: namaRadiolog,
            radiolog_datetime_start: toNullableDateTime(body.radiolog_datetime_start || report?.created_at || null),
            radiolog_datetime_end: toNullableDateTime(body.radiolog_datetime_end || report?.finalized_at || report?.updated_at || null),
            klinis: String(body.klinis || order.klinis || '').trim().slice(0, 15) || null,
            cito: normalizeCito(body.cito ?? order.cito ?? '0') || '0',
            kritis: String(body.kritis || '0').trim().slice(0, 1) || '0',
            expertise_text_finding: body.expertise_text_finding ?? toPlainTextReport(report?.findings) ?? null,
            expertise_text_conclusion: body.expertise_text_conclusion ?? toPlainTextReport(report?.conclusion) ?? null,
            expertise_html_finding: body.expertise_html_finding ?? toHtmlParagraphs(report?.findings) ?? null,
            expertise_html_conclusion: body.expertise_html_conclusion ?? toHtmlParagraphs(report?.conclusion) ?? null,
            urllink1: orderOutLinks.urllink1,
            urllink2: orderOutLinks.urllink2,
            urllink3: orderOutLinks.urllink3,
            urllink4: orderOutLinks.urllink4,
            urllink5: orderOutLinks.urllink5,
            urllink6: orderOutLinks.urllink6,
            alasan,
            update_ris: updateRis === 'Y' || updateRis === 'C' ? updateRis : 'N',
        };

        await pool.query(
            `
            INSERT INTO order_out (
              no_rm, no_rontgen, no_register, kode_user_admin, nama_user_admin,
              admin_datetime_start, admin_datetime_end, kode_radiografer, nama_radiografer,
              radiografer_datetime_start, radiografer_datetime_end, kode_radiolog, nama_radiolog,
              radiolog_datetime_start, radiolog_datetime_end, klinis, cito, kritis,
              expertise_text_finding, expertise_text_conclusion, expertise_html_finding, expertise_html_conclusion,
              urllink1, urllink2, urllink3, urllink4, urllink5, urllink6, alasan, update_ris
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
              no_rm = VALUES(no_rm),
              no_register = VALUES(no_register),
              kode_user_admin = VALUES(kode_user_admin),
              nama_user_admin = VALUES(nama_user_admin),
              admin_datetime_start = VALUES(admin_datetime_start),
              admin_datetime_end = VALUES(admin_datetime_end),
              kode_radiografer = VALUES(kode_radiografer),
              nama_radiografer = VALUES(nama_radiografer),
              radiografer_datetime_start = VALUES(radiografer_datetime_start),
              radiografer_datetime_end = VALUES(radiografer_datetime_end),
              kode_radiolog = VALUES(kode_radiolog),
              nama_radiolog = VALUES(nama_radiolog),
              radiolog_datetime_start = VALUES(radiolog_datetime_start),
              radiolog_datetime_end = VALUES(radiolog_datetime_end),
              klinis = VALUES(klinis),
              cito = VALUES(cito),
              kritis = VALUES(kritis),
              expertise_text_finding = VALUES(expertise_text_finding),
              expertise_text_conclusion = VALUES(expertise_text_conclusion),
              expertise_html_finding = VALUES(expertise_html_finding),
              expertise_html_conclusion = VALUES(expertise_html_conclusion),
              urllink1 = VALUES(urllink1),
              urllink2 = VALUES(urllink2),
              urllink3 = VALUES(urllink3),
              urllink4 = VALUES(urllink4),
              urllink5 = VALUES(urllink5),
              urllink6 = VALUES(urllink6),
              alasan = VALUES(alasan),
              update_ris = VALUES(update_ris),
              waktu_update_orderout = CURRENT_TIMESTAMP
            `,
            [
                payload.no_rm,
                payload.no_rontgen,
                payload.no_register,
                payload.kode_user_admin,
                payload.nama_user_admin,
                payload.admin_datetime_start,
                payload.admin_datetime_end,
                payload.kode_radiografer,
                payload.nama_radiografer,
                payload.radiografer_datetime_start,
                payload.radiografer_datetime_end,
                payload.kode_radiolog,
                payload.nama_radiolog,
                payload.radiolog_datetime_start,
                payload.radiolog_datetime_end,
                payload.klinis,
                payload.cito,
                payload.kritis,
                payload.expertise_text_finding,
                payload.expertise_text_conclusion,
                payload.expertise_html_finding,
                payload.expertise_html_conclusion,
                payload.urllink1,
                payload.urllink2,
                payload.urllink3,
                payload.urllink4,
                payload.urllink5,
                payload.urllink6,
                payload.alasan,
                payload.update_ris,
            ]
        );

        const [rows] = await pool.query('SELECT * FROM order_out WHERE no_rontgen = ?', [noRontgen]);
        res.status(201).json({
            message: 'Order out processed successfully',
            source: {
                order_id: order.id,
                study_instance_uid: effectiveStudyInstanceUid,
                report_status: report?.status || null,
                assigned_staff: assignedStaff,
            },
            order_out: rows[0],
        });
    } catch (err) {
        await writeSimrsFailureLog(req, {
            eventType: 'simrs_order_out_failed',
            targetType: 'simrs_order_out',
            direction: 'order_out',
            noRontgen,
            payload: body,
            reason: err.message || 'Failed to process SIMRS order-out',
        });
        res.status(500).json({ error: err.message || 'Failed to process SIMRS order-out' });
    }
});

app.get('/api/simrs/order-out/:noRontgen', requireAnyPermission('report_export', 'view_mwl_status'), async (req, res) => {
    const noRontgen = String(req.params.noRontgen || '').trim();
    if (!noRontgen) {
        return res.status(400).json({ error: 'no_rontgen is required' });
    }
    try {
        await ensureOrderOutTable();
        const [rows] = await pool.query('SELECT * FROM order_out WHERE no_rontgen = ? LIMIT 1', [noRontgen]);
        if (!rows.length) {
            return res.status(404).json({ error: 'Order-out not found' });
        }
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to fetch SIMRS order-out detail' });
    }
});

app.patch('/api/simrs/order-out/:noRontgen/ack', requireAnyPermission('report_export', 'view_mwl_status'), async (req, res) => {
    const noRontgen = String(req.params.noRontgen || '').trim();
    const body = req.body || {};
    const updateRisRaw = String(body.update_ris || body.updateRis || 'Y').trim().toUpperCase();
    const updateRis = updateRisRaw === 'C' ? 'C' : updateRisRaw === 'N' ? 'N' : 'Y';
    const alasan = body.alasan === undefined || body.alasan === null ? null : String(body.alasan).trim() || null;
    if (!noRontgen) {
        return sendSimrsFailure(res, req, 400, 'no_rontgen is required', {
            eventType: 'simrs_order_out_ack_failed',
            targetType: 'simrs_order_out',
            direction: 'order_out_ack',
            payload: body,
        });
    }
    try {
        await ensureOrderOutTable();
        const [existingRows] = await pool.query('SELECT id FROM order_out WHERE no_rontgen = ? LIMIT 1', [noRontgen]);
        if (!existingRows.length) {
            return sendSimrsFailure(res, req, 404, 'Order-out not found', {
                eventType: 'simrs_order_out_ack_failed',
                targetType: 'simrs_order_out',
                direction: 'order_out_ack',
                noRontgen,
                payload: body,
            });
        }
        await pool.query(
            `
            UPDATE order_out
            SET update_ris = ?,
                alasan = COALESCE(?, alasan),
                waktu_update_orderout = CURRENT_TIMESTAMP
            WHERE no_rontgen = ?
            `,
            [updateRis, alasan, noRontgen]
        );
        const [rows] = await pool.query('SELECT * FROM order_out WHERE no_rontgen = ? LIMIT 1', [noRontgen]);
        res.json({
            message: 'SIMRS order-out acknowledgement saved',
            order_out: rows[0],
        });
    } catch (err) {
        await writeSimrsFailureLog(req, {
            eventType: 'simrs_order_out_ack_failed',
            targetType: 'simrs_order_out',
            direction: 'order_out_ack',
            noRontgen,
            payload: body,
            reason: err.message || 'Failed to acknowledge SIMRS order-out',
        });
        res.status(500).json({ error: err.message || 'Failed to acknowledge SIMRS order-out' });
    }
});

app.get(
    '/api/mwl/orders',
    requireAnyPermission('view_worklist', 'view_dicom_manager', 'view_mwl_order', 'view_mwl_technologist', 'view_mwl_status', 'view_radiologist', 'view_quality_control', 'view_dose_monitor'),
    async (req, res) => {
        const status = typeof req.query.status === 'string' ? req.query.status.trim().toUpperCase() : '';
        const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
        const includeDeleted = ['1', 'true', 'yes', 'on'].includes(String(req.query.includeDeleted || '').trim().toLowerCase());
        const requestedLimit = Number(req.query.limit);
        const limit = Number.isFinite(requestedLimit)
            ? Math.max(1, Math.min(5000, Math.floor(requestedLimit)))
            : 300;
        const requestedOffset = Number(req.query.offset);
        const offset = Number.isFinite(requestedOffset)
            ? Math.max(0, Math.floor(requestedOffset))
            : 0;
        const rawDateMode = typeof req.query.dateMode === 'string' ? req.query.dateMode : '';
        const rawDateFrom = typeof req.query.dateFrom === 'string' ? req.query.dateFrom : '';
        const rawDateTo = typeof req.query.dateTo === 'string' ? req.query.dateTo : '';
        // A free-text search intentionally spans all dates, matching the previous
        // UI behaviour where the search box bypassed the date filter.
        const dateBounds = q ? null : buildWorklistDateBounds(rawDateMode, rawDateFrom, rawDateTo);
        // Custom range still incomplete (or inverted): answer with an empty page.
        // Falling through to "no date filter" here is exactly what used to return the
        // newest orders for a range the user had not picked yet.
        if (dateBounds && dateBounds.empty) {
            return res.json([]);
        }
        const filters = [];
        const params = [];
        if (!includeDeleted) {
            filters.push('o.deleted_at IS NULL');
        }
        // Bound on created_at (exactly what `ORDER BY o.created_at DESC` sorts on,
        // so the composite index serves both the range and the ordering) and let
        // the inclusive upper bound absorb rows whose study_date is still NULL.
        if (dateBounds) {
            if (dateBounds.from) {
                filters.push('o.created_at >= CAST(? AS date)');
                params.push(dateBounds.from);
            }
            if (dateBounds.to) {
                // `date + 1` is the valid form; `INTERVAL 1 DAY` without quotes is a
                // PostgreSQL syntax error and returned HTTP 500 on every dated request.
                filters.push('o.created_at < CAST(? AS date) + 1');
                params.push(dateBounds.to);
            }
        }
        if (status) {
            filters.push('o.status = ?');
            params.push(status);
        }
        if (q) {
            filters.push('(o.accession_number LIKE ? OR o.no_rontgen LIKE ? OR o.no_register LIKE ? OR p.no_rm LIKE ? OR p.nama_pasien LIKE ?)');
            const like = `%${q}%`;
            params.push(like, like, like, like, like);
        }
        const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
        try {
            await ensureMwlTables();
            await scheduleMwlCompletionSync(req);
            const [rows] = await pool.query(
                `
                SELECT
                    o.*,
                    COALESCE(oi.tanggal_aktivasi, o.tanggal_aktivasi) AS tanggal_aktivasi,
${ORDER_IN_SOURCE_SELECT}
                    p.no_rm,
                    p.nama_pasien,
                    p.tanggal_lahir,
                    p.kelamin,
                    p.alamat,
                    p.kecamatan,
                    p.kabupaten,
                    p.provinsi,
                    p.kode_pos,
                    p.no_hp,
                    p.update_simrs,
                    p.waktu_update_pasien,
                    dtech.id AS technologist_id,
                    dtech.kode_dokter AS technologist_username,
                    dtech.nama_dokter AS technologist_name,
                    dref.id AS referring_doctor_id,
                    dref.nama_dokter AS referring_doctor_name,
                    dref.kode_dokter AS referring_doctor_code,
                    drad.id AS radiologist_doctor_id,
                    drad.nama_dokter AS radiologist_doctor_name,
                    drad.kode_dokter AS radiologist_doctor_code,
                    s.id AS study_master_id,
                    s.procedure_code AS study_master_procedure_code,
                    s.modality_code AS study_master_modality_code,
                    s.study_description AS study_master_description,
                    m.id AS modality_station_id,
                    m.nama_ruangan AS modality_station_room,
                    m.ae_title_station AS modality_station_aet_master,
                    COALESCE(ml.has_active_mwl, 0) AS has_active_mwl
                FROM mwl_orders o
                INNER JOIN patients p ON p.id = o.patient_record_id
                ${ORDER_IN_SOURCE_JOIN}
                ${MWL_MASTER_SOURCE_JOINS}
                ${MWL_ACTIVE_LOG_JOIN}
                ${whereClause}
                ORDER BY o.created_at DESC
                LIMIT ? OFFSET ?
                `,
                [...params, limit, offset]
            );
            res.json(rows);
        } catch (err) {
            res.status(500).json({ error: err.message || 'Failed to fetch orders' });
        }
    }
);

app.post('/api/mwl/orders', requirePermission('view_mwl_order'), async (req, res) => {
    const body = req.body || {};
    const patientRecordId = Number(body.patient_record_id ?? body.patientRecordId);
    const studyMasterId = body.study_master_id === undefined || body.study_master_id === null || body.study_master_id === ''
        ? body.studyMasterId === undefined || body.studyMasterId === null || body.studyMasterId === ''
            ? null
            : Number(body.studyMasterId)
        : Number(body.study_master_id);
    const noRm = String(body.no_rm || body.noRm || body.patientId || '').trim();
    const accessionNumberRaw = String(body.accession_number || body.accessionNumber || '').trim();
    const studyDate = normalizeStudyDate(body.study_date || body.studyDate);
    const studyTime = normalizeStudyTime(body.study_time || body.studyTime);
    const tanggalOrder = normalizeDateTime(body.tanggal_order || body.tanggalOrder) || normalizeDateTime(new Date().toISOString());
    const tanggalAktivasi = normalizeDateTime(body.tanggal_aktivasi || body.tanggalAktivasi);
    const modality = normalizeModality(body.modality);
    const procedureCode = String(body.kode_pemeriksaan || body.procedure_code || body.procedureCode || '').trim() || null;
    const procedureDesc = String(body.nama_pemeriksaan || body.procedure_desc || body.procedureDesc || '').trim();
    const klinis = String(body.klinis || '').trim() || null;
    const diagnosa = String(body.diagnosa || '').trim() || null;
    const kodePemeriksaan = String(body.kode_pemeriksaan || body.kodePemeriksaan || procedureCode || '').trim() || null;
    const namaPemeriksaan = String(body.nama_pemeriksaan || body.namaPemeriksaan || procedureDesc || '').trim() || null;
    const cito = normalizeCito(body.cito);
    const polirawat = String(body.polirawat || body.rawatinap || '').trim() || null;
    const kodeRuangan = String(body.kode_ruangan || body.kodeRuangan || '').trim() || null;
    const namaRuangan = String(body.nama_ruangan || body.namaRuangan || '').trim() || null;
    const referringPhysician = String(body.referring_physician || body.referringPhysician || body.nama_dokter || '').trim() || null;
    const noRegister = String(body.no_register || body.noRegister || '').trim() || null;
    const caraBayar = String(body.cara_bayar || body.caraBayar || '').trim() || null;
    const kodeAsuransi = String(body.kode_asuransi || body.kodeAsuransi || '').trim() || null;
    const namaAsuransi = String(body.nama_asuransi || body.namaAsuransi || '').trim() || null;
    const kodeInstalasiRadiologi = String(body.kode_instalasi_radiologi || body.kodeInstalasiRadiologi || '').trim() || null;
    const namaInstalasiRadiologi = String(body.nama_instalasi_radiologi || body.namaInstalasiRadiologi || '').trim() || null;
    const updateRisRaw = String(body.update_ris || body.updateRis || '').trim().toUpperCase();
    const updateRis = updateRisRaw === 'Y' || updateRisRaw === 'C' ? updateRisRaw : 'N';
    let referringDoctorId = body.referring_doctor_id === undefined || body.referring_doctor_id === null || body.referring_doctor_id === ''
        ? body.referringDoctorId === undefined || body.referringDoctorId === null || body.referringDoctorId === ''
            ? null
            : Number(body.referringDoctorId)
        : Number(body.referring_doctor_id);
    let radiologistDoctorId = body.radiologist_doctor_id === undefined || body.radiologist_doctor_id === null || body.radiologist_doctor_id === ''
        ? body.radiologistDoctorId === undefined || body.radiologistDoctorId === null || body.radiologistDoctorId === ''
            ? null
            : Number(body.radiologistDoctorId)
        : Number(body.radiologist_doctor_id);
    let technologistDoctorId = body.technologist_doctor_id === undefined || body.technologist_doctor_id === null || body.technologist_doctor_id === ''
        ? body.technologistDoctorId === undefined || body.technologistDoctorId === null || body.technologistDoctorId === ''
            ? null
            : Number(body.technologistDoctorId)
        : Number(body.technologist_doctor_id);
    if (!studyDate || !modality || !procedureDesc || !klinis) {
        return res.status(400).json({
            error: 'studyDate, modality, procedureDesc, and klinis are required',
        });
    }
    try {
        await ensureMwlTables();
        if (referringDoctorId === null) {
            const resolved = await resolveDoctorByCodeOrId({
                kodeDokter: body.kode_dokter,
                role: 'CLINICIAN',
            });
            if (resolved) {
                referringDoctorId = resolved.id;
            }
        }
        if (radiologistDoctorId === null) {
            const resolved = await resolveDoctorByCodeOrId({
                kodeDokter: body.kode_dokter_radiolog || body.kode_radiolog,
                role: 'RADIOLOGIST',
            });
            if (resolved) {
                radiologistDoctorId = resolved.id;
            }
        }
        if (technologistDoctorId === null) {
            const resolved = await resolveDoctorByCodeOrId({
                kodeDokter: body.kode_radiografer || body.technologist_username,
                role: 'TECHNOLOGIST',
            });
            if (resolved) {
                technologistDoctorId = resolved.id;
            }
        }
        let resolvedPatientRecordId = Number.isFinite(patientRecordId) && patientRecordId > 0 ? patientRecordId : null;
        if (!resolvedPatientRecordId && noRm) {
            const [patientRows] = await pool.query('SELECT id FROM patients WHERE no_rm = ?', [noRm]);
            resolvedPatientRecordId = patientRows[0]?.id || null;
        }
        if (!resolvedPatientRecordId) {
            return res.status(400).json({ error: 'Valid patientRecordId or patientId is required' });
        }
        if (studyMasterId !== null && (!Number.isFinite(studyMasterId) || studyMasterId <= 0)) {
            return res.status(400).json({ error: 'studyMasterId must be a valid number' });
        }
        if (referringDoctorId !== null && (!Number.isFinite(referringDoctorId) || referringDoctorId <= 0)) {
            return res.status(400).json({ error: 'referringDoctorId must be a valid number' });
        }
        if (radiologistDoctorId !== null && (!Number.isFinite(radiologistDoctorId) || radiologistDoctorId <= 0)) {
            return res.status(400).json({ error: 'radiologistDoctorId must be a valid number' });
        }
        if (technologistDoctorId !== null && (!Number.isFinite(technologistDoctorId) || technologistDoctorId <= 0)) {
            return res.status(400).json({ error: 'technologistDoctorId must be a valid number' });
        }
        if (studyMasterId !== null) {
            const [studyMasterRows] = await pool.query('SELECT id FROM mwl_studies WHERE id = ?', [studyMasterId]);
            if (!studyMasterRows.length) {
                return res.status(400).json({ error: 'Selected study master not found' });
            }
        }
        let resolvedReferringPhysician = referringPhysician;
        let resolvedKodeDokter = null;
        let resolvedNamaDokter = null;
        let resolvedKodeDokterRadiolog = null;
        let resolvedNamaRadiolog = null;
        let resolvedKodeRadiografer = null;
        let resolvedNamaRadiografer = null;
        if (referringDoctorId === null && body.kode_dokter) {
            const [refByCodeRows] = await pool.query(
                'SELECT id, kode_dokter, nama_dokter, role FROM mwl_doctors WHERE kode_dokter = ? LIMIT 1',
                [String(body.kode_dokter).trim()]
            );
            if (refByCodeRows.length && refByCodeRows[0].role === 'CLINICIAN') {
                referringDoctorId = refByCodeRows[0].id;
            }
        }
        if (radiologistDoctorId === null && (body.kode_dokter_radiolog || body.kode_radiolog)) {
            const [radByCodeRows] = await pool.query(
                'SELECT id, kode_dokter, nama_dokter, role FROM mwl_doctors WHERE kode_dokter = ? LIMIT 1',
                [String(body.kode_dokter_radiolog || body.kode_radiolog).trim()]
            );
            if (radByCodeRows.length && radByCodeRows[0].role === 'RADIOLOGIST') {
                radiologistDoctorId = radByCodeRows[0].id;
            }
        }
        if (referringDoctorId !== null) {
            const [refRows] = await pool.query('SELECT id, kode_dokter, nama_dokter, role FROM mwl_doctors WHERE id = ?', [referringDoctorId]);
            if (!refRows.length || refRows[0].role !== 'CLINICIAN') {
                return res.status(400).json({ error: 'Selected referring doctor is invalid' });
            }
            resolvedReferringPhysician = refRows[0].nama_dokter;
            resolvedKodeDokter = refRows[0].kode_dokter || null;
            resolvedNamaDokter = refRows[0].nama_dokter || null;
        }
        if (radiologistDoctorId !== null) {
            const [radRows] = await pool.query('SELECT id, kode_dokter, nama_dokter, role FROM mwl_doctors WHERE id = ?', [radiologistDoctorId]);
            if (!radRows.length || radRows[0].role !== 'RADIOLOGIST') {
                return res.status(400).json({ error: 'Selected radiologist is invalid' });
            }
            resolvedKodeDokterRadiolog = radRows[0].kode_dokter || null;
            resolvedNamaRadiolog = radRows[0].nama_dokter || null;
        }
        if (technologistDoctorId !== null) {
            const [techRows] = await pool.query('SELECT id, kode_dokter, nama_dokter, role FROM mwl_doctors WHERE id = ?', [technologistDoctorId]);
            if (!techRows.length || techRows[0].role !== 'TECHNOLOGIST') {
                return res.status(400).json({ error: 'Selected technologist is invalid' });
            }
            resolvedKodeRadiografer = techRows[0].kode_dokter || null;
            resolvedNamaRadiografer = techRows[0].nama_dokter || null;
        }
        const noRontgen = String(body.no_rontgen || body.noRontgen || accessionNumberRaw || '').trim();
        if (!noRontgen) {
            return res.status(400).json({ error: 'accessionNumber/no_rontgen is required' });
        }
        const accessionNumber = accessionNumberRaw || noRontgen;
        const studyInstanceUid = generateStudyInstanceUid();
        const [dupRows] = await pool.query('SELECT id FROM mwl_orders WHERE accession_number = ?', [accessionNumber]);
        if (dupRows.length) {
            return res.status(409).json({ error: 'Accession number already exists' });
        }
        const [dupNoRontgenRows] = await pool.query('SELECT id FROM mwl_orders WHERE no_rontgen = ?', [noRontgen]);
        if (dupNoRontgenRows.length) {
            return res.status(409).json({ error: 'No rontgen already exists' });
        }
        const [dupStudyRows] = await pool.query('SELECT id FROM mwl_orders WHERE study_instance_uid = ?', [studyInstanceUid]);
        if (dupStudyRows.length) {
            return res.status(409).json({ error: 'Generated StudyInstanceUID collided, retry request' });
        }
        const [result] = await pool.query(
            `
            INSERT INTO mwl_orders (
              patient_record_id,
              accession_number,
              no_register,
              no_rontgen,
              study_instance_uid,
              tanggal_order,
              tanggal_aktivasi,
              study_date,
              study_time,
              modality,
              cito,
              polirawat,
              kode_ruangan,
              nama_ruangan,
              procedure_code,
              procedure_desc,
              klinis,
              diagnosa,
              kode_pemeriksaan,
              nama_pemeriksaan,
              kode_dokter,
              nama_dokter,
              kode_dokter_radiolog,
              nama_radiolog,
              kode_radiografer,
              nama_radiografer,
              cara_bayar,
              kode_asuransi,
              nama_asuransi,
              kode_instalasi_radiologi,
              nama_instalasi_radiologi,
              update_ris,
              referring_physician,
              status
            )
            VALUES (
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, 'PENDING'
            )
            `,
            [
                resolvedPatientRecordId,
                accessionNumber,
                noRegister,
                noRontgen,
                studyInstanceUid,
                tanggalOrder,
                tanggalAktivasi,
                studyDate,
                studyTime,
                modality,
                cito,
                polirawat,
                kodeRuangan,
                namaRuangan,
                procedureCode,
                procedureDesc,
                klinis,
                diagnosa,
                kodePemeriksaan,
                namaPemeriksaan,
                resolvedKodeDokter,
                resolvedNamaDokter,
                resolvedKodeDokterRadiolog,
                resolvedNamaRadiolog,
                resolvedKodeRadiografer,
                resolvedNamaRadiografer,
                caraBayar,
                kodeAsuransi,
                namaAsuransi,
                kodeInstalasiRadiologi,
                namaInstalasiRadiologi,
                updateRis,
                resolvedReferringPhysician,
            ]
        );
        const [patientDetailRows] = await pool.query(
            `
            SELECT no_rm, nama_pasien, tanggal_lahir, kelamin, alamat, kecamatan, kabupaten, provinsi, kode_pos, no_hp
            FROM patients
            WHERE id = ?
            LIMIT 1
            `,
            [resolvedPatientRecordId]
        );
        const patientDetail = patientDetailRows[0] || {};
        await upsertOrderInPayload(
            {
                ...patientDetail,
                tanggal_order: tanggalOrder,
                tanggal_aktivasi: tanggalAktivasi,
                study_date: studyDate,
                study_time: studyTime,
                no_register: noRegister,
                accession_number: accessionNumber,
                no_rontgen: noRontgen,
                klinis,
                diagnosa,
                kode_pemeriksaan: kodePemeriksaan,
                nama_pemeriksaan: namaPemeriksaan,
                modality,
                cito,
                polirawat,
                kode_ruangan: kodeRuangan,
                nama_ruangan: namaRuangan,
                kode_dokter: resolvedKodeDokter,
                nama_dokter: resolvedNamaDokter || resolvedReferringPhysician,
                kode_dokter_radiolog: resolvedKodeDokterRadiolog,
                nama_radiolog: resolvedNamaRadiolog,
                kode_radiografer: resolvedKodeRadiografer,
                nama_radiografer: resolvedNamaRadiografer,
                cara_bayar: caraBayar,
                kode_asuransi: kodeAsuransi,
                nama_asuransi: namaAsuransi,
                kode_instalasi_radiologi: kodeInstalasiRadiologi,
                nama_instalasi_radiologi: namaInstalasiRadiologi,
                update_ris: updateRis,
                referring_physician: resolvedReferringPhysician,
            },
            { updateRis }
        );
        await syncRadiologistAssignmentForStudy({
            studyInstanceUid,
            radiologistDoctorId,
            radiologistDoctorCode: resolvedKodeDokterRadiolog,
            assignedBy: 'mwl-order',
        });
        const [rows] = await pool.query(
            `
            SELECT o.*, ${ORDER_IN_SOURCE_SELECT} p.no_rm, p.nama_pasien, p.tanggal_lahir, p.kelamin, dref.id AS referring_doctor_id, dref.nama_dokter AS referring_doctor_name, drad.id AS radiologist_doctor_id, drad.nama_dokter AS radiologist_doctor_name, dtech.id AS technologist_doctor_id, dtech.id AS technologist_id, dtech.kode_dokter AS technologist_username, dtech.nama_dokter AS technologist_name, s.id AS study_master_id, s.procedure_code AS study_master_procedure_code, s.modality_code AS study_master_modality_code, s.study_description AS study_master_description, m.id AS modality_station_id, m.nama_ruangan AS modality_station_room, m.ae_title_station AS modality_station_aet_master
            FROM mwl_orders o
            INNER JOIN patients p ON p.id = o.patient_record_id
            ${ORDER_IN_SOURCE_JOIN}
            ${MWL_MASTER_SOURCE_JOINS}
            WHERE o.id = ?
            `,
            [result.insertId]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to create order' });
    }
});

app.put('/api/mwl/orders/:id', requirePermission('view_mwl_order'), async (req, res) => {
    const orderId = Number(req.params.id);
    const body = req.body || {};
    const patientRecordId = Number(body.patient_record_id ?? body.patientRecordId);
    const studyMasterId = body.study_master_id === undefined || body.study_master_id === null || body.study_master_id === ''
        ? body.studyMasterId === undefined || body.studyMasterId === null || body.studyMasterId === '' ? null : Number(body.studyMasterId)
        : Number(body.study_master_id);
    const accessionNumber = String(body.accession_number || body.accessionNumber || '').trim();
    const noRegister = String(body.no_register || body.noRegister || '').trim() || null;
    const noRontgen = accessionNumber;
    const studyDate = normalizeStudyDate(body.study_date || body.studyDate);
    const studyTime = normalizeStudyTime(body.study_time || body.studyTime);
    const tanggalOrder = normalizeDateTime(body.tanggal_order || body.tanggalOrder);
    const tanggalAktivasi = normalizeDateTime(body.tanggal_aktivasi || body.tanggalAktivasi);
    const modality = normalizeModality(body.modality);
    const cito = normalizeCito(body.cito);
    const polirawat = String(body.polirawat || body.rawatinap || '').trim() || null;
    const kodeRuangan = String(body.kode_ruangan || body.kodeRuangan || '').trim() || null;
    const namaRuangan = String(body.nama_ruangan || body.namaRuangan || '').trim() || null;
    const procedureCode = String(body.kode_pemeriksaan || body.procedure_code || body.procedureCode || '').trim() || null;
    const procedureDesc = String(body.nama_pemeriksaan || body.procedure_desc || body.procedureDesc || '').trim();
    const klinis = String(body.klinis || '').trim() || null;
    const diagnosa = String(body.diagnosa || '').trim() || null;
    const kodePemeriksaan = String(body.kode_pemeriksaan || body.kodePemeriksaan || procedureCode || '').trim() || null;
    const namaPemeriksaan = String(body.nama_pemeriksaan || body.namaPemeriksaan || procedureDesc || '').trim() || null;
    const caraBayar = String(body.cara_bayar || body.caraBayar || '').trim() || null;
    const kodeAsuransi = String(body.kode_asuransi || body.kodeAsuransi || '').trim() || null;
    const namaAsuransi = String(body.nama_asuransi || body.namaAsuransi || '').trim() || null;
    const kodeInstalasiRadiologi = String(body.kode_instalasi_radiologi || body.kodeInstalasiRadiologi || '').trim() || null;
    const namaInstalasiRadiologi = String(body.nama_instalasi_radiologi || body.namaInstalasiRadiologi || '').trim() || null;
    const updateRisRaw = String(body.update_ris || body.updateRis || '').trim().toUpperCase();
    const updateRis = updateRisRaw === 'Y' || updateRisRaw === 'C' ? updateRisRaw : 'N';
    let referringDoctorId = body.referring_doctor_id === undefined || body.referring_doctor_id === null || body.referring_doctor_id === ''
        ? body.referringDoctorId === undefined || body.referringDoctorId === null || body.referringDoctorId === '' ? null : Number(body.referringDoctorId)
        : Number(body.referring_doctor_id);
    let radiologistDoctorId = body.radiologist_doctor_id === undefined || body.radiologist_doctor_id === null || body.radiologist_doctor_id === ''
        ? body.radiologistDoctorId === undefined || body.radiologistDoctorId === null || body.radiologistDoctorId === '' ? null : Number(body.radiologistDoctorId)
        : Number(body.radiologist_doctor_id);
    let technologistDoctorId = body.technologist_doctor_id === undefined || body.technologist_doctor_id === null || body.technologist_doctor_id === ''
        ? body.technologistDoctorId === undefined || body.technologistDoctorId === null || body.technologistDoctorId === '' ? null : Number(body.technologistDoctorId)
        : Number(body.technologist_doctor_id);
    const referringPhysician = String(body.referring_physician || body.referringPhysician || body.nama_dokter || '').trim() || null;
    if (!Number.isFinite(orderId) || orderId <= 0) {
        return res.status(400).json({ error: 'Invalid order id' });
    }
    if (!Number.isFinite(patientRecordId) || patientRecordId <= 0 || !studyDate || !modality || !procedureDesc || !klinis || !accessionNumber) {
        return res.status(400).json({ error: 'patientRecordId, accessionNumber, studyDate, modality, procedureDesc, and klinis are required' });
    }
    try {
        await ensureMwlTables();
        if (referringDoctorId === null) {
            const resolved = await resolveDoctorByCodeOrId({
                kodeDokter: body.kode_dokter,
                role: 'CLINICIAN',
            });
            if (resolved) referringDoctorId = resolved.id;
        }
        if (radiologistDoctorId === null) {
            const resolved = await resolveDoctorByCodeOrId({
                kodeDokter: body.kode_dokter_radiolog || body.kode_radiolog,
                role: 'RADIOLOGIST',
            });
            if (resolved) radiologistDoctorId = resolved.id;
        }
        if (technologistDoctorId === null) {
            const resolved = await resolveDoctorByCodeOrId({
                kodeDokter: body.kode_radiografer || body.technologist_username,
                role: 'TECHNOLOGIST',
            });
            if (resolved) technologistDoctorId = resolved.id;
        }
        const [existingRows] = await pool.query('SELECT id, study_instance_uid, status FROM mwl_orders WHERE id = ?', [orderId]);
        if (!existingRows.length) {
            return res.status(404).json({ error: 'Order not found' });
        }
        const existingOrder = existingRows[0];
        const [patientRows] = await pool.query('SELECT id FROM patients WHERE id = ?', [patientRecordId]);
        if (!patientRows.length) {
            return res.status(400).json({ error: 'Selected patient not found' });
        }
        if (studyMasterId !== null) {
            const [studyRows] = await pool.query('SELECT id FROM mwl_studies WHERE id = ?', [studyMasterId]);
            if (!studyRows.length) {
                return res.status(400).json({ error: 'Selected study master not found' });
            }
        }
        if (referringDoctorId !== null && (!Number.isFinite(referringDoctorId) || referringDoctorId <= 0)) {
            return res.status(400).json({ error: 'referringDoctorId must be a valid number' });
        }
        if (radiologistDoctorId !== null && (!Number.isFinite(radiologistDoctorId) || radiologistDoctorId <= 0)) {
            return res.status(400).json({ error: 'radiologistDoctorId must be a valid number' });
        }
        if (technologistDoctorId !== null && (!Number.isFinite(technologistDoctorId) || technologistDoctorId <= 0)) {
            return res.status(400).json({ error: 'technologistDoctorId must be a valid number' });
        }
        let resolvedReferringPhysician = referringPhysician;
        let resolvedKodeDokter = null;
        let resolvedNamaDokter = null;
        let resolvedKodeDokterRadiolog = null;
        let resolvedNamaRadiolog = null;
        let resolvedKodeRadiografer = null;
        let resolvedNamaRadiografer = null;
        if (referringDoctorId !== null) {
            const [refRows] = await pool.query('SELECT kode_dokter, nama_dokter, role FROM mwl_doctors WHERE id = ?', [referringDoctorId]);
            if (!refRows.length || refRows[0].role !== 'CLINICIAN') {
                return res.status(400).json({ error: 'Selected referring doctor is invalid' });
            }
            resolvedReferringPhysician = refRows[0].nama_dokter;
            resolvedKodeDokter = refRows[0].kode_dokter || null;
            resolvedNamaDokter = refRows[0].nama_dokter || null;
        }
        if (radiologistDoctorId !== null) {
            const [radRows] = await pool.query('SELECT kode_dokter, nama_dokter, role FROM mwl_doctors WHERE id = ?', [radiologistDoctorId]);
            if (!radRows.length || radRows[0].role !== 'RADIOLOGIST') {
                return res.status(400).json({ error: 'Selected radiologist is invalid' });
            }
            resolvedKodeDokterRadiolog = radRows[0].kode_dokter || null;
            resolvedNamaRadiolog = radRows[0].nama_dokter || null;
        }
        if (technologistDoctorId !== null) {
            const [techRows] = await pool.query('SELECT kode_dokter, nama_dokter, role FROM mwl_doctors WHERE id = ?', [technologistDoctorId]);
            if (!techRows.length || techRows[0].role !== 'TECHNOLOGIST') {
                return res.status(400).json({ error: 'Selected technologist is invalid' });
            }
            resolvedKodeRadiografer = techRows[0].kode_dokter || null;
            resolvedNamaRadiografer = techRows[0].nama_dokter || null;
        }
        const [dupAccessionRows] = await pool.query('SELECT id FROM mwl_orders WHERE accession_number = ? AND id <> ?', [accessionNumber, orderId]);
        if (dupAccessionRows.length) {
            return res.status(409).json({ error: 'Accession number already exists' });
        }
        const [dupRontgenRows] = await pool.query('SELECT id FROM mwl_orders WHERE no_rontgen = ? AND id <> ?', [noRontgen, orderId]);
        if (dupRontgenRows.length) {
            return res.status(409).json({ error: 'No rontgen already exists' });
        }
        await pool.query(
            `
            UPDATE mwl_orders
            SET patient_record_id = ?, accession_number = ?, no_register = ?, no_rontgen = ?, tanggal_order = ?, tanggal_aktivasi = ?, study_date = ?, study_time = ?, modality = ?, cito = ?, polirawat = ?, kode_ruangan = ?, nama_ruangan = ?, procedure_code = ?, procedure_desc = ?, klinis = ?, diagnosa = ?, kode_pemeriksaan = ?, nama_pemeriksaan = ?, kode_dokter = ?, nama_dokter = ?, kode_dokter_radiolog = ?, nama_radiolog = ?, kode_radiografer = ?, nama_radiografer = ?, cara_bayar = ?, kode_asuransi = ?, nama_asuransi = ?, kode_instalasi_radiologi = ?, nama_instalasi_radiologi = ?, update_ris = ?, referring_physician = ?
            WHERE id = ?
            `,
            [patientRecordId, accessionNumber, noRegister, noRontgen, tanggalOrder, tanggalAktivasi, studyDate, studyTime, modality, cito, polirawat, kodeRuangan, namaRuangan, procedureCode, procedureDesc, klinis, diagnosa, kodePemeriksaan, namaPemeriksaan, resolvedKodeDokter, resolvedNamaDokter, resolvedKodeDokterRadiolog, resolvedNamaRadiolog, resolvedKodeRadiografer, resolvedNamaRadiografer, caraBayar, kodeAsuransi, namaAsuransi, kodeInstalasiRadiologi, namaInstalasiRadiologi, updateRis, resolvedReferringPhysician, orderId]
        );
        const [patientDetailRows] = await pool.query(
            `
            SELECT no_rm, nama_pasien, tanggal_lahir, kelamin, alamat, kecamatan, kabupaten, provinsi, kode_pos, no_hp
            FROM patients
            WHERE id = ?
            LIMIT 1
            `,
            [patientRecordId]
        );
        const patientDetail = patientDetailRows[0] || {};
        await upsertOrderInPayload(
            {
                ...patientDetail,
                tanggal_order: tanggalOrder,
                tanggal_aktivasi: tanggalAktivasi,
                study_date: studyDate,
                study_time: studyTime,
                no_register: noRegister,
                accession_number: accessionNumber,
                no_rontgen: noRontgen,
                klinis,
                diagnosa,
                kode_pemeriksaan: kodePemeriksaan,
                nama_pemeriksaan: namaPemeriksaan,
                modality,
                cito,
                polirawat,
                kode_ruangan: kodeRuangan,
                nama_ruangan: namaRuangan,
                kode_dokter: resolvedKodeDokter,
                nama_dokter: resolvedNamaDokter || resolvedReferringPhysician,
                kode_dokter_radiolog: resolvedKodeDokterRadiolog,
                nama_radiolog: resolvedNamaRadiolog,
                kode_radiografer: resolvedKodeRadiografer,
                nama_radiografer: resolvedNamaRadiografer,
                cara_bayar: caraBayar,
                kode_asuransi: kodeAsuransi,
                nama_asuransi: namaAsuransi,
                kode_instalasi_radiologi: kodeInstalasiRadiologi,
                nama_instalasi_radiologi: namaInstalasiRadiologi,
                update_ris: updateRis,
                referring_physician: resolvedReferringPhysician,
            },
            { updateRis }
        );
        await syncRadiologistAssignmentForStudy({
            studyInstanceUid: existingOrder.study_instance_uid,
            radiologistDoctorId,
            radiologistDoctorCode: resolvedKodeDokterRadiolog,
            assignedBy: 'mwl-order-update',
        });
        if (existingOrder.status === 'SENT_TO_MWL' && existingOrder.study_instance_uid) {
            const scheduledImageCount = await dicomwebPacs.getStudyInstanceCount(existingOrder.study_instance_uid).catch(() => 0);
            if (!scheduledImageCount) {
                await dicomwebPacs.createScheduledStudyPlaceholder({
                    studyInstanceUid: existingOrder.study_instance_uid,
                    patientId: patientDetail.no_rm,
                    patientName: patientDetail.nama_pasien,
                    patientBirthDate: toDicomDate(patientDetail.tanggal_lahir),
                    patientSex: patientDetail.kelamin || 'O',
                    accessionNumber,
                    studyDate,
                    studyTime,
                    modality,
                    studyDescription: procedureDesc || namaPemeriksaan,
                    studyId: noRontgen || accessionNumber,
                    referringPhysician: resolvedReferringPhysician || resolvedNamaDokter,
                }).catch(err => {
                    console.warn(`Failed to refresh scheduled placeholder for order ${orderId}:`, err.message);
                });
            }
        }
        const [rows] = await pool.query(
            `
            SELECT o.*, ${ORDER_IN_SOURCE_SELECT} p.no_rm, p.nama_pasien, p.tanggal_lahir, p.kelamin, p.alamat, p.kecamatan, p.kabupaten, p.provinsi, p.kode_pos, p.no_hp, p.update_simrs, p.waktu_update_pasien, dref.id AS referring_doctor_id, dref.nama_dokter AS referring_doctor_name, dref.kode_dokter AS referring_doctor_code, drad.id AS radiologist_doctor_id, drad.nama_dokter AS radiologist_doctor_name, drad.kode_dokter AS radiologist_doctor_code, dtech.id AS technologist_doctor_id, dtech.id AS technologist_id, dtech.kode_dokter AS technologist_username, dtech.nama_dokter AS technologist_name, s.id AS study_master_id, s.procedure_code AS study_master_procedure_code, s.modality_code AS study_master_modality_code, s.study_description AS study_master_description, m.id AS modality_station_id, m.nama_ruangan AS modality_station_room, m.ae_title_station AS modality_station_aet_master, COALESCE(ml.has_active_mwl, 0) AS has_active_mwl
            FROM mwl_orders o
            INNER JOIN patients p ON p.id = o.patient_record_id
            ${ORDER_IN_SOURCE_JOIN}
            ${MWL_MASTER_SOURCE_JOINS}
            ${MWL_ACTIVE_LOG_JOIN}
            WHERE o.id = ?
            `,
            [orderId]
        );
        await syncOrderInForOrder({ orderId, updateRis: updateRis });
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to update order' });
    }
});

app.delete('/api/mwl/orders/:id', requirePermission('view_mwl_order'), async (req, res) => {
    const deleteReason = requireDeleteReason(req, res);
    if (!deleteReason) return;
    const orderId = Number(req.params.id);
    if (!Number.isFinite(orderId) || orderId <= 0) {
        return res.status(400).json({ error: 'Invalid order id' });
    }
    try {
        await ensureMwlTables();
        const order = await loadOrderOutSource({ orderId });
        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }
        const [activeLogs] = await pool.query(
            `
            SELECT orthanc_file_name
            FROM mwl_logs
            WHERE order_id = ? AND is_active = 1
            `,
            [orderId]
        );
        for (const log of activeLogs) {
            await deleteOrthancWorklistEntry(log.orthanc_file_name);
        }
        if (order.study_instance_uid) {
            await dicomwebPacs.deleteScheduledStudyPlaceholder(order.study_instance_uid).catch(err => {
                console.warn(`Failed to delete scheduled placeholder for order ${orderId}:`, err.message);
            });
        }
        await pool.query(
            `
            UPDATE mwl_logs
            SET is_active = 0,
                orthanc_status = 'CANCELLED',
                message = COALESCE(?, message)
            WHERE order_id = ?
            `,
            [deleteReason || 'Order hidden from RIS', orderId]
        );
        await pool.query(
            `
            UPDATE mwl_orders
            SET deleted_at = CURRENT_TIMESTAMP,
                deleted_by = ?,
                deleted_reason = ?,
                restored_at = NULL,
                restored_by = NULL
            WHERE id = ?
            `,
            [getUsernameFromRequest(req), deleteReason, orderId]
        );
        await upsertOrderInFromOrder(order, { updateRis: 'C', alasan: deleteReason || 'Data dihapus dari RIS' });
        await writeAuditLog(req, {
            eventType: 'soft_delete_mwl_order',
            outcome: 'success',
            targetType: 'mwl_order',
            targetId: String(orderId),
            details: {
                deleteReason,
                accessionNumber: order.accession_number,
                patientId: order.no_rm,
                patientName: order.nama_pasien,
                studyDescription: order.procedure_desc,
            },
        });
        res.json({ message: 'Order hidden', softDeleted: true });
    } catch (err) {
        await writeAuditLog(req, {
            eventType: 'soft_delete_mwl_order',
            outcome: 'failure',
            targetType: 'mwl_order',
            targetId: String(orderId),
            details: { deleteReason, error: err.message || 'Failed to hide order' },
        });
        res.status(500).json({ error: err.message || 'Failed to hide order' });
    }
});

app.post('/api/mwl/orders/:id/restore', requirePermission('view_mwl_order'), async (req, res) => {
    const orderId = Number(req.params.id);
    if (!Number.isFinite(orderId) || orderId <= 0) {
        return res.status(400).json({ error: 'Invalid order id' });
    }
    try {
        await ensureMwlTables();
        const [existingRows] = await pool.query('SELECT id, accession_number, no_rontgen, deleted_at FROM mwl_orders WHERE id = ? LIMIT 1', [orderId]);
        if (!existingRows.length) {
            return res.status(404).json({ error: 'Order not found' });
        }
        await pool.query(
            `
            UPDATE mwl_orders
            SET deleted_at = NULL,
                deleted_by = NULL,
                deleted_reason = NULL,
                restored_at = CURRENT_TIMESTAMP,
                restored_by = ?
            WHERE id = ?
            `,
            [getUsernameFromRequest(req), orderId]
        );
        await writeAuditLog(req, {
            eventType: 'restore_mwl_order',
            outcome: 'success',
            targetType: 'mwl_order',
            targetId: String(orderId),
            details: {
                accessionNumber: existingRows[0].accession_number,
                noRontgen: existingRows[0].no_rontgen,
                wasDeletedAt: existingRows[0].deleted_at,
            },
        });
        const [rows] = await pool.query(
            `
            SELECT o.*, ${ORDER_IN_SOURCE_SELECT} p.no_rm, p.nama_pasien, p.tanggal_lahir, p.kelamin, p.alamat, p.kecamatan, p.kabupaten, p.provinsi, p.kode_pos, p.no_hp, p.update_simrs, p.waktu_update_pasien, dref.id AS referring_doctor_id, dref.nama_dokter AS referring_doctor_name, dref.kode_dokter AS referring_doctor_code, drad.id AS radiologist_doctor_id, drad.nama_dokter AS radiologist_doctor_name, drad.kode_dokter AS radiologist_doctor_code, dtech.id AS technologist_doctor_id, dtech.id AS technologist_id, dtech.kode_dokter AS technologist_username, dtech.nama_dokter AS technologist_name, s.id AS study_master_id, s.procedure_code AS study_master_procedure_code, s.modality_code AS study_master_modality_code, s.study_description AS study_master_description, m.id AS modality_station_id, m.nama_ruangan AS modality_station_room, m.ae_title_station AS modality_station_aet_master, COALESCE(ml.has_active_mwl, 0) AS has_active_mwl
            FROM mwl_orders o
            INNER JOIN patients p ON p.id = o.patient_record_id
            ${ORDER_IN_SOURCE_JOIN}
            ${MWL_MASTER_SOURCE_JOINS}
            ${MWL_ACTIVE_LOG_JOIN}
            WHERE o.id = ?
            `,
            [orderId]
        );
        res.json(rows[0] || { id: orderId });
    } catch (err) {
        await writeAuditLog(req, {
            eventType: 'restore_mwl_order',
            outcome: 'failure',
            targetType: 'mwl_order',
            targetId: String(orderId),
            details: { error: err.message || 'Failed to restore order' },
        });
        res.status(500).json({ error: err.message || 'Failed to restore order' });
    }
});

app.get('/api/mwl/technologists', requirePermission('view_mwl_technologist'), async (req, res) => {
    try {
        await ensureMwlTables();
        const [rows] = await pool.query(
            `
            SELECT
              id,
              kode_dokter AS username,
              nama_dokter AS name,
              role
            FROM mwl_doctors
            WHERE role = 'TECHNOLOGIST'
            ORDER BY nama_dokter ASC, kode_dokter ASC
            `
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to fetch technologists' });
    }
});

app.post('/api/mwl/orders/:id/send', requirePermission('send_mwl'), async (req, res) => {
    const orderId = Number(req.params.id);
    const staffIdsRaw = Array.isArray(req.body?.staffIds)
        ? req.body.staffIds
        : req.body?.technologistId !== undefined && req.body?.technologistId !== null
          ? [req.body.technologistId]
          : [];
    const staffIds = Array.from(
        new Set(
            staffIdsRaw
                .map(value => Number(value))
                .filter(value => Number.isFinite(value) && value > 0)
        )
    ).slice(0, 7);
    const modalityStationAet = req.body?.modalityStationAet || null;
    const modalityStationId =
        req.body?.modalityStationId === undefined || req.body?.modalityStationId === null || req.body?.modalityStationId === ''
            ? null
            : Number(req.body?.modalityStationId);
    if (!Number.isFinite(orderId) || orderId <= 0) {
        return res.status(400).json({ error: 'Invalid order id' });
    }
    if (!staffIds.length) {
        return res.status(400).json({ error: 'staffIds is required' });
    }
    if (staffIds.length > 7) {
        return res.status(400).json({ error: 'A maximum of 7 staff can be selected' });
    }
    if (modalityStationId !== null && (!Number.isFinite(modalityStationId) || modalityStationId <= 0)) {
        return res.status(400).json({ error: 'modalityStationId must be a valid number' });
    }
    try {
        await ensureMwlTables();
        const [orderRows] = await pool.query(
            `
            SELECT o.*, ${ORDER_IN_SOURCE_SELECT} p.id AS p_id, p.no_rm, p.nama_pasien, p.tanggal_lahir, p.kelamin, p.alamat, p.kecamatan, p.kabupaten, p.provinsi, p.kode_pos, p.no_hp, p.update_simrs, m.nama_ruangan AS modality_station_room, m.ae_title_station AS modality_station_aet_master
            FROM mwl_orders o
            INNER JOIN patients p ON p.id = o.patient_record_id
            ${ORDER_IN_SOURCE_JOIN}
            LEFT JOIN mwl_modalities m ON (
                m.ae_title_station <=> o.modality_station_ae
                OR (o.modality_station_ae IS NULL AND m.nama_ruangan = o.modality_station_room)
            )
            WHERE o.id = ?
            `,
            [orderId]
        );
        if (!orderRows.length) {
            return res.status(404).json({ error: 'Order not found' });
        }
        const order = orderRows[0];
        if (order.status === 'CANCELLED') {
            return res.status(400).json({ error: 'Cancelled order cannot be sent' });
        }
        const [activeLogRows] = await pool.query(
            `
            SELECT id, orthanc_file_name, transport_method, orthanc_status, is_active
            FROM mwl_logs
            WHERE order_id = ? AND is_active = 1
            ORDER BY id DESC
            LIMIT 1
            `,
            [orderId]
        );
        const activeLog = activeLogRows[0] || null;
        const [staffRows] = await pool.query(
            `
            SELECT id, kode_dokter, nama_dokter, role
            FROM mwl_doctors
            WHERE id IN (?)
              AND role IN ('RADIOLOGIST', 'TECHNOLOGIST')
            `,
            [staffIds]
        );
        if (staffRows.length !== staffIds.length) {
            return res.status(400).json({ error: 'RADIOLOGIST / TECHNOLOGIST staff assignment is not valid' });
        }
        const orderedStaff = staffIds
            .map(id => staffRows.find(row => row.id === id))
            .filter(Boolean);
        const selectedTechnologist = orderedStaff.find(row => row.role === 'TECHNOLOGIST') || orderedStaff[0];
        const selectedRadiologist = orderedStaff.find(row => row.role === 'RADIOLOGIST') || null;
        if (!orderedStaff.some(row => row.role === 'TECHNOLOGIST')) {
            return res.status(400).json({ error: 'At least 1 TECHNOLOGIST staff member is required' });
        }
        const assignedStaffJson = JSON.stringify(
            orderedStaff.map(row => ({
                id: row.id,
                kode_dokter: row.kode_dokter,
                nama_dokter: row.nama_dokter,
                role: row.role,
            }))
        );
        let resolvedModalityStationRoom = order.modality_station_room || null;
        let resolvedModalityStationAet = getSafeAet(modalityStationAet || order.modality_station_ae || order.modality_station_aet_master);
        if (modalityStationId !== null) {
            const [modalityRows] = await pool.query(
                'SELECT id, nama_ruangan, ae_title_station FROM mwl_modalities WHERE id = ?',
                [modalityStationId]
            );
            if (!modalityRows.length) {
                return res.status(400).json({ error: 'Selected modality station not found' });
            }
            resolvedModalityStationRoom = modalityRows[0].nama_ruangan || null;
            resolvedModalityStationAet = getSafeAet(modalityRows[0].ae_title_station);
        } else if (modalityStationAet) {
            resolvedModalityStationAet = getSafeAet(modalityStationAet);
        }
        const sendStartedAt = new Date();
        const mwlStudyDate = normalizeStudyDate(sendStartedAt);
        const mwlStudyTime = normalizeStudyTime(sendStartedAt);
        const payload = buildMwlDicomPayload({
            order: {
                ...order,
                study_date: mwlStudyDate,
                study_time: mwlStudyTime,
            },
            patient: {
                id: order.p_id,
                no_rm: order.no_rm,
                nama_pasien: order.nama_pasien,
                tanggal_lahir: order.tanggal_lahir,
                kelamin: order.kelamin,
                alamat: order.alamat,
                kecamatan: order.kecamatan,
                kabupaten: order.kabupaten,
                provinsi: order.provinsi,
                kode_pos: order.kode_pos,
                no_hp: order.no_hp,
                update_simrs: order.update_simrs,
            },
            technologist: {
                id: selectedTechnologist.id,
                username: selectedTechnologist.kode_dokter,
                name: selectedTechnologist.nama_dokter,
                role: selectedTechnologist.role,
            },
            modalityStationAet: resolvedModalityStationAet,
        });
        validateMwlPayloadForSend(payload);
        if (activeLog && order.status === 'SENT_TO_MWL') {
            await deleteOrthancWorklistEntry(activeLog.orthanc_file_name);
        }
        const dispatchResult = await dispatchMwlToOrthanc(payload);
        await pool.query(
            `
            UPDATE mwl_orders
            SET
              assigned_staff_json = ?,
              modality_station_ae = ?,
              modality_station_room = COALESCE(?, modality_station_room),
              study_date = ?,
              study_time = ?,
              kode_admin = ?,
              nama_admin = ?,
              kode_radiografer = ?,
              nama_radiografer = ?,
              radiografer_datetime_start = COALESCE(radiografer_datetime_start, NOW()),
              kode_dokter_radiolog = ?,
              nama_radiolog = ?,
              study_instance_uid = ?,
              actual_study_instance_uid = NULL,
              reconcile_status = 'SCHEDULED',
              reconcile_method = 'mwl_scheduled_placeholder',
              reconciled_at = NULL,
              reconciled_by = NULL,
              status = 'SENT_TO_MWL'
            WHERE id = ?
            `,
            [
                assignedStaffJson,
                resolvedModalityStationAet,
                resolvedModalityStationRoom,
                mwlStudyDate,
                mwlStudyTime,
                order.kode_admin || null,
                order.nama_admin || null,
                selectedTechnologist.kode_dokter || null,
                selectedTechnologist.nama_dokter || null,
                selectedRadiologist?.kode_dokter || order.kode_dokter_radiolog || null,
                selectedRadiologist?.nama_dokter || order.nama_radiolog || null,
                payload.studyInstanceUid,
                orderId,
            ]
        );
        await dicomwebPacs.createScheduledStudyPlaceholder({
            studyInstanceUid: payload.studyInstanceUid,
            patientId: order.no_rm,
            patientName: order.nama_pasien,
            patientBirthDate: toDicomDate(order.tanggal_lahir),
            patientSex: order.kelamin || 'O',
            accessionNumber: order.accession_number,
            studyDate: mwlStudyDate,
            studyTime: mwlStudyTime,
            modality: order.modality,
            studyDescription: order.procedure_desc || order.nama_pemeriksaan,
            studyId: order.no_rontgen || order.accession_number,
            referringPhysician: order.referring_physician || order.nama_dokter,
        });
        await syncRadiologistAssignmentForStudy({
            studyInstanceUid: payload.studyInstanceUid,
            radiologistDoctorCode: selectedRadiologist?.kode_dokter || order.kode_dokter_radiolog || null,
            assignedBy: selectedTechnologist.kode_dokter || null,
        });
        if (activeLog) {
            await pool.query(
                `
                UPDATE mwl_logs
                SET orthanc_file_name = ?,
                    transport_method = ?,
                    orthanc_status = ?,
                    is_active = 1,
                    message = ?,
                    sync_date = NOW()
                WHERE id = ?
                `,
                [
                    dispatchResult.orthancFileName,
                    dispatchResult.transportMethod,
                    dispatchResult.orthancStatus,
                    'MWL payload updated and dispatched',
                    activeLog.id,
                ]
            );
        } else {
            await pool.query(
                `
                INSERT INTO mwl_logs (order_id, orthanc_file_name, transport_method, orthanc_status, is_active, message, sync_date)
                VALUES (?, ?, ?, ?, 1, ?, NOW())
                `,
                [
                    orderId,
                    dispatchResult.orthancFileName,
                    dispatchResult.transportMethod,
                    dispatchResult.orthancStatus,
                    'MWL payload dispatched',
                ]
            );
        }
        const [rows] = await pool.query(
            `
            SELECT
              o.*,
              dtech.kode_dokter AS technologist_username,
              dtech.nama_dokter AS technologist_name,
              m.nama_ruangan AS modality_station_room,
              m.ae_title_station AS modality_station_aet_master,
              dref.id AS referring_doctor_id,
              drad.id AS radiologist_doctor_id,
              dtech.id AS technologist_id,
              m.id AS modality_station_id,
              dref.nama_dokter AS referring_doctor_name,
              drad.nama_dokter AS radiologist_doctor_name,
              p.no_rm,
              p.nama_pasien
            FROM mwl_orders o
            INNER JOIN patients p ON p.id = o.patient_record_id
            LEFT JOIN mwl_doctors dtech ON dtech.kode_dokter = o.kode_radiografer
            LEFT JOIN mwl_modalities m ON (
                m.ae_title_station <=> o.modality_station_ae
                OR (o.modality_station_ae IS NULL AND m.nama_ruangan = o.modality_station_room)
            )
            LEFT JOIN mwl_doctors dref ON dref.kode_dokter = o.kode_dokter
            LEFT JOIN mwl_doctors drad ON drad.kode_dokter = o.kode_dokter_radiolog
            WHERE o.id = ?
            `,
            [orderId]
        );
        await syncOrderInForOrder({ orderId, updateRis: 'Y' });
        res.json({
            order: rows[0],
            mwlDispatch: dispatchResult,
        });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Failed to send order to modality' });
    }
});

app.post('/api/mwl/orders/:id/direct-radiologist', requirePermission('send_mwl'), async (req, res) => {
    const orderId = Number(req.params.id);
    if (!Number.isFinite(orderId) || orderId <= 0) {
        return res.status(400).json({ error: 'Invalid order id' });
    }
    try {
        await ensureMwlTables();
        const [orderRows] = await pool.query(
            `
            SELECT o.*, ${ORDER_IN_SOURCE_SELECT}
              p.no_rm,
              p.nama_pasien,
              dtech.id AS technologist_id,
              dtech.kode_dokter AS technologist_username,
              dtech.nama_dokter AS technologist_name,
              dref.id AS referring_doctor_id,
              dref.nama_dokter AS referring_doctor_name,
              dref.kode_dokter AS referring_doctor_code,
              drad.id AS radiologist_doctor_id,
              drad.nama_dokter AS radiologist_doctor_name,
              drad.kode_dokter AS radiologist_doctor_code,
              m.id AS modality_station_id,
              m.nama_ruangan AS modality_station_room,
              m.ae_title_station AS modality_station_aet_master
            FROM mwl_orders o
            INNER JOIN patients p ON p.id = o.patient_record_id
            ${ORDER_IN_SOURCE_JOIN}
            LEFT JOIN mwl_doctors dtech ON dtech.kode_dokter = o.kode_radiografer
            LEFT JOIN mwl_doctors dref ON dref.kode_dokter = COALESCE(o.kode_dokter, oi.kode_dokter)
            LEFT JOIN mwl_doctors drad ON drad.kode_dokter = COALESCE(o.kode_dokter_radiolog, oi.kode_dokter_radiolog)
            LEFT JOIN mwl_modalities m ON (
                m.ae_title_station <=> o.modality_station_ae
                OR (o.modality_station_ae IS NULL AND m.nama_ruangan = o.modality_station_room)
            )
            WHERE o.id = ?
            `,
            [orderId]
        );
        if (!orderRows.length) {
            return res.status(404).json({ error: 'Order not found' });
        }
        const order = orderRows[0];
        if (order.status === 'CANCELLED') {
            return res.status(400).json({ error: 'Cancelled order cannot be sent to radiologist' });
        }

        const [activeLogs] = await pool.query(
            `
            SELECT id, orthanc_file_name
            FROM mwl_logs
            WHERE order_id = ? AND is_active = 1
            `,
            [orderId]
        );
        for (const log of activeLogs) {
            await deleteOrthancWorklistEntry(log.orthanc_file_name);
        }

        await pool.query(
            `
            UPDATE mwl_orders
            SET
              status = 'COMPLETED',
              radiografer_datetime_start = COALESCE(radiografer_datetime_start, NOW()),
              radiografer_datetime_end = COALESCE(radiografer_datetime_end, NOW()),
              actual_study_instance_uid = NULL,
              reconcile_status = 'DIRECT_TO_RADIOLOGIST',
              reconcile_method = 'no_modality_direct_reporting',
              reconciled_at = NOW(),
              reconciled_by = ?
            WHERE id = ?
            `,
            [req.user?.username || null, orderId]
        );
        await pool.query(
            `
            UPDATE mwl_logs
            SET is_active = 0,
                orthanc_status = 'COMPLETED',
                message = 'Direct to radiologist without modality examination',
                sync_date = NOW()
            WHERE order_id = ? AND is_active = 1
            `,
            [orderId]
        );

        await syncRadiologistAssignmentForStudy({
            studyInstanceUid: order.study_instance_uid,
            radiologistDoctorId: order.radiologist_doctor_id || null,
            radiologistDoctorCode: order.radiologist_doctor_code || order.kode_dokter_radiolog || null,
            assignedBy: req.user?.username || order.technologist_username || null,
        });
        await syncOrderInForOrder({ orderId, updateRis: 'Y' });
        await sendAutoRadiologistWhatsappForOrder(orderId, req).catch(err => {
            console.warn(`Failed to send auto radiologist WhatsApp for direct order ${orderId}:`, err.message);
        });
        const [rows] = await pool.query(
            `
            SELECT
              o.*,
              dtech.kode_dokter AS technologist_username,
              dtech.nama_dokter AS technologist_name,
              m.nama_ruangan AS modality_station_room,
              m.ae_title_station AS modality_station_aet_master,
              dref.id AS referring_doctor_id,
              drad.id AS radiologist_doctor_id,
              dtech.id AS technologist_id,
              m.id AS modality_station_id,
              dref.nama_dokter AS referring_doctor_name,
              drad.nama_dokter AS radiologist_doctor_name,
              p.no_rm,
              p.nama_pasien
            FROM mwl_orders o
            INNER JOIN patients p ON p.id = o.patient_record_id
            LEFT JOIN mwl_doctors dtech ON dtech.kode_dokter = o.kode_radiografer
            LEFT JOIN mwl_modalities m ON (
                m.ae_title_station <=> o.modality_station_ae
                OR (o.modality_station_ae IS NULL AND m.nama_ruangan = o.modality_station_room)
            )
            LEFT JOIN mwl_doctors dref ON dref.kode_dokter = o.kode_dokter
            LEFT JOIN mwl_doctors drad ON drad.kode_dokter = o.kode_dokter_radiolog
            WHERE o.id = ?
            `,
            [orderId]
        );
        await writeAuditLog(req, {
            eventType: 'direct_to_radiologist',
            outcome: 'success',
            studyInstanceUid: order.study_instance_uid || null,
            targetType: 'mwl_order',
            targetId: String(orderId),
            details: {
                accessionNumber: order.accession_number || null,
                patientId: order.no_rm || null,
                patientName: order.nama_pasien || null,
                modality: order.modality || null,
                studyDescription: order.procedure_desc || order.nama_pemeriksaan || null,
                radiologistDoctorCode: order.radiologist_doctor_code || order.kode_dokter_radiolog || null,
                radiologistDoctorName: order.radiologist_doctor_name || order.nama_radiolog || null,
                reason: 'No modality examination required',
            },
        });
        res.json({ message: 'Order sent direct to radiologist', order: rows[0] });
    } catch (err) {
        await writeAuditLog(req, {
            eventType: 'direct_to_radiologist',
            outcome: 'failure',
            targetType: 'mwl_order',
            targetId: String(orderId),
            details: { error: err.message || 'Failed to send direct to radiologist' },
        }).catch(() => undefined);
        res.status(err.status || 500).json({ error: err.message || 'Failed to send direct to radiologist' });
    }
});

app.patch('/api/mwl/orders/:id/status', requirePermission('view_mwl_technologist'), async (req, res) => {
    const orderId = Number(req.params.id);
    const status = String(req.body?.status || '')
        .trim()
        .toUpperCase();
    const allowed = new Set(['PENDING', 'SENT_TO_MWL', 'COMPLETED', 'CANCELLED']);
    if (!Number.isFinite(orderId) || orderId <= 0) {
        return res.status(400).json({ error: 'Invalid order id' });
    }
    if (!allowed.has(status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }
    try {
        await ensureMwlTables();
        const order = await loadOrderOutSource({ orderId });
        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }
        const wasCompleted = order.status === 'COMPLETED';
        const [result] = await pool.query('UPDATE mwl_orders SET status = ? WHERE id = ?', [status, orderId]);
        if (status === 'COMPLETED' || status === 'CANCELLED') {
            const [activeLogs] = await pool.query(
                `
                SELECT id, orthanc_file_name
                FROM mwl_logs
                WHERE order_id = ? AND is_active = 1
                `,
                [orderId]
            );
            for (const log of activeLogs) {
                await deleteOrthancWorklistEntry(log.orthanc_file_name);
            }
            await pool.query(
                `
                UPDATE mwl_logs
                SET is_active = 0,
                    orthanc_status = ?
                WHERE order_id = ? AND is_active = 1
                `,
                [status, orderId]
            );
            if (status === 'CANCELLED' && order.study_instance_uid) {
                await dicomwebPacs.deleteScheduledStudyPlaceholder(order.study_instance_uid).catch(err => {
                    console.warn(`Failed to delete scheduled placeholder for cancelled order ${orderId}:`, err.message);
                });
            }
        }
        await syncOrderInForOrder({ orderId, updateRis: status === 'CANCELLED' ? 'C' : 'Y', alasan: status === 'CANCELLED' ? 'Status order dibatalkan' : null });
        if (status === 'COMPLETED' && !wasCompleted) {
            await sendAutoRadiologistWhatsappForOrder(orderId, req).catch(err => {
                console.warn(`Failed to send auto radiologist WhatsApp for order ${orderId}:`, err.message);
            });
        }
        res.json({ message: 'Order status updated', status });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to update order status' });
    }
});

app.get('/api/mwl/status', requirePermission('view_mwl_status'), async (req, res) => {
    try {
        await ensureMwlTables();
        await scheduleMwlCompletionSync(req);
        const [rows] = await pool.query(
            `
            SELECT
              l.id,
              l.order_id,
              l.orthanc_file_name,
              l.transport_method,
              l.orthanc_status,
              l.is_active,
              l.message,
              l.sync_date,
              o.accession_number,
              o.status AS order_status,
              o.study_instance_uid,
              o.study_date,
              o.study_time,
              o.tanggal_order,
              o.tanggal_aktivasi,
              o.no_register,
              o.no_rontgen,
              o.modality,
              o.procedure_desc,
              o.klinis,
              o.diagnosa,
              dref.id AS referring_doctor_id,
              drad.id AS radiologist_doctor_id,
              dtech.id AS technologist_id,
              dtech.nama_dokter AS technologist_name,
              dtech.kode_dokter AS technologist_username,
              dref.nama_dokter AS referring_doctor_name,
              drad.nama_dokter AS radiologist_doctor_name,
              oi.nama_ruangan,
              m.nama_ruangan AS modality_station_room,
              m.ae_title_station AS modality_station_aet_master,
              p.no_rm,
              p.nama_pasien
            FROM mwl_logs l
            INNER JOIN mwl_orders o ON o.id = l.order_id
            INNER JOIN patients p ON p.id = o.patient_record_id
            LEFT JOIN order_in oi ON oi.no_rontgen = o.no_rontgen
            LEFT JOIN mwl_doctors dtech ON dtech.kode_dokter = o.kode_radiografer
            LEFT JOIN mwl_doctors dref ON dref.kode_dokter = COALESCE(o.kode_dokter, oi.kode_dokter)
            LEFT JOIN mwl_doctors drad ON drad.kode_dokter = COALESCE(o.kode_dokter_radiolog, oi.kode_dokter_radiolog)
            LEFT JOIN mwl_modalities m ON (
                m.ae_title_station <=> o.modality_station_ae
                OR (o.modality_station_ae IS NULL AND m.nama_ruangan = o.modality_station_room)
            )
            WHERE l.is_active = 1
            ORDER BY l.sync_date DESC
            LIMIT 500
            `
        );
        const payload = rows.map(row => ({
            ...row,
            status_indicator:
                row.order_status === 'COMPLETED'
                    ? 'COMPLETED'
                    : row.is_active
                      ? 'ACTIVE'
                      : row.orthanc_status || 'SENT_TO_ORTHANC',
        }));
        res.json(payload);
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to fetch MWL status' });
    }
});

app.get('/api/mwl/published', requirePermission('view_mwl_status'), async (req, res) => {
    try {
        await ensurePacsMwlTables();
        const db = dicomwebPacs.getPacsMetadataDb();
        const activeFilter = String(req.query.active ?? 'true').trim().toLowerCase();
        const params = [];
        let whereSql = '';
        if (!['all', '*', ''].includes(activeFilter)) {
            const wantsActive = !['0', 'false', 'no', 'inactive'].includes(activeFilter);
            whereSql = 'WHERE active = ?';
            params.push(wantsActive ? 1 : 0);
        }
        const [rows] = await db.query(
            `
            SELECT
              id,
              active,
              created_at,
              updated_at,
              accession_number,
              study_instance_uid,
              patient_id,
              patient_name,
              modality,
              station_aet,
              scheduled_date,
              scheduled_time,
              tags_json,
              meta_json
            FROM mwl_worklists
            ${whereSql}
            ORDER BY updated_at DESC
            LIMIT 1000
            `,
            params
        );
        res.json((rows || []).map(row => ({
            ...row,
            active: Boolean(row.active),
            tags_json: (() => {
                try {
                    return parseJsonValue(row.tags_json, {});
                } catch {
                    return {};
                }
            })(),
            meta_json: (() => {
                try {
                    return parseJsonValue(row.meta_json, null);
                } catch {
                    return null;
                }
            })(),
        })));
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to fetch published MWL items' });
    }
});

app.get('/api/mwl/query-logs', requirePermission('view_mwl_status'), async (req, res) => {
    try {
        await ensurePacsMwlTables();
        const db = dicomwebPacs.getPacsMetadataDb();
        const limitRaw = Number(req.query.limit || 100);
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 500) : 100;
        const where = [];
        const params = [];
        const addFilter = (column, value) => {
            const normalized = String(value || '').trim();
            if (!normalized) return;
            where.push(`${column} LIKE ?`);
            params.push(`%${normalized}%`);
        };

        addFilter('calling_ae_title', req.query.callingAe);
        addFilter('called_ae_title', req.query.calledAe);
        addFilter('remote_address', req.query.remoteAddress);
        addFilter('patient_id', req.query.patientId);
        addFilter('accession_number', req.query.accessionNumber);
        addFilter('study_instance_uid', req.query.studyInstanceUid);
        addFilter('modality', req.query.modality);
        addFilter('scheduled_station_ae_title', req.query.stationAet);
        addFilter('outcome', req.query.outcome);

        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        params.push(limit);
        const [rows] = await db.query(
            `
            SELECT
              id,
              created_at,
              calling_ae_title,
              called_ae_title,
              remote_address,
              remote_port,
              patient_id,
              patient_name,
              accession_number,
              study_instance_uid,
              modality,
              scheduled_station_ae_title,
              scheduled_date,
              scheduled_time,
              match_count,
              outcome,
              status_code,
              reason_code,
              error_message,
              recommendation,
              matched_worklist_ids,
              active_worklist_count,
              filter_summary_json,
              query_json
            FROM mwl_query_logs
            ${whereSql}
            ORDER BY created_at DESC, id DESC
            LIMIT ?
            `,
            params
        );

        const parsedRows = (rows || []).map(row => ({
            ...row,
            matched_worklist_ids: (() => {
                try {
                    return parseJsonValue(row.matched_worklist_ids, []);
                } catch {
                    return [];
                }
            })(),
            query_json: (() => {
                try {
                    return parseJsonValue(row.query_json, null);
                } catch {
                    return null;
                }
            })(),
            filter_summary_json: (() => {
                try {
                    return parseJsonValue(row.filter_summary_json, null);
                } catch {
                    return null;
                }
            })(),
        }));

        res.json({ logs: parsedRows });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to fetch MWL query logs' });
    }
});

app.post('/api/internal/mwl/query-log', async (req, res) => {
    const configuredKey = String(process.env.MWL_SCP_INTERNAL_KEY || '').trim();
    const providedKey = String(req.get('X-NEXIA-MWL-SCP-Key') || '').trim();
    const remoteAddress = String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
    const isLocalRequest = ['127.0.0.1', '::1', 'localhost'].includes(remoteAddress);
    if (configuredKey && providedKey !== configuredKey) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    if (!configuredKey && !isLocalRequest) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    const body = req.body || {};
    const toText = value => {
        const text = String(value ?? '').trim();
        return text || null;
    };
    const toInt = value => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
    };
    try {
        await ensurePacsMwlTables();
        const db = dicomwebPacs.getPacsMetadataDb();
        await db.query(
            `
            INSERT INTO mwl_query_logs (
              calling_ae_title,
              called_ae_title,
              remote_address,
              remote_port,
              patient_id,
              patient_name,
              accession_number,
              study_instance_uid,
              modality,
              scheduled_station_ae_title,
              scheduled_date,
              scheduled_time,
              match_count,
              outcome,
              status_code,
              reason_code,
              error_message,
              recommendation,
              matched_worklist_ids,
              active_worklist_count,
              filter_summary_json,
              query_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
                toText(body.callingAeTitle || body.calling_ae_title),
                toText(body.calledAeTitle || body.called_ae_title),
                toText(body.remoteAddress || body.remote_address),
                toInt(body.remotePort || body.remote_port),
                toText(body.patientId || body.patient_id),
                toText(body.patientName || body.patient_name),
                toText(body.accessionNumber || body.accession_number),
                toText(body.studyInstanceUid || body.study_instance_uid),
                toText(body.modality),
                toText(body.scheduledStationAeTitle || body.scheduled_station_ae_title),
                toText(body.scheduledDate || body.scheduled_date),
                toText(body.scheduledTime || body.scheduled_time),
                toInt(body.matchCount || body.match_count) || 0,
                toText(body.outcome) || 'UNKNOWN',
                toText(body.statusCode || body.status_code),
                toText(body.reasonCode || body.reason_code),
                toText(body.errorMessage || body.error_message),
                toText(body.recommendation),
                JSON.stringify(body.matchedWorklistIds || body.matched_worklist_ids || []),
                toInt(body.activeWorklistCount || body.active_worklist_count),
                JSON.stringify(body.filterSummary || body.filter_summary || null),
                JSON.stringify(body.query || body.query_json || null),
            ]
        );
        res.status(201).json({ message: 'MWL query log saved' });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to save MWL query log' });
    }
});

app.get('/api/dicom/traffic-logs', requireAnyPermission('view_settings', 'view_mwl_status'), async (req, res) => {
    try {
        await ensurePacsMwlTables();
        const db = dicomwebPacs.getPacsMetadataDb();
        const limitRaw = Number(req.query.limit || 200);
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 1000) : 200;
        const where = [];
        const params = [];
        const addFilter = (column, value) => {
            const normalized = String(value || '').trim();
            if (!normalized) return;
            where.push(`${column} LIKE ?`);
            params.push(`%${normalized}%`);
        };
        addFilter('service', req.query.service);
        addFilter('event_type', req.query.eventType);
        addFilter('outcome', req.query.outcome);
        addFilter('calling_ae_title', req.query.callingAe);
        addFilter('called_ae_title', req.query.calledAe);
        addFilter('remote_address', req.query.remoteAddress);
        addFilter('patient_id', req.query.patientId);
        addFilter('accession_number', req.query.accessionNumber);
        addFilter('study_instance_uid', req.query.studyInstanceUid);
        addFilter('sop_instance_uid', req.query.sopInstanceUid);
        addFilter('modality', req.query.modality);
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        params.push(limit);
        const [rows] = await db.query(
            `
            SELECT
              id, created_at, service, event_type, outcome, status_code,
              calling_ae_title, called_ae_title, remote_address, remote_port,
              patient_id, patient_name, accession_number, study_instance_uid,
              series_instance_uid, sop_instance_uid, sop_class_uid, transfer_syntax,
              modality, destination_ae_title, message, error_message, details_json
            FROM dicom_traffic_logs
            ${whereSql}
            ORDER BY created_at DESC, id DESC
            LIMIT ?
            `,
            params
        );
        res.json({
            logs: (rows || []).map(row => ({
                ...row,
                details_json: parseJsonValue(row.details_json, null),
            })),
        });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to fetch DICOM traffic logs' });
    }
});

app.post('/api/internal/dicom/traffic-log', async (req, res) => {
    const configuredKey = String(process.env.DICOM_TRAFFIC_INTERNAL_KEY || process.env.MWL_SCP_INTERNAL_KEY || '').trim();
    const providedKey = String(req.get('X-NEXIA-MWL-SCP-Key') || req.get('X-VEXA-DICOM-LOG-Key') || '').trim();
    const remoteAddress = String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
    const isLocalRequest = ['127.0.0.1', '::1', 'localhost'].includes(remoteAddress);
    if (configuredKey && providedKey !== configuredKey) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    if (!configuredKey && !isLocalRequest) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    const body = req.body || {};
    const toText = value => {
        const text = String(value ?? '').trim();
        return text || null;
    };
    const toInt = value => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
    };
    try {
        await ensurePacsMwlTables();
        const db = dicomwebPacs.getPacsMetadataDb();
        await db.query(
            `
            INSERT INTO dicom_traffic_logs (
              service, event_type, outcome, status_code,
              calling_ae_title, called_ae_title, remote_address, remote_port,
              patient_id, patient_name, accession_number, study_instance_uid,
              series_instance_uid, sop_instance_uid, sop_class_uid, transfer_syntax,
              modality, destination_ae_title, message, error_message, details_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
                toText(body.service) || 'dicom',
                toText(body.eventType || body.event_type) || 'UNKNOWN',
                toText(body.outcome) || 'UNKNOWN',
                toText(body.statusCode || body.status_code),
                toText(body.callingAeTitle || body.calling_ae_title),
                toText(body.calledAeTitle || body.called_ae_title),
                toText(body.remoteAddress || body.remote_address),
                toInt(body.remotePort || body.remote_port),
                toText(body.patientId || body.patient_id),
                toText(body.patientName || body.patient_name),
                toText(body.accessionNumber || body.accession_number),
                toText(body.studyInstanceUid || body.study_instance_uid),
                toText(body.seriesInstanceUid || body.series_instance_uid),
                toText(body.sopInstanceUid || body.sop_instance_uid),
                toText(body.sopClassUid || body.sop_class_uid),
                toText(body.transferSyntax || body.transfer_syntax),
                toText(body.modality),
                toText(body.destinationAeTitle || body.destination_ae_title),
                toText(body.message),
                toText(body.errorMessage || body.error_message),
                JSON.stringify(body.details || body.details_json || null),
            ]
        );
        res.status(201).json({ message: 'DICOM traffic log saved' });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to save DICOM traffic log' });
    }
});

app.post('/api/mwl/reconcile/candidates', requirePermission('view_worklist'), async (req, res) => {
    const body = req.body || {};
    const studyInstanceUid = String(body.studyInstanceUid || body.study_instance_uid || '').trim();
    const accessionNumber = String(body.accessionNumber || body.accession_number || '').trim();
    const patientId = String(body.patientId || body.patient_id || '').trim();
    try {
        const result = await findMwlReconcileCandidates({ accessionNumber, patientId, studyInstanceUid });
        res.json({
            pacsStudy: {
                studyInstanceUid,
                accessionNumber,
                patientId,
                patientName: String(body.patientName || body.patient_name || '').trim(),
                modality: String(body.modality || '').trim(),
                studyDescription: String(body.studyDescription || body.study_description || '').trim(),
                studyDate: String(body.studyDate || body.study_date || '').trim(),
            },
            exact: result.exact,
            candidates: result.candidates,
            needsConfirmation: !result.exact && result.candidates.length > 0,
        });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Failed to find reconciliation candidates' });
    }
});

app.post('/api/mwl/reconcile/confirm', requirePermission('view_worklist'), async (req, res) => {
    const body = req.body || {};
    const orderId = Number(body.orderId || body.order_id);
    const studyInstanceUid = String(body.studyInstanceUid || body.study_instance_uid || '').trim();
    const method = String(body.method || 'manual_confirmed').trim() || 'manual_confirmed';
    const reason = String(body.reason || '').trim();
    if (!Number.isFinite(orderId) || orderId <= 0 || !studyInstanceUid) {
        return res.status(400).json({ error: 'Order and PACS StudyInstanceUID are required' });
    }
    try {
        const order = await reconcileMwlOrderWithPacsStudy({
            orderId,
            actualStudyInstanceUid: studyInstanceUid,
            method,
            status: 'MANUAL_MATCHED',
            req,
            message: reason || `Study reconciled by ${method}`,
            details: {
                reason: reason || null,
                source: 'worklist_confirmation',
            },
        });
        res.json({ order: mapMwlOrderReconcileRow({ ...order, match_reason: method }) });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Failed to reconcile MWL order' });
    }
});

// === Radiology Reports ===

app.post('/api/reports/status', requireAnyPermission(...WORKFLOW_STATUS_READ_PERMISSIONS), async (req, res) => {
    const { studyInstanceUids } = req.body || {};
    if (!Array.isArray(studyInstanceUids)) {
        return res.status(400).json({ error: 'studyInstanceUids must be an array' });
    }
    if (studyInstanceUids.length === 0) {
        return res.json([]);
    }
    const unique = Array.from(new Set(studyInstanceUids.filter(uid => typeof uid === 'string' && uid.trim())));
    if (!unique.length) {
        return res.json([]);
    }
    try {
        const [rows] = await pool.query(
            `
            SELECT r.study_instance_uid, r.status, r.updated_at, r.finalized_at, u.name AS radiologist_name
            FROM radiology_reports r
            LEFT JOIN users u ON r.radiologist_id = u.id
            WHERE r.study_instance_uid IN (?)
            `,
            [unique]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to fetch report status' });
    }
});

app.get(
    '/api/studies/:studyInstanceUid/timeline',
    requireAnyPermission('view_worklist', 'view_radiologist', 'view_quality_control'),
    async (req, res) => {
        const studyInstanceUid = String(req.params.studyInstanceUid || '').trim();
        if (!studyInstanceUid) {
            return res.status(400).json({ error: 'StudyInstanceUID is required' });
        }
        try {
            await ensureQualityControlTable();
            await ensurePublicShareTable();
            const [orderRows] = await pool.query(
                `
                SELECT
                  o.id,
                  o.accession_number,
                  o.study_instance_uid,
                  o.actual_study_instance_uid,
                  o.created_at,
                  o.updated_at,
                  o.status,
                  o.kode_admin,
                  o.nama_admin,
                  o.kode_radiografer,
                  o.nama_radiografer,
                  o.kode_dokter_radiolog,
                  o.nama_radiolog,
                  o.radiografer_datetime_start,
                  o.radiografer_datetime_end,
                  COALESCE(oi.tanggal_order, o.tanggal_order) AS order_created_at,
                  COALESCE(oi.tanggal_aktivasi, o.tanggal_aktivasi) AS order_activated_at
                FROM mwl_orders o
                LEFT JOIN order_in oi ON oi.no_rontgen = o.no_rontgen
                WHERE o.study_instance_uid = ? OR o.actual_study_instance_uid = ?
                ORDER BY o.updated_at DESC, o.id DESC
                LIMIT 1
                `,
                [studyInstanceUid, studyInstanceUid]
            );
            const order = orderRows?.[0] || null;
            const studyInstanceUids = Array.from(
                new Set(
                    [studyInstanceUid, order?.study_instance_uid, order?.actual_study_instance_uid].filter(Boolean)
                )
            );

            const [reportRows] = await pool.query(
                `
                SELECT
                  r.created_at,
                  r.updated_at,
                  r.finalized_at,
                  r.status,
                  u.name AS radiologist_name,
                  u.username AS radiologist_username
                FROM radiology_reports r
                LEFT JOIN users u ON u.id = r.radiologist_id
                WHERE r.study_instance_uid IN (?)
                ORDER BY r.finalized_at DESC, r.updated_at DESC, r.created_at DESC
                LIMIT 1
                `,
                [studyInstanceUids]
            );
            const report = reportRows?.[0] || null;

            const [qcRows] = await pool.query(
                `
                SELECT
                  q.processed_at,
                  q.processed_by,
                  COALESCE(u.name, u.username, q.processed_by) AS processed_by_name
                FROM quality_control_status q
                LEFT JOIN users u ON u.username = q.processed_by
                WHERE q.study_instance_uid IN (?)
                ORDER BY q.processed_at DESC
                LIMIT 1
                `,
                [studyInstanceUids]
            );
            const qc = qcRows?.[0] || null;

            const [distributionRows] = await pool.query(
                `
                SELECT
                  p.created_at,
                  p.created_by,
                  COALESCE(u.name, u.username, p.created_by) AS created_by_name
                FROM public_share_links p
                LEFT JOIN users u ON u.username = p.created_by
                WHERE p.study_instance_uid IN (?)
                ORDER BY p.created_at DESC
                LIMIT 1
                `,
                [studyInstanceUids]
            );
            const distribution = distributionRows?.[0] || null;

            let mwlPublishedAt = null;
            if (order?.id) {
                const [mwlRows] = await pool.query(
                    `
                    SELECT sync_date
                    FROM mwl_logs
                    WHERE order_id = ?
                    ORDER BY sync_date ASC, id ASC
                    LIMIT 1
                    `,
                    [order.id]
                );
                mwlPublishedAt = mwlRows?.[0]?.sync_date || null;
            }

            res.json({
                study_instance_uid: studyInstanceUid,
                order: order
                    ? {
                          id: order.id,
                          accession_number: order.accession_number,
                          status: order.status,
                      }
                    : null,
                timestamps: {
                    order_created_at: order?.order_created_at || order?.created_at || null,
                    order_activated_at: order?.order_activated_at || null,
                    mwl_published_at: mwlPublishedAt,
                    technologist_started_at: order?.radiografer_datetime_start || null,
                    study_completed_at: order?.radiografer_datetime_end || (order?.status === 'COMPLETED' ? order?.updated_at : null),
                    report_started_at: report?.created_at || null,
                    report_finalized_at: report?.finalized_at || null,
                    qc_completed_at: qc?.processed_at || null,
                    distributed_at: distribution?.created_at || qc?.processed_at || null,
                },
                actors: {
                    admin: order?.nama_admin || order?.kode_admin || null,
                    technologist: order?.nama_radiografer || order?.kode_radiografer || null,
                    radiologist:
                        report?.radiologist_name ||
                        report?.radiologist_username ||
                        order?.nama_radiolog ||
                        order?.kode_dokter_radiolog ||
                        null,
                    qc_processed_by: qc?.processed_by_name || qc?.processed_by || null,
                    distributed_by:
                        distribution?.created_by_name ||
                        distribution?.created_by ||
                        qc?.processed_by_name ||
                        qc?.processed_by ||
                        null,
                },
            });
        } catch (err) {
            res.status(500).json({ error: err.message || 'Failed to fetch study timeline' });
        }
    }
);

app.get('/api/management-reports', requirePermission('view_management_report'), async (req, res) => {
    const startDate = normalizeStudyDate(req.query.startDate);
    const endDate = normalizeStudyDate(req.query.endDate);
    const modality = String(req.query.modality || '').trim();
    const roomName = String(req.query.roomName || '').trim();
    const study = String(req.query.study || '').trim();
    const radiologist = String(req.query.radiologist || '').trim();
    const referringPhysician = String(req.query.referringPhysician || '').trim();
    const status = String(req.query.status || '').trim().toUpperCase();
    const limit = Math.min(Math.max(Number(req.query.limit) || 250, 1), 1000);

    const filters = ['1 = 1'];
    const params = [];
    const serviceDateExpr = 'DATE(COALESCE(oi.tanggal_order, o.tanggal_order, o.study_date, o.created_at))';
    if (startDate) {
        filters.push(`${serviceDateExpr} >= ?`);
        params.push(startDate);
    }
    if (endDate) {
        filters.push(`${serviceDateExpr} <= ?`);
        params.push(endDate);
    }
    if (modality) {
        filters.push('o.modality = ?');
        params.push(modality);
    }
    if (roomName) {
        filters.push("COALESCE(NULLIF(o.modality_station_room, ''), NULLIF(m.nama_ruangan, ''), '-') = ?");
        params.push(roomName);
    }
    if (study) {
        filters.push('COALESCE(o.nama_pemeriksaan, o.procedure_desc) = ?');
        params.push(study);
    }
    if (radiologist) {
        filters.push('COALESCE(drad.nama_dokter, o.nama_radiolog) = ?');
        params.push(radiologist);
    }
    if (referringPhysician) {
        filters.push('COALESCE(dref.nama_dokter, o.nama_dokter, o.referring_physician) = ?');
        params.push(referringPhysician);
    }
    if (status) {
        filters.push('o.status = ?');
        params.push(status);
    }

    const whereClause = filters.join(' AND ');

    try {
        await ensureQualityControlTable();
        const [rows] = await pool.query(
            `
            SELECT
              o.id,
              COALESCE(o.actual_study_instance_uid, o.study_instance_uid) AS study_instance_uid,
              o.actual_study_instance_uid,
              o.accession_number,
              o.no_register,
              o.no_rontgen,
              p.no_rm,
              p.nama_pasien,
              p.tanggal_lahir,
              p.kelamin,
              CONCAT_WS(', ', NULLIF(p.alamat, ''), NULLIF(p.kecamatan, ''), NULLIF(p.kabupaten, ''), NULLIF(p.provinsi, ''), NULLIF(p.kode_pos, '')) AS alamat_lengkap,
              COALESCE(o.nama_pemeriksaan, o.procedure_desc) AS study_description,
              o.modality,
              COALESCE(NULLIF(o.modality_station_room, ''), NULLIF(m.nama_ruangan, ''), '-') AS room_name,
              o.cito,
              COALESCE(dref.nama_dokter, o.nama_dokter, o.referring_physician) AS referring_physician,
              COALESCE(drad.nama_dokter, o.nama_radiolog) AS radiologist,
              COALESCE(dtech.nama_dokter, o.nama_radiografer) AS radiographer,
              COALESCE(oi.nama_ruangan, o.nama_ruangan) AS origin_room,
              COALESCE(oi.cara_bayar, o.cara_bayar) AS payment_type,
              COALESCE(oi.nama_asuransi, o.nama_asuransi) AS insurance_name,
              o.klinis,
              o.diagnosa,
              o.status AS order_status,
              rr.status AS report_status,
              rr.findings,
              rr.conclusion,
              COALESCE(oi.tanggal_order, o.tanggal_order, o.created_at) AS order_created_at,
              COALESCE(oi.tanggal_aktivasi, o.tanggal_aktivasi) AS order_activated_at,
              mwl.first_sync_date AS mwl_published_at,
              o.radiografer_datetime_start AS technologist_started_at,
              o.radiografer_datetime_end AS study_completed_at,
              rr.created_at AS report_started_at,
              rr.finalized_at AS report_finalized_at,
              qc.processed_at AS qc_completed_at,
              qc.processed_at AS distributed_at,
              CASE WHEN o.radiografer_datetime_start >= COALESCE(oi.tanggal_order, o.tanggal_order, o.created_at)
                THEN TIMESTAMPDIFF(MINUTE, COALESCE(oi.tanggal_order, o.tanggal_order, o.created_at), o.radiografer_datetime_start) END AS waiting_minutes,
              CASE WHEN mwl.first_sync_date >= COALESCE(oi.tanggal_order, o.tanggal_order, o.created_at)
                THEN TIMESTAMPDIFF(MINUTE, COALESCE(oi.tanggal_order, o.tanggal_order, o.created_at), mwl.first_sync_date) END AS order_to_mwl_minutes,
              CASE WHEN o.radiografer_datetime_end >= o.radiografer_datetime_start
                THEN TIMESTAMPDIFF(MINUTE, o.radiografer_datetime_start, o.radiografer_datetime_end) END AS examination_minutes,
              CASE WHEN rr.created_at >= o.radiografer_datetime_end
                THEN TIMESTAMPDIFF(MINUTE, o.radiografer_datetime_end, rr.created_at) END AS radiologist_wait_minutes,
              CASE WHEN rr.finalized_at >= rr.created_at
                THEN TIMESTAMPDIFF(MINUTE, rr.created_at, rr.finalized_at) END AS reading_minutes,
              CASE WHEN qc.processed_at >= rr.finalized_at
                THEN TIMESTAMPDIFF(MINUTE, rr.finalized_at, qc.processed_at) END AS report_to_qc_minutes,
              CASE WHEN qc.processed_at IS NOT NULL THEN 0 END AS qc_to_distribution_minutes,
              CASE WHEN qc.processed_at >= COALESCE(oi.tanggal_order, o.tanggal_order, o.created_at)
                THEN TIMESTAMPDIFF(MINUTE, COALESCE(oi.tanggal_order, o.tanggal_order, o.created_at), qc.processed_at) END AS total_turnaround_minutes
            FROM mwl_orders o
            INNER JOIN patients p ON p.id = o.patient_record_id
            ${ORDER_IN_SOURCE_JOIN}
            ${MWL_MASTER_SOURCE_JOINS}
            LEFT JOIN radiology_reports rr ON rr.study_instance_uid = COALESCE(o.actual_study_instance_uid, o.study_instance_uid)
            LEFT JOIN quality_control_status qc ON qc.study_instance_uid = COALESCE(o.actual_study_instance_uid, o.study_instance_uid)
            LEFT JOIN (
              SELECT order_id, MIN(sync_date) AS first_sync_date
              FROM mwl_logs
              GROUP BY order_id
            ) mwl ON mwl.order_id = o.id
            WHERE ${whereClause}
            ORDER BY COALESCE(oi.tanggal_order, o.tanggal_order, o.created_at) DESC, o.id DESC
            LIMIT ?
            `,
            [...params, limit]
        );

        const [summaryRows] = await pool.query(
            `
            SELECT
              COUNT(*) AS total_orders,
              SUM(CASE WHEN o.status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed_orders,
              SUM(CASE WHEN UPPER(COALESCE(o.cito, '')) IN ('1','Y','YES','TRUE','S','E','CITO','EMERGENCY') THEN 1 ELSE 0 END) AS cito_orders,
              SUM(CASE WHEN rr.finalized_at IS NOT NULL THEN 1 ELSE 0 END) AS finalized_reports,
              SUM(CASE WHEN qc.processed_at IS NOT NULL THEN 1 ELSE 0 END) AS qc_completed,
              ROUND(AVG(CASE WHEN o.radiografer_datetime_start >= COALESCE(oi.tanggal_order, o.tanggal_order, o.created_at)
                THEN TIMESTAMPDIFF(MINUTE, COALESCE(oi.tanggal_order, o.tanggal_order, o.created_at), o.radiografer_datetime_start) END), 1) AS avg_waiting_minutes,
              ROUND(AVG(CASE WHEN o.radiografer_datetime_end >= o.radiografer_datetime_start
                THEN TIMESTAMPDIFF(MINUTE, o.radiografer_datetime_start, o.radiografer_datetime_end) END), 1) AS avg_examination_minutes,
              ROUND(AVG(CASE WHEN rr.finalized_at >= rr.created_at
                THEN TIMESTAMPDIFF(MINUTE, rr.created_at, rr.finalized_at) END), 1) AS avg_reading_minutes,
              ROUND(AVG(CASE WHEN qc.processed_at >= COALESCE(oi.tanggal_order, o.tanggal_order, o.created_at)
                THEN TIMESTAMPDIFF(MINUTE, COALESCE(oi.tanggal_order, o.tanggal_order, o.created_at), qc.processed_at) END), 1) AS avg_turnaround_minutes
            FROM mwl_orders o
            ${ORDER_IN_SOURCE_JOIN}
            ${MWL_MASTER_SOURCE_JOINS}
            LEFT JOIN radiology_reports rr ON rr.study_instance_uid = COALESCE(o.actual_study_instance_uid, o.study_instance_uid)
            LEFT JOIN quality_control_status qc ON qc.study_instance_uid = COALESCE(o.actual_study_instance_uid, o.study_instance_uid)
            WHERE ${whereClause}
            `,
            params
        );

        const [studyRows] = await pool.query(
            `
            SELECT COALESCE(o.nama_pemeriksaan, o.procedure_desc) AS name, COUNT(*) AS count
            FROM mwl_orders o
            ${ORDER_IN_SOURCE_JOIN}
            ${MWL_MASTER_SOURCE_JOINS}
            WHERE ${whereClause}
            GROUP BY COALESCE(o.nama_pemeriksaan, o.procedure_desc)
            ORDER BY count DESC, name ASC
            LIMIT 10
            `,
            params
        );

        const [examRows] = await pool.query(
            `
            SELECT
              COALESCE(o.nama_pemeriksaan, o.procedure_desc) AS name,
              o.modality,
              COUNT(*) AS count
            FROM mwl_orders o
            ${ORDER_IN_SOURCE_JOIN}
            ${MWL_MASTER_SOURCE_JOINS}
            WHERE ${whereClause}
            GROUP BY COALESCE(o.nama_pemeriksaan, o.procedure_desc), o.modality
            ORDER BY count DESC, name ASC, o.modality ASC
            `,
            params
        );

        const [modalityRows] = await pool.query(
            `
            SELECT o.modality AS name, COUNT(*) AS count
            FROM mwl_orders o
            ${ORDER_IN_SOURCE_JOIN}
            ${MWL_MASTER_SOURCE_JOINS}
            WHERE ${whereClause}
            GROUP BY o.modality
            ORDER BY count DESC, name ASC
            `,
            params
        );

        const [roomRows] = await pool.query(
            `
            SELECT
              o.modality,
              COALESCE(NULLIF(o.modality_station_room, ''), NULLIF(m.nama_ruangan, ''), '-') AS name,
              COUNT(*) AS count
            FROM mwl_orders o
            ${ORDER_IN_SOURCE_JOIN}
            ${MWL_MASTER_SOURCE_JOINS}
            WHERE ${whereClause}
            GROUP BY o.modality, COALESCE(NULLIF(o.modality_station_room, ''), NULLIF(m.nama_ruangan, ''), '-')
            ORDER BY count DESC, o.modality ASC, name ASC
            `,
            params
        );

        const [radiologistRows] = await pool.query(
            `
            SELECT COALESCE(drad.nama_dokter, o.nama_radiolog, '-') AS name, COUNT(*) AS count
            FROM mwl_orders o
            ${ORDER_IN_SOURCE_JOIN}
            ${MWL_MASTER_SOURCE_JOINS}
            WHERE ${whereClause}
            GROUP BY COALESCE(drad.nama_dokter, o.nama_radiolog, '-')
            ORDER BY count DESC, name ASC
            LIMIT 10
            `,
            params
        );

        const [radiologistExamRows] = await pool.query(
            `
            SELECT
              o.modality,
              COALESCE(o.nama_pemeriksaan, o.procedure_desc) AS exam,
              COALESCE(drad.nama_dokter, o.nama_radiolog, '-') AS name,
              COUNT(*) AS count
            FROM mwl_orders o
            ${ORDER_IN_SOURCE_JOIN}
            ${MWL_MASTER_SOURCE_JOINS}
            WHERE ${whereClause}
            GROUP BY o.modality, COALESCE(o.nama_pemeriksaan, o.procedure_desc), COALESCE(drad.nama_dokter, o.nama_radiolog, '-')
            ORDER BY count DESC, name ASC, exam ASC
            `,
            params
        );

        const [technologistExamRows] = await pool.query(
            `
            SELECT
              o.modality,
              COALESCE(o.nama_pemeriksaan, o.procedure_desc) AS exam,
              COALESCE(dtech.nama_dokter, o.nama_radiografer, '-') AS name,
              COUNT(*) AS count
            FROM mwl_orders o
            ${ORDER_IN_SOURCE_JOIN}
            ${MWL_MASTER_SOURCE_JOINS}
            WHERE ${whereClause}
            GROUP BY o.modality, COALESCE(o.nama_pemeriksaan, o.procedure_desc), COALESCE(dtech.nama_dokter, o.nama_radiografer, '-')
            ORDER BY count DESC, name ASC, exam ASC
            `,
            params
        );

        const [filterRows] = await pool.query(
            `
            SELECT DISTINCT
              o.modality,
              COALESCE(o.nama_pemeriksaan, o.procedure_desc) AS study_description,
              COALESCE(drad.nama_dokter, o.nama_radiolog) AS radiologist,
              COALESCE(dref.nama_dokter, o.nama_dokter, o.referring_physician) AS referring_physician
              , COALESCE(NULLIF(o.modality_station_room, ''), NULLIF(m.nama_ruangan, ''), '-') AS room_name
            FROM mwl_orders o
            ${ORDER_IN_SOURCE_JOIN}
            ${MWL_MASTER_SOURCE_JOINS}
            ORDER BY study_description ASC, modality ASC
            `
        );

        res.json({
            summary: summaryRows?.[0] || {},
            rows,
            breakdowns: {
                studies: studyRows,
                exams: examRows,
                modalities: modalityRows,
                rooms: roomRows,
                radiologists: radiologistRows,
                radiologistExams: radiologistExamRows,
                technologistExams: technologistExamRows,
            },
            filters: {
                modalities: [...new Set(filterRows.map(row => row.modality).filter(Boolean))],
                rooms: [...new Set(filterRows.map(row => row.room_name).filter(value => value && value !== '-'))],
                studies: [...new Set(filterRows.map(row => row.study_description).filter(Boolean))],
                radiologists: [...new Set(filterRows.map(row => row.radiologist).filter(Boolean))],
                referringPhysicians: [...new Set(filterRows.map(row => row.referring_physician).filter(Boolean))],
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to fetch management report' });
    }
});

app.get('/api/assets', requireAnyPermission('view_management_report', 'view_settings'), async (req, res) => {
    try {
        await ensureAssetTables();
        const [assets] = await pool.query(`
          SELECT assets.*, ${assetStatusSql} AS status
          FROM assets
          ORDER BY name ASC, asset_code ASC
        `);
        const [history] = await pool.query(`
          SELECT *
          FROM asset_history
          ORDER BY record_date DESC, id DESC
        `);
        const historyByAsset = new Map();
        history.forEach(row => {
            const records = historyByAsset.get(row.asset_code) || [];
            records.push(mapAssetHistoryRow(row));
            historyByAsset.set(row.asset_code, records);
        });
        res.json(assets.map(row => ({ ...mapAssetRow(row), history: historyByAsset.get(row.asset_code) || [] })));
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to fetch assets' });
    }
});

app.post('/api/assets', requireAnyPermission('view_management_report', 'view_settings'), async (req, res) => {
    const asset = normalizeAssetPayload(req.body);
    try {
        validateAssetPayload(asset);
        await ensureAssetTables();
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            await connection.query(
                `INSERT INTO assets
                  (asset_code, name, category, brand, model, serial_number, room, purchase_date,
                   warranty_expired_date, last_calibration_date, next_calibration_date, operational_status,
                   responsible_person, vendor, notes)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    asset.id, asset.name, asset.category, asset.brand, asset.model, asset.serialNumber,
                    asset.room, asset.purchaseDate, asset.warrantyExpiredDate, asset.lastCalibrationDate,
                    asset.nextCalibrationDate, asset.operationalStatus, asset.responsiblePerson, asset.vendor, asset.notes,
                ]
            );
            const initial = req.body?.initialHistory;
            if (initial?.date && initial?.type && initial?.title) {
                await connection.query(
                    `INSERT INTO asset_history (asset_code, record_date, record_type, title, officer, notes)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [asset.id, initial.date, initial.type, initial.title, initial.officer || null, initial.notes || null]
                );
            }
            await connection.commit();
        } catch (err) {
            await connection.rollback();
            throw err;
        } finally {
            connection.release();
        }
        res.status(201).json({ success: true, id: asset.id });
    } catch (err) {
        const status = err.code === 'ER_DUP_ENTRY' ? 409 : err.status || 500;
        res.status(status).json({ error: err.code === 'ER_DUP_ENTRY' ? 'Asset ID or serial number already exists' : err.message });
    }
});

app.put('/api/assets/:assetCode', requireAnyPermission('view_management_report', 'view_settings'), async (req, res) => {
    const originalCode = String(req.params.assetCode || '').trim();
    const asset = normalizeAssetPayload(req.body);
    try {
        validateAssetPayload(asset);
        await ensureAssetTables();
        const [result] = await pool.query(
            `UPDATE assets SET
              asset_code = ?, name = ?, category = ?, brand = ?, model = ?, serial_number = ?, room = ?,
              purchase_date = ?, warranty_expired_date = ?, last_calibration_date = ?, next_calibration_date = ?,
              operational_status = ?, responsible_person = ?, vendor = ?, notes = ?
             WHERE asset_code = ?`,
            [
                asset.id, asset.name, asset.category, asset.brand, asset.model, asset.serialNumber, asset.room,
                asset.purchaseDate, asset.warrantyExpiredDate, asset.lastCalibrationDate, asset.nextCalibrationDate,
                asset.operationalStatus, asset.responsiblePerson, asset.vendor, asset.notes, originalCode,
            ]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Asset not found' });
        res.json({ success: true, id: asset.id });
    } catch (err) {
        const status = err.code === 'ER_DUP_ENTRY' ? 409 : err.status || 500;
        res.status(status).json({ error: err.code === 'ER_DUP_ENTRY' ? 'Asset ID or serial number already exists' : err.message });
    }
});

app.delete('/api/assets/:assetCode', requireAnyPermission('view_management_report', 'view_settings'), async (req, res) => {
    try {
        await ensureAssetTables();
        const [result] = await pool.query('DELETE FROM assets WHERE asset_code = ?', [req.params.assetCode]);
        if (!result.affectedRows) return res.status(404).json({ error: 'Asset not found' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to delete asset' });
    }
});

app.post('/api/assets/:assetCode/history', requireAnyPermission('view_management_report', 'view_settings'), async (req, res) => {
    const { date, type, title, officer, notes } = req.body || {};
    if (!date || !type || !String(title || '').trim()) return res.status(400).json({ error: 'Date, type, and title are required' });
    try {
        await ensureAssetTables();
        const [result] = await pool.query(
            `INSERT INTO asset_history (asset_code, record_date, record_type, title, officer, notes)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [req.params.assetCode, date, type, String(title).trim(), officer || null, notes || null]
        );
        res.status(201).json({ success: true, id: result.insertId });
    } catch (err) {
        res.status(err.code === 'ER_NO_REFERENCED_ROW_2' ? 404 : 500).json({ error: err.message || 'Failed to add asset history' });
    }
});

app.put('/api/assets/:assetCode/history/:historyId', requireAnyPermission('view_management_report', 'view_settings'), async (req, res) => {
    const { date, type, title, officer, notes } = req.body || {};
    if (!date || !type || !String(title || '').trim()) return res.status(400).json({ error: 'Date, type, and title are required' });
    try {
        await ensureAssetTables();
        const [result] = await pool.query(
            `UPDATE asset_history SET record_date = ?, record_type = ?, title = ?, officer = ?, notes = ?
             WHERE id = ? AND asset_code = ?`,
            [date, type, String(title).trim(), officer || null, notes || null, req.params.historyId, req.params.assetCode]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Track record not found' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to update asset history' });
    }
});

app.delete('/api/assets/:assetCode/history/:historyId', requireAnyPermission('view_management_report', 'view_settings'), async (req, res) => {
    try {
        await ensureAssetTables();
        const [result] = await pool.query(
            'DELETE FROM asset_history WHERE id = ? AND asset_code = ?',
            [req.params.historyId, req.params.assetCode]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Track record not found' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to delete asset history' });
    }
});

app.post('/api/qc/status', requireAnyPermission(...WORKFLOW_STATUS_READ_PERMISSIONS), async (req, res) => {
    const { studyInstanceUids } = req.body || {};
    if (!Array.isArray(studyInstanceUids)) {
        return res.status(400).json({ error: 'studyInstanceUids must be an array' });
    }
    if (studyInstanceUids.length === 0) {
        return res.json([]);
    }
    const unique = Array.from(new Set(studyInstanceUids.filter(uid => typeof uid === 'string' && uid.trim())));
    if (!unique.length) {
        return res.json([]);
    }
    try {
        await ensureQualityControlTable();
        const [rows] = await pool.query(
            `
            SELECT study_instance_uid, processed_by, processed_at
            FROM quality_control_status
            WHERE study_instance_uid IN (?)
            `,
            [unique]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to fetch QC status' });
    }
});

app.post('/api/qc/process', requirePermission('qc_process'), async (req, res) => {
    const { studyInstanceUids, processedBy } = req.body || {};
    if (!Array.isArray(studyInstanceUids)) {
        return res.status(400).json({ error: 'studyInstanceUids must be an array' });
    }
    if (studyInstanceUids.length === 0) {
        return res.json([]);
    }
    const unique = Array.from(new Set(studyInstanceUids.filter(uid => typeof uid === 'string' && uid.trim())));
    if (!unique.length) {
        return res.json([]);
    }
    try {
        await ensureQualityControlTable();
        const stamp = new Date();
        const values = unique.map(uid => [uid, processedBy || null, stamp]);
        await pool.query(
            `
            INSERT INTO quality_control_status (study_instance_uid, processed_by, processed_at)
            VALUES ?
            ON DUPLICATE KEY UPDATE
              processed_by = COALESCE(processed_by, VALUES(processed_by)),
              processed_at = COALESCE(processed_at, VALUES(processed_at))
            `,
            [values]
        );
        const [rows] = await pool.query(
            `
            SELECT study_instance_uid, processed_by, processed_at
            FROM quality_control_status
            WHERE study_instance_uid IN (?)
            `,
            [unique]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to update QC status' });
    }
});

app.post(
    '/api/radiologist-assignments/status',
    requireAnyPermission(...WORKFLOW_STATUS_READ_PERMISSIONS),
    async (req, res) => {
    const { studyInstanceUids } = req.body || {};
    if (!Array.isArray(studyInstanceUids)) {
        return res.status(400).json({ error: 'studyInstanceUids must be an array' });
    }
    if (studyInstanceUids.length === 0) {
        return res.json([]);
    }
    const unique = Array.from(new Set(studyInstanceUids.filter(uid => typeof uid === 'string' && uid.trim())));
    if (!unique.length) {
        return res.json([]);
    }
    try {
        await ensureRadiologistAssignmentTable();
        const [rows] = await pool.query(
            `
            SELECT ra.study_instance_uid, ra.radiologist_id, u.username AS radiologist_username, u.name AS radiologist_name
            FROM radiologist_assignments ra
            LEFT JOIN users u ON ra.radiologist_id = u.id
            WHERE ra.study_instance_uid IN (?)
            `,
            [unique]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to fetch assignments' });
    }
});

app.post('/api/radiologist-assignments/by-radiologist', requirePermission('view_radiologist'), async (req, res) => {
    const { radiologistUsername, radiologistId } = req.body || {};
    if (!radiologistUsername && !radiologistId) {
        return res.status(400).json({ error: 'radiologistUsername or radiologistId is required' });
    }
    try {
        await ensureRadiologistAssignmentTable();
        let resolvedId = radiologistId;
        if (!resolvedId && radiologistUsername) {
            const [userRows] = await pool.query('SELECT id FROM users WHERE username = ?', [
                radiologistUsername,
            ]);
            if (!userRows.length) {
                return res.status(404).json({ error: 'Radiologist not found' });
            }
            resolvedId = userRows[0].id;
        }
        const [rows] = await pool.query(
            `
            SELECT study_instance_uid
            FROM radiologist_assignments
            WHERE radiologist_id = ?
            `,
            [resolvedId]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to load assignments' });
    }
});

app.post('/api/radiologist-assignments', requireAnyPermission('view_worklist', 'view_radiologist'), async (req, res) => {
    const { studyInstanceUid, radiologistId, radiologistUsername, assignedBy } = req.body || {};
    if (!studyInstanceUid) {
        return res.status(400).json({ error: 'studyInstanceUid is required' });
    }
    if (!radiologistId && !radiologistUsername) {
        return res.status(400).json({ error: 'radiologistId or radiologistUsername is required' });
    }
    try {
        const resolvedRadiologistUserId = await resolveRadiologistUserId({
            radiologistId,
            radiologistUsername,
        });
        if (!resolvedRadiologistUserId) {
            return res.status(404).json({ error: 'Radiologist not found' });
        }
        const assignment = await assignRadiologistOwnershipForStudy({
            studyInstanceUid,
            radiologistUserId: resolvedRadiologistUserId,
            assignedBy: assignedBy || getUsernameFromRequest(req) || null,
        });
        await writeAuditLog(req, {
            eventType: 'radiologist_takeover',
            outcome: 'success',
            studyInstanceUid,
            targetType: 'study',
            targetId: studyInstanceUid,
            details: {
                radiologistId: assignment?.radiologist_id ?? resolvedRadiologistUserId,
                radiologistUsername: assignment?.radiologist_username || radiologistUsername || null,
                radiologistName: assignment?.radiologist_name || null,
                assignedBy: assignedBy || getUsernameFromRequest(req) || null,
            },
        });
        res.json({ assignment });
    } catch (err) {
        await writeAuditLog(req, {
            eventType: 'radiologist_takeover',
            outcome: 'failure',
            studyInstanceUid,
            targetType: 'study',
            targetId: studyInstanceUid,
            details: {
                radiologistId: radiologistId || null,
                radiologistUsername: radiologistUsername || null,
                assignedBy: assignedBy || getUsernameFromRequest(req) || null,
                error: err.message || 'Failed to save assignment',
            },
        });
        res.status(500).json({ error: err.message || 'Failed to save assignment' });
    }
});

app.get('/api/reports/templates', requirePermission('view_radiologist'), async (req, res) => {
    const radiologistUsername = req.query.radiologistUsername;
    const modalityCode = String(req.query.modalityCode || '').trim().toUpperCase();
    const procedureCode = String(req.query.procedureCode || '').trim().toUpperCase();
    const procedureDescription = String(req.query.procedureDescription || '').trim().toUpperCase();
    if (!radiologistUsername || typeof radiologistUsername !== 'string') {
        return res.status(400).json({ error: 'radiologistUsername is required' });
    }
    try {
        await ensureRadiologistTemplateTable();
        const [userRows] = await pool.query('SELECT id FROM users WHERE username = ?', [
            radiologistUsername,
        ]);
        if (!userRows.length) {
            return res.status(400).json({ error: 'Radiologist not found' });
        }
        const radiologistId = userRows[0].id;
        const filters = ['radiologist_id = ?'];
        const params = [radiologistId];
        if (modalityCode) {
            filters.push("(COALESCE(UPPER(modality_code), '') = ? OR COALESCE(modality_code, '') = '')");
            params.push(modalityCode);
        }
        if (procedureCode || procedureDescription) {
            const procedureFilters = [];
            if (procedureCode) {
                procedureFilters.push("COALESCE(UPPER(procedure_code), '') = ?");
                params.push(procedureCode);
            }
            if (procedureDescription) {
                procedureFilters.push("COALESCE(UPPER(procedure_description), '') = ?");
                params.push(procedureDescription);
            }
            procedureFilters.push("(COALESCE(procedure_code, '') = '' AND COALESCE(procedure_description, '') = '')");
            filters.push(`(${procedureFilters.join(' OR ')})`);
        }
        const [rows] = await pool.query(
            `SELECT id, title, findings, conclusion, modality_code, procedure_code, procedure_description, created_at, updated_at
             FROM radiologist_templates
             WHERE ${filters.join(' AND ')}
             ORDER BY updated_at DESC, created_at DESC`,
            params
        );
        res.json({ templates: rows });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to fetch templates' });
    }
});

app.get('/api/reports/:studyInstanceUid', requirePermission('view_radiologist'), async (req, res) => {
    const studyInstanceUid = req.params.studyInstanceUid;
    if (!studyInstanceUid) {
        return res.status(400).json({ error: 'Missing studyInstanceUid' });
    }
    try {
        await ensureExpertiseTables();
        const [rows] = await pool.query(
            `
            SELECT r.*, u.name AS radiologist_name
            FROM radiology_reports r
            LEFT JOIN users u ON r.radiologist_id = u.id
            WHERE r.study_instance_uid = ?
            `,
            [studyInstanceUid]
        );
        if (!rows.length) {
            return res.json({ report: null });
        }
        res.json({ report: rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to fetch report' });
    }
});

app.get('/api/reports/:studyInstanceUid/revisions', requirePermission('view_radiologist'), async (req, res) => {
    const studyInstanceUid = req.params.studyInstanceUid;
    if (!studyInstanceUid) {
        return res.status(400).json({ error: 'Missing studyInstanceUid' });
    }
    try {
        await ensureExpertiseTables();
        const [rows] = await pool.query(
            `
            SELECT r.*, u.name AS radiologist_name
            FROM radiology_report_revisions r
            LEFT JOIN users u ON r.radiologist_id = u.id
            WHERE r.study_instance_uid = ?
            ORDER BY r.created_at DESC
            `,
            [studyInstanceUid]
        );
        res.json({ revisions: rows });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to fetch report revisions' });
    }
});

app.post('/api/reports/:studyInstanceUid/revise', requirePermission('report_edit'), async (req, res) => {
    const studyInstanceUid = req.params.studyInstanceUid;
    if (!studyInstanceUid) {
        return res.status(400).json({ error: 'Missing studyInstanceUid' });
    }
    try {
        await ensureExpertiseTables();
        const [existingRows] = await pool.query(
            'SELECT * FROM radiology_reports WHERE study_instance_uid = ?',
            [studyInstanceUid]
        );
        if (!existingRows.length) {
            return res.status(404).json({ error: 'Report not found' });
        }
        await pool.query(
            `
            UPDATE radiology_reports
            SET status = 'draft', finalized_at = NULL
            WHERE study_instance_uid = ?
            `,
            [studyInstanceUid]
        );
        const [rows] = await pool.query(
            `
            SELECT r.*, u.name AS radiologist_name
            FROM radiology_reports r
            LEFT JOIN users u ON r.radiologist_id = u.id
            WHERE r.study_instance_uid = ?
            `,
            [studyInstanceUid]
        );
        await syncOrderOutForOrder({ studyInstanceUid });
        res.json({ report: rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to revise report' });
    }
});

app.post('/api/reports/:studyInstanceUid/draft', requirePermission('report_edit'), async (req, res) => {
    const studyInstanceUid = req.params.studyInstanceUid;
    const { patientId, radiologistUsername, clinicalInfo, findings, conclusion, kritis } = req.body || {};
    const criticalValue = String(kritis ?? '0') === '1' ? '1' : '0';
    if (!studyInstanceUid) {
        return res.status(400).json({ error: 'Missing studyInstanceUid' });
    }
    if (!radiologistUsername) {
        return res.status(400).json({ error: 'radiologistUsername is required' });
    }
    try {
        await ensureExpertiseTables();
        const [userRows] = await pool.query('SELECT id FROM users WHERE username = ?', [radiologistUsername]);
        if (!userRows.length) {
            return res.status(400).json({ error: 'Radiologist not found' });
        }
        const radiologistId = userRows[0].id;
        const [existingRows] = await pool.query(
            'SELECT * FROM radiology_reports WHERE study_instance_uid = ?',
            [studyInstanceUid]
        );
        if (existingRows.length) {
            const existing = existingRows[0];
            await pool.query(
                `
                INSERT INTO radiology_report_revisions
                  (report_id, study_instance_uid, patient_id, radiologist_id, clinical_info, findings, conclusion, kritis, status, finalized_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `,
                [
                    existing.id,
                    existing.study_instance_uid,
                    existing.patient_id,
                    existing.radiologist_id,
                    existing.clinical_info,
                    existing.findings,
                    existing.conclusion,
                    existing.kritis || '0',
                    existing.status,
                    existing.finalized_at,
                ]
            );
        }
        await pool.query(
            `
            INSERT INTO radiology_reports
              (study_instance_uid, patient_id, radiologist_id, clinical_info, findings, conclusion, kritis, status, finalized_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', NULL)
            ON DUPLICATE KEY UPDATE
              patient_id = VALUES(patient_id),
              radiologist_id = VALUES(radiologist_id),
              clinical_info = VALUES(clinical_info),
              findings = VALUES(findings),
              conclusion = VALUES(conclusion),
              kritis = VALUES(kritis),
              status = 'draft',
              finalized_at = NULL
            `,
            [
                studyInstanceUid,
                patientId || null,
                radiologistId,
                clinicalInfo || null,
                findings || null,
                conclusion || null,
                criticalValue
            ]
        );
        const [rows] = await pool.query(
            `
            SELECT r.*, u.name AS radiologist_name
            FROM radiology_reports r
            LEFT JOIN users u ON r.radiologist_id = u.id
            WHERE r.study_instance_uid = ?
            `,
            [studyInstanceUid]
        );
        await syncOrderOutForOrder({ studyInstanceUid });
        res.json({ report: rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to save draft' });
    }
});

app.post('/api/reports/:studyInstanceUid/finalize', requirePermission('report_finalize'), async (req, res) => {
    const studyInstanceUid = req.params.studyInstanceUid;
    const { patientId, radiologistUsername, clinicalInfo, findings, conclusion, kritis } = req.body || {};
    const criticalValue = String(kritis ?? '0') === '1' ? '1' : '0';
    if (!studyInstanceUid) {
        return res.status(400).json({ error: 'Missing studyInstanceUid' });
    }
    if (!radiologistUsername) {
        return res.status(400).json({ error: 'radiologistUsername is required' });
    }
    try {
        await ensureExpertiseTables();
        const [userRows] = await pool.query('SELECT id FROM users WHERE username = ?', [radiologistUsername]);
        if (!userRows.length) {
            return res.status(400).json({ error: 'Radiologist not found' });
        }
        const radiologistId = userRows[0].id;
        const [existingRows] = await pool.query(
            'SELECT * FROM radiology_reports WHERE study_instance_uid = ?',
            [studyInstanceUid]
        );
        if (existingRows.length) {
            const existing = existingRows[0];
            await pool.query(
                `
                INSERT INTO radiology_report_revisions
                  (report_id, study_instance_uid, patient_id, radiologist_id, clinical_info, findings, conclusion, kritis, status, finalized_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `,
                [
                    existing.id,
                    existing.study_instance_uid,
                    existing.patient_id,
                    existing.radiologist_id,
                    existing.clinical_info,
                    existing.findings,
                    existing.conclusion,
                    existing.kritis || '0',
                    existing.status,
                    existing.finalized_at,
                ]
            );
        }
        await pool.query(
            `
            INSERT INTO radiology_reports
              (study_instance_uid, patient_id, radiologist_id, clinical_info, findings, conclusion, kritis, status, finalized_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'final', NOW())
            ON DUPLICATE KEY UPDATE
              patient_id = VALUES(patient_id),
              radiologist_id = VALUES(radiologist_id),
              clinical_info = VALUES(clinical_info),
              findings = VALUES(findings),
              conclusion = VALUES(conclusion),
              kritis = VALUES(kritis),
              status = 'final',
              finalized_at = NOW()
            `,
            [
                studyInstanceUid,
                patientId || null,
                radiologistId,
                clinicalInfo || null,
                findings || null,
                conclusion || null,
                criticalValue
            ]
        );
        const [rows] = await pool.query(
            `
            SELECT r.*, u.name AS radiologist_name
            FROM radiology_reports r
            LEFT JOIN users u ON r.radiologist_id = u.id
            WHERE r.study_instance_uid = ?
            `,
            [studyInstanceUid]
        );
        let orderOutError = null;
        try {
            await syncOrderOutForOrder({ studyInstanceUid });
        } catch (error) {
            orderOutError = error.message || 'Failed to sync order out';
            console.error('[REPORT FINALIZE][ORDER_OUT]', orderOutError);
        }

        let srReport = null;
        let srReportError = null;
        try {
            srReport = await createDicomSrReportForStudy({
                studyInstanceUid,
                patientId: patientId || null,
                clinicalInfo,
                findings,
                conclusion,
                radiologistName: rows[0]?.radiologist_name || radiologistUsername,
                radiologistUsername,
            });
        } catch (error) {
            srReportError = error.message || 'Failed to create DICOM SR report';
            console.error('[DICOM SR REPORT]', srReportError, error.details || '');
        }
        res.json({
            report: rows[0],
            order_out_error: orderOutError,
            sr_report: srReport,
            sr_report_error: srReportError,
        });
    } catch (err) {
        console.error('[REPORT FINALIZE]', err);
        res.status(500).json({ error: err.message || 'Failed to finalize report' });
    }
});

app.post('/api/reports/templates', requirePermission('report_edit'), async (req, res) => {
    const {
        radiologistUsername,
        title,
        findings,
        conclusion,
        modalityCode,
        procedureCode,
        procedureDescription,
    } = req.body || {};
    if (!radiologistUsername) {
        return res.status(400).json({ error: 'radiologistUsername is required' });
    }
    if (!title || !String(title).trim()) {
        return res.status(400).json({ error: 'title is required' });
    }
    try {
        await ensureRadiologistTemplateTable();
        const [userRows] = await pool.query('SELECT id FROM users WHERE username = ?', [
            radiologistUsername,
        ]);
        if (!userRows.length) {
            return res.status(400).json({ error: 'Radiologist not found' });
        }
        const radiologistId = userRows[0].id;
        const normalizedModalityCode = String(modalityCode || '').trim().toUpperCase() || null;
        const normalizedProcedureCode = String(procedureCode || '').trim() || null;
        const normalizedProcedureDescription = String(procedureDescription || '').trim() || null;
        const [result] = await pool.query(
            `
            INSERT INTO radiologist_templates
              (radiologist_id, title, findings, conclusion, modality_code, procedure_code, procedure_description)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            `,
            [
                radiologistId,
                String(title).trim(),
                findings || null,
                conclusion || null,
                normalizedModalityCode,
                normalizedProcedureCode,
                normalizedProcedureDescription,
            ]
        );
        const templateId = result.insertId;
        const [rows] = await pool.query(
            `
            SELECT id, title, findings, conclusion, modality_code, procedure_code, procedure_description, created_at, updated_at
            FROM radiologist_templates
            WHERE id = ?
            `,
            [templateId]
        );
        res.json({ template: rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to save template' });
    }
});

const resolvePublicBaseUrl = async req => {
    const appLinkSettings = readAppLinkSettings();
    // KHUSUS MODE DEVELOPMENT: UI (aplikasi, mis. :8080) dan API (:3001) berbeda origin,
    // jadi link yang dibangun dari host request API akan salah port. Hanya di situasi itu
    // origin browser dipakai. Gate dibuat ketat (KEDUA sisi lokal/LAN) supaya produksi dan
    // installer berperilaku persis seperti sebelumnya.
    const hostOrigin = resolveRequestOrigin(req);
    const browserOrigin = resolveBrowserOrigin(req);
    const devSplitOrigin =
        Boolean(browserOrigin) &&
        browserOrigin !== hostOrigin &&
        isLocalOrLanOrigin(hostOrigin) &&
        isLocalOrLanOrigin(browserOrigin);
    const requestOrigin = devSplitOrigin ? browserOrigin : hostOrigin;
    const configuredPublicBaseUrl = String(appLinkSettings.publicBaseUrl || '').trim().replace(/\/+$/, '');
    if (requestOrigin) {
        if (!configuredPublicBaseUrl) return requestOrigin;
        try {
            const configured = new URL(configuredPublicBaseUrl);
            const host = configured.hostname.toLowerCase();
            if (
                host === 'localhost' ||
                host === '127.0.0.1' ||
                configured.port === '8080' ||
                /^192\.168\./.test(host) ||
                /^10\./.test(host) ||
                /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
            ) {
                return requestOrigin;
            }
        } catch (err) {
            if (configuredPublicBaseUrl.startsWith('/')) {
                return resolveOriginAwareUrl(req, configuredPublicBaseUrl, '');
            }
        }
    }
    if (appLinkSettings.publicBaseUrl) {
        return appLinkSettings.publicBaseUrl;
    }
    const envBase = process.env.PUBLIC_SHARE_BASE_URL;
    if (envBase) {
        return String(envBase).replace(/\/+$/, '');
    }
    const originHeader = req.get('origin');
    if (originHeader) return originHeader;
    const referer = req.get('referer');
    if (referer) {
        try {
            return new URL(referer).origin;
        } catch (err) {}
    }
    try {
        const uiSettings = await readUiSettings();
        if (uiSettings?.viewerUrl) {
            return uiSettings.viewerUrl;
        }
    } catch (err) {}
    return `${req.protocol}://${req.get('host')}`;
};

async function launchConfiguredViewerFromAccessLink({ appLinkSettings, viewerId, role, rule, accessLink, studyInstanceUid, order, req = null }) {
    const launchViewer = resolveRisLaunchViewer(appLinkSettings, viewerId);
    if (!launchViewer) return null;
    const launchBaseUrl = String(launchViewer.baseUrl || appLinkSettings.pacsViewerBaseUrl || '').trim().replace(/\/+$/, '');
    const launchInternalBaseUrl = String(
        launchViewer.internalBaseUrl ||
        launchViewer.launchInternalBaseUrl ||
        launchViewer.internalUrl ||
        launchBaseUrl
    ).trim().replace(/\/+$/, '');
    const launchEndpointPath = String(
        launchViewer.launchEndpoint ||
        appLinkSettings.pacsViewerLaunchEndpoint ||
        '/api/auth/ris/launch'
    ).trim();
    const launchSecret = resolveRisLaunchSecret(launchViewer, appLinkSettings);
    if (!launchBaseUrl || !launchInternalBaseUrl || !launchEndpointPath || !launchSecret) return null;

    const launchEndpoint = resolveRisLaunchEndpointUrl(launchInternalBaseUrl, launchEndpointPath);
    const launchHeaderName = resolveRisLaunchHeaderName(launchViewer);
    const launchUser = rule?.launchUser && typeof rule.launchUser === 'object' ? rule.launchUser : {};
    const userRole = String(launchUser.role || role || rule?.role || 'clinician').trim().toLowerCase().replace(/\s+/g, '_') || 'clinician';
    const username = String(launchUser.username || `orderout-${userRole}`).trim() || `orderout-${userRole}`;
    const externalUserId = String(launchUser.externalUserId || username).trim() || username;
    const fullName = String(
        launchUser.fullName ||
        (userRole === 'clinician' ? 'SIMRS Clinician' : `SIMRS ${userRole}`)
    ).trim();
    const payload = {
        user: {
            externalUserId,
            username,
            fullName,
            role: userRole,
        },
        StudyInstanceUID: studyInstanceUid || '',
        accession: accessLink.accession_number || '',
        patientId: order?.no_rm || '',
        mode: 'stack',
    };
    if (launchUser.password !== undefined && launchUser.password !== null && String(launchUser.password) !== '') {
        payload.user.password = String(launchUser.password);
        payload.password = String(launchUser.password);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let response;
    try {
        response = await fetch(launchEndpoint.toString(), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                [launchHeaderName]: launchSecret,
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
    } catch (err) {
        const error = new Error(err?.name === 'AbortError' ? 'Viewer launch timed out' : err.message || 'Viewer launch failed');
        error.status = 504;
        throw error;
    } finally {
        clearTimeout(timeout);
    }
    const responseText = await response.text();
    let responsePayload = null;
    try {
        responsePayload = responseText ? JSON.parse(responseText) : null;
    } catch {
        responsePayload = { raw: responseText };
    }
    if (!response.ok || !responsePayload?.launchUrl) {
        const error = new Error(responsePayload?.error || responsePayload?.message || 'Viewer launch failed');
        error.status = response.status || 502;
        throw error;
    }
    const interactiveLaunchBaseUrl = req
        ? resolveViewerPublicBaseUrl(req, launchViewer, launchBaseUrl)
        : launchBaseUrl;
    return rewriteRisLaunchUrlForConfiguredBase(responsePayload.launchUrl, interactiveLaunchBaseUrl);
}

app.post('/api/public/share', requirePermission('report_export'), async (req, res) => {
    const { studyInstanceUid, expiresInDays, patientPhone, createdBy, templateId, allowIncompleteDistribution } = req.body || {};
    if (!studyInstanceUid) {
        return res.status(400).json({ error: 'Missing studyInstanceUid' });
    }
    try {
        if (allowIncompleteDistribution !== true) {
            await ensureExpertiseTables();
            const [finalReportRows] = await pool.query(
            `
            SELECT findings, conclusion
            FROM (
              SELECT findings, conclusion, finalized_at AS completed_at, created_at
              FROM radiology_report_revisions
              WHERE study_instance_uid = ? AND status = 'final'
              UNION ALL
              SELECT findings, conclusion, finalized_at AS completed_at, created_at
              FROM radiology_reports
              WHERE study_instance_uid = ? AND status = 'final'
            ) final_reports
            ORDER BY COALESCE(completed_at, created_at) DESC
            LIMIT 1
            `,
            [studyInstanceUid, studyInstanceUid]
        );
            const finalReport = finalReportRows?.[0] || null;
            if (!finalReport || !String(finalReport.findings || '').trim() || !String(finalReport.conclusion || '').trim()) {
                return res.status(409).json({
                    error: 'The radiologist report is incomplete. Confirm incomplete distribution to continue.',
                    code: 'REPORT_NOT_READY_FOR_DISTRIBUTION',
                });
            }
            const studySeries = asDicomRows(
                await fetchDicomwebJson(`/studies/${encodeURIComponent(studyInstanceUid)}/series`)
            );
            if (!studySeries.length) {
                return res.status(409).json({
                    error: 'Examination images are not available. Confirm incomplete distribution to continue.',
                    code: 'IMAGES_NOT_READY_FOR_DISTRIBUTION',
                });
            }
        }
        await ensurePublicShareTable();
        const days = Number(expiresInDays);
        const expiresAt =
            Number.isFinite(days) && days > 0
                ? new Date(Date.now() + days * 24 * 60 * 60 * 1000)
                : null;
        const createdByValue = createdBy || getRoleFromRequest(req) || null;
        const normalizedTemplateId = await normalizeExpertiseTemplateId(templateId);
        let token = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const candidate = crypto.randomBytes(16).toString('hex');
            try {
                await pool.query(
                    `
                    INSERT INTO public_share_links (token, study_instance_uid, created_by, expires_at, patient_phone, template_id)
                    VALUES (?, ?, ?, ?, ?, ?)
                    `,
                    [candidate, studyInstanceUid, createdByValue, expiresAt, patientPhone || null, normalizedTemplateId]
                );
                token = candidate;
                break;
            } catch (err) {
                if (err.code !== 'ER_DUP_ENTRY' || attempt === 2) {
                    throw err;
                }
            }
        }
        if (!token) {
            return res.status(500).json({ error: 'Failed to create share link' });
        }
        await ensureQualityControlTable();
        await pool.query(
            `
            INSERT INTO quality_control_status (study_instance_uid, processed_by, processed_at)
            VALUES (?, ?, NOW())
            ON DUPLICATE KEY UPDATE
              processed_by = COALESCE(processed_by, VALUES(processed_by)),
              processed_at = COALESCE(processed_at, VALUES(processed_at))
            `,
            [studyInstanceUid, createdByValue]
        );
        await syncOrderOutForOrder({ studyInstanceUid, req });
        const baseUrl = await resolvePublicBaseUrl(req);
        const appLinkSettings = readAppLinkSettings();
        res.json({
            token,
            url: buildPublicAppUrl(baseUrl, appLinkSettings.publicStudyPath, token),
            expires_at: expiresAt,
            patient_phone: patientPhone || null,
            template_id: normalizedTemplateId,
        });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to create share link' });
    }
});

app.get('/api/public/share/latest', requirePermission('report_export'), async (req, res) => {
    const studyInstanceUid = req.query.studyInstanceUid;
    if (!studyInstanceUid) {
        return res.status(400).json({ error: 'Missing studyInstanceUid' });
    }
    try {
        await ensurePublicShareTable();
        const [rows] = await pool.query(
            `
            SELECT token, study_instance_uid, created_by, created_at, expires_at, patient_phone, template_id
            FROM public_share_links
            WHERE study_instance_uid = ?
            ORDER BY created_at DESC
            LIMIT 1
            `,
            [studyInstanceUid]
        );
        const latest = rows[0];
        if (!latest) {
            return res.json(null);
        }
        const baseUrl = await resolvePublicBaseUrl(req);
        const appLinkSettings = readAppLinkSettings();
        res.json({
            token: latest.token,
            url: buildPublicAppUrl(baseUrl, appLinkSettings.publicStudyPath, latest.token),
            expires_at: latest.expires_at,
            patient_phone: latest.patient_phone,
            template_id: latest.template_id || null,
        });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to load share link' });
    }
});

app.patch('/api/public/share/:token/phone', requirePermission('report_export'), async (req, res) => {
    const token = req.params.token;
    const { patientPhone } = req.body || {};
    if (!token) {
        return res.status(400).json({ error: 'Missing token' });
    }
    try {
        await ensurePublicShareTable();
        const [rows] = await pool.query(
            'SELECT study_instance_uid FROM public_share_links WHERE token = ? LIMIT 1',
            [token]
        );
        await pool.query(
            'UPDATE public_share_links SET patient_phone = ? WHERE token = ?',
            [patientPhone || null, token]
        );
        const studyInstanceUid = rows[0]?.study_instance_uid || null;
        if (studyInstanceUid) {
            await syncOrderOutForOrder({ studyInstanceUid, req });
        }
        res.json({ token, patient_phone: patientPhone || null });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to update phone' });
    }
});

async function resolveViewerTokenRedirect(token, req, linkKey = null) {
    if (!token) {
        const error = new Error('Missing token');
        error.status = 400;
        throw error;
    }
    const accessLink = await readViewerAccessLink(token);
    if (!accessLink) {
        await writeAuditLog(req, {
            eventType: 'viewer_token_open',
            outcome: 'failure',
            targetType: 'viewer_access_link',
            targetId: token,
            details: { reason: 'not_found' },
        });
        const error = new Error('Viewer token not found');
        error.status = 404;
        throw error;
    }
    if (accessLink.revoked_at) {
        await writeAuditLog(req, {
            eventType: 'viewer_token_open',
            outcome: 'failure',
            targetType: 'viewer_access_link',
            targetId: token,
            details: { reason: 'revoked', accession_number: accessLink.accession_number },
        });
        const error = new Error('Viewer token has been revoked');
        error.status = 403;
        throw error;
    }
    if (accessLink.expires_at && new Date(accessLink.expires_at).getTime() <= Date.now()) {
        await writeAuditLog(req, {
            eventType: 'viewer_token_open',
            outcome: 'failure',
            targetType: 'viewer_access_link',
            targetId: token,
            details: { reason: 'expired', accession_number: accessLink.accession_number },
        });
        const error = new Error('Viewer token has expired');
        error.status = 410;
        throw error;
    }

    const order = await loadOrderOutSource({ accessionNumber: accessLink.accession_number });
    const effectiveStudyInstanceUid = order?.actual_study_instance_uid || order?.study_instance_uid || null;
    if (!effectiveStudyInstanceUid) {
        await writeAuditLog(req, {
            eventType: 'viewer_token_open',
            outcome: 'failure',
            targetType: 'viewer_access_link',
            targetId: token,
            details: {
                reason: 'study_not_ready',
                accession_number: accessLink.accession_number,
            },
        });
        const error = new Error('Study for this accession is not ready yet');
        error.status = 404;
        throw error;
    }
    let hasPacsImages = false;
    try {
        hasPacsImages = (await dicomwebPacs.getStudyInstanceCount(effectiveStudyInstanceUid)) > 0;
    } catch (err) {
        hasPacsImages = false;
    }
    if (!hasPacsImages) {
        await writeAuditLog(req, {
            eventType: 'viewer_token_open',
            outcome: 'failure',
            targetType: 'viewer_access_link',
            targetId: token,
            details: {
                reason: 'scheduled_study_without_images',
                accession_number: accessLink.accession_number,
                study_instance_uid: effectiveStudyInstanceUid,
            },
        });
        const error = new Error('Study images are not ready yet');
        error.status = 404;
        throw error;
    }

    const appLinkSettings = readAppLinkSettings();
    const requestedViewerId = normalizeNullableString(req.query?.viewer || req.query?.viewerId || req.query?.viewer_id, 128);
    const requestedRole = normalizeNullableString(req.query?.role || req.query?.viewerRole || req.query?.viewer_role, 64);
    let redirectUrlValue = null;
    const keyedViewerRule = linkKey ? findOrderOutViewerRuleByKey(appLinkSettings, linkKey, order) : null;
    if (keyedViewerRule) {
        redirectUrlValue = await launchConfiguredViewerFromAccessLink({
            appLinkSettings,
            viewerId: keyedViewerRule.rule.viewerId,
            role: keyedViewerRule.rule.role || 'clinician',
            rule: keyedViewerRule.rule,
            accessLink,
            studyInstanceUid: effectiveStudyInstanceUid,
            order,
            req,
        });
    }
    if (!redirectUrlValue && requestedViewerId) {
        const viewerRule = findOrderOutViewerRule(appLinkSettings, requestedViewerId, requestedRole || 'clinician', order);
        redirectUrlValue = await launchConfiguredViewerFromAccessLink({
            appLinkSettings,
            viewerId: requestedViewerId,
            role: requestedRole || 'clinician',
            rule: viewerRule,
            accessLink,
            studyInstanceUid: effectiveStudyInstanceUid,
            order,
            req,
        });
    }
    if (!redirectUrlValue) {
        const viewerBaseUrl = resolveOriginAwareUrl(
            req,
            appLinkSettings.viewerLaunchBaseUrl || process.env.ORDER_OUT_VIEWER_URL || '/viewer',
            '/viewer'
        );
        const redirectUrl = new URL(viewerBaseUrl);
        redirectUrl.searchParams.set('StudyInstanceUIDs', effectiveStudyInstanceUid);
        if (requestedRole) redirectUrl.searchParams.set('role', requestedRole);
        redirectUrlValue = redirectUrl.toString();
    }

    await pool.query(
        `
        UPDATE viewer_access_links
        SET study_instance_uid = ?,
            usage_count = usage_count + 1,
            last_used_at = NOW()
        WHERE token = ?
        `,
        [effectiveStudyInstanceUid, token]
    );

    await writeAuditLog(req, {
        eventType: 'viewer_token_open',
        outcome: 'success',
        studyInstanceUid: effectiveStudyInstanceUid,
        targetType: 'viewer_access_link',
        targetId: token,
        details: {
            accession_number: accessLink.accession_number,
            no_rontgen: order.no_rontgen || null,
            study_description: order.procedure_desc || null,
            link_key: keyedViewerRule?.key || null,
            viewer_id: keyedViewerRule?.rule?.viewerId || requestedViewerId || null,
            viewer_role: keyedViewerRule?.rule?.role || requestedRole || null,
        },
    });

    return {
        token,
        accessionNumber: accessLink.accession_number,
        studyInstanceUid: effectiveStudyInstanceUid,
        redirectUrl: redirectUrlValue,
    };
}

app.get('/api/viewer/token/:token', async (req, res) => {
    const token = String(req.params.token || '').trim();
    try {
        return res.json(await resolveViewerTokenRedirect(token, req));
    } catch (err) {
        await writeAuditLog(req, {
            eventType: 'viewer_token_open',
            outcome: 'failure',
            targetType: 'viewer_access_link',
            targetId: token,
            details: { reason: 'server_error', error: err.message || 'Failed to resolve viewer token' },
        });
        return res.status(err.status || 500).json({ error: err.message || 'Failed to resolve viewer token' });
    }
});

app.get('/api/viewer/token/:token/:linkKey', async (req, res) => {
    const token = String(req.params.token || '').trim();
    const linkKey = String(req.params.linkKey || '').trim();
    try {
        return res.json(await resolveViewerTokenRedirect(token, req, linkKey));
    } catch (err) {
        await writeAuditLog(req, {
            eventType: 'viewer_token_open',
            outcome: 'failure',
            targetType: 'viewer_access_link',
            targetId: token,
            details: { reason: 'server_error', link_key: linkKey || null, error: err.message || 'Failed to resolve viewer token' },
        });
        return res.status(err.status || 500).json({ error: err.message || 'Failed to resolve viewer token' });
    }
});

app.get('/viewer/token/:token', async (req, res) => {
    const token = String(req.params.token || '').trim();
    try {
        const payload = await resolveViewerTokenRedirect(token, req);
        return res.redirect(302, payload.redirectUrl);
    } catch (err) {
        return res.status(err.status || 500).send(err.message || 'Failed to resolve viewer token');
    }
});

app.post('/api/order-out/viewer-link/retry', requirePermission('qc_process'), async (req, res) => {
    const accessionNumbers = Array.isArray(req.body?.accessionNumbers)
        ? req.body.accessionNumbers
        : [];
    const uniqueAccessions = Array.from(
        new Set(
            accessionNumbers
                .map(value => String(value || '').trim())
                .filter(Boolean)
        )
    );

    if (!uniqueAccessions.length) {
        return res.status(400).json({ error: 'accessionNumbers must be a non-empty array' });
    }

    const results = [];

    for (const accessionNumber of uniqueAccessions) {
        try {
            const order = await loadOrderOutSource({ accessionNumber });
            if (!order) {
                results.push({
                    accessionNumber,
                    status: 'skipped',
                    reason: 'order_not_found',
                });
                continue;
            }

            const effectiveStudyInstanceUid = order.actual_study_instance_uid || order.study_instance_uid || null;
            let hasPacsImages = false;
            if (effectiveStudyInstanceUid) {
                try {
                    hasPacsImages = (await dicomwebPacs.getStudyInstanceCount(effectiveStudyInstanceUid)) > 0;
                } catch (err) {
                    hasPacsImages = false;
                }
            }
            const viewerAccessLink =
                (order.status === 'COMPLETED' || hasPacsImages) && order.accession_number
                    ? await regenerateViewerAccessLinkForAccession(
                          order.accession_number,
                          effectiveStudyInstanceUid,
                          req,
                          req.user?.username || req.user?.name || null,
                          'manual_retry'
                      )
                    : null;

            if (!viewerAccessLink) {
                results.push({
                    accessionNumber,
                    status: 'skipped',
                    reason: 'study_not_ready',
                });
                continue;
            }

            await syncOrderOutForOrder({ accessionNumber, req });
            results.push({
                accessionNumber,
                status: 'updated',
                url: viewerAccessLink.url,
                token: viewerAccessLink.token,
                expiresAt: viewerAccessLink.expires_at || null,
            });

            await writeAuditLog(req, {
                eventType: 'viewer_token_retry',
                outcome: 'success',
                studyInstanceUid: order.study_instance_uid || null,
                targetType: 'viewer_access_link',
                targetId: viewerAccessLink.token,
                details: {
                    accession_number: accessionNumber,
                    no_rontgen: order.no_rontgen || null,
                    expires_at: viewerAccessLink.expires_at || null,
                },
            });
        } catch (err) {
            results.push({
                accessionNumber,
                status: 'failed',
                reason: err.message || 'retry_failed',
            });
            await writeAuditLog(req, {
                eventType: 'viewer_token_retry',
                outcome: 'failure',
                targetType: 'viewer_access_link',
                targetId: accessionNumber,
                details: {
                    accession_number: accessionNumber,
                    error: err.message || 'retry_failed',
                },
            });
        }
    }

    return res.json({
        updated: results.filter(item => item.status === 'updated').length,
        skipped: results.filter(item => item.status === 'skipped').length,
        failed: results.filter(item => item.status === 'failed').length,
        results,
    });
});

app.get('/api/patients/phone', requirePermission('report_export'), async (req, res) => {
    const patientId = String(req.query.patientId || '').trim();
    const accessionNumber = String(req.query.accessionNumber || '').trim();
    const studyInstanceUid = String(req.query.studyInstanceUid || '').trim();
    if (!patientId && !accessionNumber && !studyInstanceUid) {
        return res.status(400).json({ error: 'Missing patient identifier' });
    }
    try {
        await ensurePatientContactTable();
        await ensureOrderInTable();
        await ensureMwlTables();

        const orderConditions = [];
        const orderParams = [];
        if (accessionNumber) {
            orderConditions.push('oi.no_rontgen = ?');
            orderParams.push(accessionNumber);
        }
        if (studyInstanceUid) {
            orderConditions.push(`
                EXISTS (
                    SELECT 1
                    FROM mwl_orders o
                    WHERE o.no_rontgen = oi.no_rontgen
                      AND (o.study_instance_uid = ? OR o.actual_study_instance_uid = ?)
                )
            `);
            orderParams.push(studyInstanceUid, studyInstanceUid);
        }

        if (orderConditions.length > 0) {
            const [matchedOrderRows] = await pool.query(
                `
                SELECT oi.no_rm, oi.no_hp
                FROM order_in oi
                WHERE (${orderConditions.join(' OR ')})
                  AND oi.no_hp IS NOT NULL
                  AND TRIM(oi.no_hp) <> ''
                ORDER BY oi.waktu_update_orderin DESC, oi.id DESC
                LIMIT 1
                `,
                orderParams
            );
            const matchedOrder = matchedOrderRows?.[0] || null;
            if (matchedOrder?.no_hp) {
                return res.json({
                    patient_id: patientId || matchedOrder.no_rm || null,
                    patient_phone: matchedOrder.no_hp,
                    source: 'order_in',
                });
            }
        }

        if (patientId) {
            const [rows] = await pool.query(
                'SELECT patient_id, patient_phone FROM patient_contacts WHERE patient_id = ?',
                [patientId]
            );
            const row = rows[0] || null;
            if (row?.patient_phone) {
                return res.json({ patient_id: patientId, patient_phone: row.patient_phone, source: 'patient_contacts' });
            }

            const [orderRows] = await pool.query(
                `
                SELECT no_rm, no_hp
                FROM order_in
                WHERE no_rm = ? AND no_hp IS NOT NULL AND TRIM(no_hp) <> ''
                ORDER BY waktu_update_orderin DESC, id DESC
                LIMIT 1
                `,
                [patientId]
            );
            const fallbackOrder = orderRows?.[0] || null;
            if (fallbackOrder?.no_hp) {
                return res.json({
                    patient_id: patientId,
                    patient_phone: fallbackOrder.no_hp,
                    source: 'order_in_patient',
                });
            }

            const [patientRows] = await pool.query(
                `
                SELECT no_rm, no_hp
                FROM patients
                WHERE no_rm = ? AND no_hp IS NOT NULL AND TRIM(no_hp) <> ''
                LIMIT 1
                `,
                [patientId]
            );
            const patient = patientRows?.[0] || null;
            if (patient?.no_hp) {
                return res.json({
                    patient_id: patientId,
                    patient_phone: patient.no_hp,
                    source: 'patients',
                });
            }
        }

        res.json({ patient_id: patientId || null, patient_phone: null, source: null });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to load patient phone' });
    }
});

app.patch('/api/patients/phone', requirePermission('report_export'), async (req, res) => {
    const { patientId, patientPhone } = req.body || {};
    if (!patientId) {
        return res.status(400).json({ error: 'Missing patientId' });
    }
    try {
        await ensurePatientContactTable();
        await ensureOrderInTable();
        await ensureMwlTables();
        await pool.query(
            `
            INSERT INTO patient_contacts (patient_id, patient_phone)
            VALUES (?, ?)
            ON DUPLICATE KEY UPDATE
              patient_phone = VALUES(patient_phone)
            `,
            [patientId, patientPhone || null]
        );
        await pool.query(
            `
            UPDATE order_in
            SET no_hp = ?
            WHERE no_rm = ?
            `,
            [patientPhone || null, patientId]
        );
        await pool.query(
            `
            UPDATE patients
            SET no_hp = ?
            WHERE no_rm = ?
            `,
            [patientPhone || null, patientId]
        );
        res.json({ patient_id: patientId, patient_phone: patientPhone || null });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to update patient phone' });
    }
});

app.post('/api/whatsapp/send', requirePermission('report_export'), async (req, res) => {
    const { number, message, patientId, studyInstanceUid, accessionNumber } = req.body || {};
    const recipientTypeRaw = String(req.body?.recipientType || req.body?.recipient_type || '').trim().toLowerCase();
    const recipientType =
        recipientTypeRaw === 'radiologist' || recipientTypeRaw === 'patient'
            ? recipientTypeRaw
            : patientId
              ? 'patient'
              : 'unknown';
    const normalizedTargetNumber = normalizeWhatsappNumber(number, readAppLinkSettings().whatsapp?.phoneCountryCode);
    try {
        const result = await sendWhatsappMessageViaConfiguredProvider({ number, message });
        await writeAuditLog(req, {
            eventType: result.sent ? 'whatsapp_send' : 'whatsapp_fallback',
            outcome: 'success',
            studyInstanceUid: studyInstanceUid || null,
            targetType: recipientType === 'radiologist' ? 'whatsapp_radiologist' : recipientType === 'patient' ? 'whatsapp_patient' : 'whatsapp',
            targetId: normalizedTargetNumber,
            details: {
                recipient_type: recipientType,
                provider: result.provider,
                sent: result.sent,
                reason: result.reason || null,
                patient_id: patientId || null,
                accession_number: accessionNumber || null,
                fallback_url: result.fallbackUrl || null,
            },
        });
        res.json(result);
    } catch (err) {
        await writeAuditLog(req, {
            eventType: 'whatsapp_send',
            outcome: 'failure',
            studyInstanceUid: studyInstanceUid || null,
            targetType: recipientType === 'radiologist' ? 'whatsapp_radiologist' : recipientType === 'patient' ? 'whatsapp_patient' : 'whatsapp',
            targetId: normalizedTargetNumber,
            details: {
                recipient_type: recipientType,
                error: err.message || 'Failed to send WhatsApp message',
                patient_id: patientId || null,
                accession_number: accessionNumber || null,
                fallback_url: err.fallbackUrl || null,
                provider_response: err.providerResponse || null,
            },
        });
        res.status(err.status || 500).json({
            error: err.message || 'Failed to send WhatsApp message',
            fallbackUrl: err.fallbackUrl || null,
        });
    }
});

function getSeriesInstanceUidFromDicomJson(series) {
    return getDicomString(series, '0020000E');
}

function getSeriesImageCountFromDicomJson(series) {
    return getDicomNumber(series, '00201209');
}

async function getPatientPortalMaxImagesPerSeries() {
    const settings = await readUiSettings();
    const rawLimit = Number(settings.patientPortalMaxImagesPerSeries);
    return Number.isFinite(rawLimit) && rawLimit >= 0
        ? Math.floor(rawLimit)
        : DEFAULT_UI_SETTINGS.patientPortalMaxImagesPerSeries;
}

async function countSeriesInstancesForPublicStudy(studyInstanceUid, seriesInstanceUid) {
    const result = await getInstances(studyInstanceUid, seriesInstanceUid, {});
    return Array.isArray(result.data) ? result.data.length : 0;
}

async function getPublicSeriesImageCount(studyInstanceUid, series) {
    const tagCount = getSeriesImageCountFromDicomJson(series);
    if (tagCount > 0) return tagCount;
    const seriesInstanceUid = getSeriesInstanceUidFromDicomJson(series);
    if (!seriesInstanceUid) return 0;
    return countSeriesInstancesForPublicStudy(studyInstanceUid, seriesInstanceUid);
}

async function filterPublicPortalSeriesByLimit(studyInstanceUid, seriesRows, limit) {
    if (!Number.isFinite(Number(limit)) || Number(limit) <= 0) {
        return Array.isArray(seriesRows) ? seriesRows : [];
    }
    const rows = Array.isArray(seriesRows) ? seriesRows : [];
    const checked = await Promise.all(rows.map(async series => {
        const imageCount = await getPublicSeriesImageCount(studyInstanceUid, series);
        return { series, imageCount };
    }));
    return checked
        .filter(item => item.imageCount <= limit)
        .map(item => item.series);
}

async function assertPublicSeriesAllowed(studyInstanceUid, seriesInstanceUid) {
    const limit = await getPatientPortalMaxImagesPerSeries();
    if (!Number.isFinite(Number(limit)) || Number(limit) <= 0) return;
    const count = await countSeriesInstancesForPublicStudy(studyInstanceUid, seriesInstanceUid);
    if (count > limit) {
        const error = new Error(`Series hidden by patient portal limit (${count} images, limit ${limit})`);
        error.status = 403;
        throw error;
    }
}

app.get('/api/public/study/:token', async (req, res) => {
    const token = req.params.token;
    if (!token) {
        return res.status(400).json({ error: 'Missing token' });
    }
    try {
        const share = await readPublicShare(token);
        if (!share) {
            return res.status(404).json({ error: 'Link not found' });
        }
        if (share.expires_at && new Date(share.expires_at).getTime() < Date.now()) {
            return res.status(410).json({ error: 'Link expired' });
        }
        const studyResult = await getStudies({ StudyInstanceUID: share.study_instance_uid });
        const study =
            Array.isArray(studyResult.data) && studyResult.data.length
                ? mapDicomStudyToWorklist(studyResult.data[0])
                : null;
        const [reportRows] = await pool.query(
            `
            SELECT r.*, u.name AS radiologist_name
            FROM radiology_reports r
            LEFT JOIN users u ON r.radiologist_id = u.id
            WHERE r.study_instance_uid = ?
            `,
            [share.study_instance_uid]
        );
        const [revisionRows] = await pool.query(
            `
            SELECT r.*, u.name AS radiologist_name
            FROM radiology_report_revisions r
            LEFT JOIN users u ON r.radiologist_id = u.id
            WHERE r.study_instance_uid = ? AND r.status = 'final'
            ORDER BY r.created_at DESC
            LIMIT 1
            `,
            [share.study_instance_uid]
        );
        let activeReport = null;
        if (revisionRows.length) {
            activeReport = revisionRows[0];
        } else if (reportRows.length && reportRows[0].status === 'final') {
            activeReport = reportRows[0];
        }
        const header = await readExpertiseSettings();
        const tokenTemplate = share.template_id ? await readExpertisePrintTemplate(share.template_id) : null;
        const defaultTemplate = tokenTemplate ? null : await readDefaultExpertisePrintTemplate();
        const selectedTemplate = tokenTemplate?.isActive ? tokenTemplate : defaultTemplate;
        const assets = {
            headerImage: selectedTemplate?.headerImage || header.headerImage || null,
            signatureImage: null,
            templateHtml: selectedTemplate?.templateHtml || header.templateHtml || null,
            qrPosition: header.qrPosition || null,
            templateId: selectedTemplate?.id || null,
            templateName: selectedTemplate?.name || null,
        };
        if (activeReport?.radiologist_id) {
            const signature = await readRadiologistSignature(activeReport.radiologist_id);
            assets.signatureImage = signature.signatureImage || null;
        }
        res.json({
            study,
            report: activeReport,
            assets,
            share: {
                expires_at: share.expires_at,
                template_id: share.template_id || null,
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to load public study' });
    }
});

app.get('/api/public/study/:token/series', async (req, res) => {
    const token = req.params.token;
    if (!token) {
        return res.status(400).json({ error: 'Missing token' });
    }
    try {
        const share = await readPublicShare(token);
        if (!share) {
            return res.status(404).json({ error: 'Link not found' });
        }
        if (share.expires_at && new Date(share.expires_at).getTime() < Date.now()) {
            return res.status(410).json({ error: 'Link expired' });
        }
        const result = await getSeries(share.study_instance_uid, req.query || {});
        const maxImagesPerSeries = await getPatientPortalMaxImagesPerSeries();
        const filteredSeries = await filterPublicPortalSeriesByLimit(
            share.study_instance_uid,
            result.data,
            maxImagesPerSeries
        );
        res.set('Content-Type', 'application/dicom+json');
        res.status(200).json(filteredSeries);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Failed to load series' });
    }
});

app.get('/api/public/study/:token/series/:seriesInstanceUid/instances', async (req, res) => {
    const token = req.params.token;
    const seriesInstanceUid = req.params.seriesInstanceUid;
    if (!token || !seriesInstanceUid) {
        return res.status(400).json({ error: 'Missing token or seriesInstanceUid' });
    }
    try {
        const share = await readPublicShare(token);
        if (!share) {
            return res.status(404).json({ error: 'Link not found' });
        }
        if (share.expires_at && new Date(share.expires_at).getTime() < Date.now()) {
            return res.status(410).json({ error: 'Link expired' });
        }
        await assertPublicSeriesAllowed(share.study_instance_uid, seriesInstanceUid);
        const result = await getInstances(share.study_instance_uid, seriesInstanceUid, req.query || {});
        res.set('Content-Type', 'application/dicom+json');
        res.status(200).json(result.data);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Failed to load instances' });
    }
});

app.use(dicomConfig.dicomweb.basePath, dicomwebRoutes);

// === DICOM Server Management ===

function stripJsonComments(input) {
    let output = '';
    let inString = false;
    let escaped = false;
    let inLineComment = false;
    let inBlockComment = false;
    for (let i = 0; i < input.length; i += 1) {
        const current = input[i];
        const next = input[i + 1];
        if (inLineComment) {
            if (current === '\n') {
                inLineComment = false;
                output += current;
            }
            continue;
        }
        if (inBlockComment) {
            if (current === '*' && next === '/') {
                inBlockComment = false;
                i += 1;
            }
            continue;
        }
        if (inString) {
            output += current;
            if (escaped) {
                escaped = false;
                continue;
            }
            if (current === '\\') {
                escaped = true;
                continue;
            }
            if (current === '"') {
                inString = false;
            }
            continue;
        }
        if (current === '"') {
            inString = true;
            output += current;
            continue;
        }
        if (current === '/' && next === '/') {
            inLineComment = true;
            i += 1;
            continue;
        }
        if (current === '/' && next === '*') {
            inBlockComment = true;
            i += 1;
            continue;
        }
        output += current;
    }
    return output;
}

function parseOrthancConfig(raw) {
    return JSON.parse(stripJsonComments(raw));
}

function replaceJsonValue(raw, key, value) {
    const pattern = new RegExp(
        `("${key}"\\s*:\\s*)(?:"(?:\\\\.|[^"])*"|[^,\\r\\n]+)`
    );
    if (!pattern.test(raw)) {
        return raw;
    }
    return raw.replace(pattern, (_, prefix) => `${prefix}${value}`);
}

async function readOrthancConfig() {
    if (!fs.existsSync(ORTHANC_CONFIG_PATH)) {
        const err = new Error('Orthanc config not found');
        err.status = 404;
        throw err;
    }
    const raw = await fs.promises.readFile(ORTHANC_CONFIG_PATH, 'utf-8');
    return parseOrthancConfig(raw);
}

function buildServerSettingsFromConfig(config) {
    const storageDirectory =
        config.StorageDirectory || config.MAGDevice0 || config.MagDevice0 || '';
    const aeTitle = config.DicomAet || config.AETitle || config.AeTitle || '';
    const dicomPort =
        config.DicomPort !== undefined && config.DicomPort !== null
            ? String(config.DicomPort)
            : '';
    return {
        magDevice0: storageDirectory,
        ae: aeTitle,
        port: dicomPort,
    };
}

function deriveHostFromUrl(value) {
    if (!value) {
        return '127.0.0.1';
    }
    try {
        return new URL(value).hostname || '127.0.0.1';
    } catch (err) {
        return '127.0.0.1';
    }
}

function getDefaultDicomwebServerSettings() {
    const pacsBaseUrl = String(
        dicomConfig.dicomweb.pacsRoot || DICOMWEB_PACS_ROOT || 'http://127.0.0.1:5001'
    ).replace(/\/+$/, '');
    const rsRoot = String(
        dicomConfig.dicomweb.pacsRsRoot || `${pacsBaseUrl}/rs`
    ).replace(/\/+$/, '');
    const storagePath = String(
        dicomConfig.dicomweb.pacsStoragePath || path.join(__dirname, '..', '..', 'DATA')
    );
    const dicomHost = String(
        process.env.DICOMWEB_PACS_DICOM_HOST || deriveHostFromUrl(pacsBaseUrl)
    );
    const dicomPort = String(process.env.DICOMWEB_PACS_DICOM_PORT || '8889');
    const aeTitle = String(process.env.DICOMWEB_PACS_AET || 'DICOMWEB_PACS');
    return {
        storagePath,
        pacsBaseUrl,
        rsRoot,
        aeTitle,
        dicomHost,
        dicomPort,
    };
}

function normalizeDicomwebServerSettings(raw) {
    const defaults = getDefaultDicomwebServerSettings();
    const input = raw && typeof raw === 'object' ? raw : {};
    const pacsBaseUrl = String(
        input.pacsBaseUrl || input.pacsRoot || defaults.pacsBaseUrl
    ).trim().replace(/\/+$/, '');
    const rsRoot = String(
        input.rsRoot || input.pacsRsRoot || `${pacsBaseUrl || defaults.pacsBaseUrl}/rs`
    ).trim().replace(/\/+$/, '');
    const storagePath = String(
        input.storagePath || input.magDevice0 || defaults.storagePath
    ).trim();
    const aeTitle = String(
        input.aeTitle || input.ae || defaults.aeTitle
    ).trim();
    const dicomHost = String(
        input.dicomHost || defaults.dicomHost || deriveHostFromUrl(pacsBaseUrl)
    ).trim();
    const dicomPort = String(
        input.dicomPort || input.port || defaults.dicomPort
    ).trim();
    return {
        storagePath,
        pacsBaseUrl,
        rsRoot,
        aeTitle,
        dicomHost,
        dicomPort,
    };
}

function applyDicomwebServerSettings(settings) {
    const normalized = normalizeDicomwebServerSettings(settings);
    dicomConfig.dicomweb.pacsRoot = normalized.pacsBaseUrl;
    dicomConfig.dicomweb.pacsRsRoot = normalized.rsRoot;
    dicomConfig.dicomweb.pacsStoragePath = normalized.storagePath;
    process.env.DICOMWEB_PACS_ROOT = normalized.pacsBaseUrl;
    process.env.DICOMWEB_PACS_RS_ROOT = normalized.rsRoot;
    process.env.DICOMWEB_PACS_STORAGE_PATH = normalized.storagePath;
    process.env.DICOMWEB_PACS_AET = normalized.aeTitle;
    process.env.DICOMWEB_PACS_DICOM_HOST = normalized.dicomHost;
    process.env.DICOMWEB_PACS_DICOM_PORT = normalized.dicomPort;
    return normalized;
}

async function readDicomwebServerSettings() {
    const defaults = getDefaultDicomwebServerSettings();
    if (!fs.existsSync(DICOMWEB_SETTINGS_PATH)) {
        return applyDicomwebServerSettings(defaults);
    }
    const raw = await fs.promises.readFile(DICOMWEB_SETTINGS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return applyDicomwebServerSettings({
        ...defaults,
        ...parsed,
    });
}

async function writeDicomwebServerSettings(payload) {
    const current = await readDicomwebServerSettings();
    const normalized = applyDicomwebServerSettings({
        ...current,
        ...(payload || {}),
    });
    await fs.promises.writeFile(
        DICOMWEB_SETTINGS_PATH,
        JSON.stringify(normalized, null, 2),
        'utf-8'
    );
    return normalized;
}

async function writeOrthancConfig(raw, config, updates) {
    let nextRaw = raw;
    if (Object.prototype.hasOwnProperty.call(updates, 'StorageDirectory')) {
        const value = JSON.stringify(String(updates.StorageDirectory));
        nextRaw = replaceJsonValue(nextRaw, 'StorageDirectory', value);
        nextRaw = replaceJsonValue(nextRaw, 'MAGDevice0', value);
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'DicomAet')) {
        const value = JSON.stringify(String(updates.DicomAet));
        nextRaw = replaceJsonValue(nextRaw, 'DicomAet', value);
        nextRaw = replaceJsonValue(nextRaw, 'AETitle', value);
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'DicomPort')) {
        const portValue = updates.DicomPort;
        const value =
            typeof portValue === 'number'
                ? String(portValue)
                : JSON.stringify(String(portValue));
        nextRaw = replaceJsonValue(nextRaw, 'DicomPort', value);
    }
    await fs.promises.writeFile(ORTHANC_CONFIG_PATH, nextRaw, 'utf-8');
    return buildServerSettingsFromConfig(config);
}

function normalizeUiSettings(raw) {
    const settings = raw && typeof raw === 'object' ? raw : {};
    const appLinkSettings = readAppLinkSettings();
    const primaryViewer = appLinkSettings.viewers?.[0] || DEFAULT_UI_SETTINGS.viewers[0];
    const rawViewerUrl = typeof settings.viewerUrl === 'string' ? settings.viewerUrl.trim() : '';
    const viewerUrl =
        rawViewerUrl && !isInternalViewerBaseUrl(rawViewerUrl)
            ? rawViewerUrl
            : primaryViewer?.baseUrl || DEFAULT_UI_SETTINGS.viewerUrl;
    const viewerPath =
        typeof settings.viewerPath === 'string' && settings.viewerPath
            ? settings.viewerPath
            : primaryViewer?.path || DEFAULT_UI_SETTINGS.viewerPath;
    const viewers = Array.isArray(appLinkSettings.viewers) && appLinkSettings.viewers.length
        ? appLinkSettings.viewers
        : DEFAULT_UI_SETTINGS.viewers;
    const viewerAccessLinkDaysRaw = Number(settings.viewerAccessLinkDays);
    const viewerAccessLinkDays =
        Number.isFinite(viewerAccessLinkDaysRaw) && viewerAccessLinkDaysRaw >= 0
            ? Math.floor(viewerAccessLinkDaysRaw)
            : DEFAULT_UI_SETTINGS.viewerAccessLinkDays;
    const patientPortalMaxImagesPerSeriesRaw = Number(settings.patientPortalMaxImagesPerSeries);
    const patientPortalMaxImagesPerSeries =
        Number.isFinite(patientPortalMaxImagesPerSeriesRaw) && patientPortalMaxImagesPerSeriesRaw >= 0
            ? Math.floor(patientPortalMaxImagesPerSeriesRaw)
            : DEFAULT_UI_SETTINGS.patientPortalMaxImagesPerSeries;
    const rawNotification = settings.radiologistWhatsappNotification && typeof settings.radiologistWhatsappNotification === 'object'
        ? settings.radiologistWhatsappNotification
        : {};
    const radiologistWhatsappNotification = {
        mode: rawNotification.mode === 'auto' ? 'auto' : 'manual',
        scope: rawNotification.scope === 'cito' ? 'cito' : 'all',
        messageTemplate:
            typeof rawNotification.messageTemplate === 'string'
                ? rawNotification.messageTemplate
                : DEFAULT_UI_SETTINGS.radiologistWhatsappNotification.messageTemplate,
    };
    return {
        facility: appLinkSettings.facility || DEFAULT_APP_LINK_SETTINGS.facility,
        viewerUrl,
        viewerPath,
        autoRefresh:
            typeof settings.autoRefresh === 'boolean'
                ? settings.autoRefresh
                : DEFAULT_UI_SETTINGS.autoRefresh,
        worklistSeriesPreviewEnabled:
            typeof settings.worklistSeriesPreviewEnabled === 'boolean'
                ? settings.worklistSeriesPreviewEnabled
                : DEFAULT_UI_SETTINGS.worklistSeriesPreviewEnabled,
        radiologistCompetitionEnabled:
            typeof settings.radiologistCompetitionEnabled === 'boolean'
                ? settings.radiologistCompetitionEnabled
                : DEFAULT_UI_SETTINGS.radiologistCompetitionEnabled,
        viewerAccessLinkDays,
        patientPortalMaxImagesPerSeries,
        radiologistWhatsappNotification,
        viewers: viewers.map(sanitizeViewerConfigForClient),
    };
}

async function ensureUiSettingsTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ui_settings (
        id INT PRIMARY KEY,
        viewer_url VARCHAR(255) NOT NULL,
        viewer_path VARCHAR(255) NOT NULL,
        auto_refresh TINYINT(1) NOT NULL,
        worklist_series_preview_enabled TINYINT(1) NOT NULL DEFAULT 1,
        radiologist_competition_enabled TINYINT(1) NOT NULL DEFAULT 0,
        viewer_access_link_days INT NOT NULL DEFAULT 7,
        patient_portal_max_images_per_series INT NOT NULL DEFAULT 100,
            radiologist_whatsapp_auto TINYINT(1) NOT NULL DEFAULT 0,
            radiologist_whatsapp_scope VARCHAR(16) NOT NULL DEFAULT 'all',
            radiologist_whatsapp_template TEXT NULL,
        viewer_config TEXT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    try {
        await pool.query(
            'ALTER TABLE ui_settings ADD COLUMN IF NOT EXISTS viewer_config TEXT NULL'
        );
    } catch (err) {}
    try {
        await pool.query(
            'ALTER TABLE ui_settings ADD COLUMN IF NOT EXISTS radiologist_competition_enabled TINYINT(1) NOT NULL DEFAULT 0'
        );
    } catch (err) {}
    try {
        await pool.query(
            'ALTER TABLE ui_settings ADD COLUMN IF NOT EXISTS worklist_series_preview_enabled TINYINT(1) NOT NULL DEFAULT 1'
        );
    } catch (err) {}
    try {
        await pool.query(
            'ALTER TABLE ui_settings ADD COLUMN IF NOT EXISTS viewer_access_link_days INT NOT NULL DEFAULT 7'
        );
    } catch (err) {}
    try {
        await pool.query(
            'ALTER TABLE ui_settings ADD COLUMN IF NOT EXISTS patient_portal_max_images_per_series INT NOT NULL DEFAULT 100'
        );
    } catch (err) {}
    try {
        await pool.query(
            'ALTER TABLE ui_settings ADD COLUMN IF NOT EXISTS radiologist_whatsapp_auto TINYINT(1) NOT NULL DEFAULT 0'
        );
    } catch (err) {}
    try {
        await pool.query(
            'ALTER TABLE ui_settings ADD COLUMN IF NOT EXISTS radiologist_whatsapp_scope VARCHAR(16) NOT NULL DEFAULT \'all\''
        );
    } catch (err) {}
    try {
        await pool.query(
            'ALTER TABLE ui_settings ADD COLUMN IF NOT EXISTS radiologist_whatsapp_template TEXT NULL'
        );
    } catch (err) {}
    await pool.query(`
      CREATE TABLE IF NOT EXISTS radiologist_whatsapp_notifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id INT NOT NULL,
        study_instance_uid VARCHAR(128) NULL,
        accession_number VARCHAR(64) NULL,
        radiologist_doctor_code VARCHAR(64) NULL,
        phone_number VARCHAR(32) NULL,
        sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        provider VARCHAR(32) NULL,
        status VARCHAR(32) NULL,
        error_message TEXT NULL,
        UNIQUE KEY uq_radiologist_whatsapp_order (order_id)
      )
    `);
}

async function ensureExpertiseTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS expertise_settings (
        id INT PRIMARY KEY,
        header_image MEDIUMTEXT,
        template_html MEDIUMTEXT,
        qr_position VARCHAR(16) NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    try {
        await pool.query(
            'ALTER TABLE expertise_settings ADD COLUMN IF NOT EXISTS template_html MEDIUMTEXT'
        );
    } catch (err) {}
    try {
        await pool.query(
            'ALTER TABLE expertise_settings ADD COLUMN IF NOT EXISTS qr_position VARCHAR(16) NULL'
        );
    } catch (err) {}
    await pool.query(`
      CREATE TABLE IF NOT EXISTS radiologist_signatures (
        user_id INT PRIMARY KEY,
        signature_image MEDIUMTEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS expertise_print_templates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(150) NOT NULL,
        header_image MEDIUMTEXT,
        template_html MEDIUMTEXT,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        is_default TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (is_active),
        INDEX (is_default)
      )
    `);
    try {
        await pool.query(
            'ALTER TABLE expertise_print_templates ADD COLUMN IF NOT EXISTS header_image MEDIUMTEXT'
        );
    } catch (err) {}
    try {
        await pool.query(
            'ALTER TABLE expertise_print_templates ADD COLUMN IF NOT EXISTS is_active TINYINT(1) NOT NULL DEFAULT 1'
        );
    } catch (err) {}
    try {
        await pool.query(
            'ALTER TABLE expertise_print_templates ADD COLUMN IF NOT EXISTS is_default TINYINT(1) NOT NULL DEFAULT 0'
        );
    } catch (err) {}
    const [templateRows] = await pool.query('SELECT COUNT(*) AS total FROM expertise_print_templates');
    if (Number(templateRows?.[0]?.total || 0) === 0) {
        const defaultTemplates = Array.isArray(DEFAULT_EXPERTISE_SETTINGS_ENV?.templates)
            ? DEFAULT_EXPERTISE_SETTINGS_ENV.templates
            : [];
        const activeDefaults = defaultTemplates.filter(item => item && typeof item === 'object');
        if (activeDefaults.length) {
            const hasDefault = activeDefaults.some(item => item.isDefault === true);
            for (let index = 0; index < activeDefaults.length; index += 1) {
                const item = activeDefaults[index];
                const name = String(item.name || `Default Template ${index + 1}`).trim() || `Default Template ${index + 1}`;
                const isActive = item.isActive === false ? 0 : 1;
                const isDefault = item.isDefault === true || (!hasDefault && index === 0) ? 1 : 0;
                await pool.query(
                    'INSERT INTO expertise_print_templates (name, header_image, template_html, is_active, is_default) VALUES (?, ?, ?, ?, ?)',
                    [
                        name,
                        typeof item.headerImage === 'string' ? item.headerImage : null,
                        typeof item.templateHtml === 'string' ? item.templateHtml : null,
                        isActive,
                        isDefault,
                    ]
                );
            }
        } else {
            const [settingsRows] = await pool.query('SELECT header_image, template_html FROM expertise_settings WHERE id = 1 LIMIT 1');
            await pool.query(
                'INSERT INTO expertise_print_templates (name, header_image, template_html, is_active, is_default) VALUES (?, ?, ?, 1, 1)',
                ['Default Template', settingsRows?.[0]?.header_image || null, settingsRows?.[0]?.template_html || null]
            );
        }
    }
}

async function ensureRadiologistTemplateTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS radiologist_templates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        radiologist_id INT NOT NULL,
        title VARCHAR(150) NOT NULL,
        findings MEDIUMTEXT,
        conclusion MEDIUMTEXT,
        modality_code VARCHAR(64) NULL,
        procedure_code VARCHAR(128) NULL,
        procedure_description VARCHAR(255) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (radiologist_id),
        INDEX idx_radiologist_templates_context (radiologist_id, modality_code, procedure_code)
      )
    `);
    await pool.query('ALTER TABLE radiologist_templates ADD COLUMN IF NOT EXISTS modality_code VARCHAR(64) NULL');
    await pool.query('ALTER TABLE radiologist_templates ADD COLUMN IF NOT EXISTS procedure_code VARCHAR(128) NULL');
    await pool.query('ALTER TABLE radiologist_templates ADD COLUMN IF NOT EXISTS procedure_description VARCHAR(255) NULL');
}

async function ensureQualityControlTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS quality_control_status (
        study_instance_uid VARCHAR(128) PRIMARY KEY,
        processed_by VARCHAR(100),
        processed_at TIMESTAMP NULL DEFAULT NULL
      )
    `);
}

async function ensureAssetTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS assets (
        asset_code VARCHAR(64) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        category VARCHAR(32) NOT NULL,
        brand VARCHAR(150) NULL,
        model VARCHAR(150) NULL,
        serial_number VARCHAR(150) NOT NULL,
        room VARCHAR(150) NULL,
        purchase_date DATE NULL,
        warranty_expired_date DATE NULL,
        last_calibration_date DATE NULL,
        next_calibration_date DATE NULL,
        operational_status VARCHAR(32) NOT NULL DEFAULT 'active',
        responsible_person VARCHAR(150) NULL,
        vendor VARCHAR(150) NULL,
        notes TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_assets_serial_number (serial_number),
        INDEX idx_assets_category (category),
        INDEX idx_assets_next_calibration (next_calibration_date)
      )
    `);
    try {
        await pool.query("ALTER TABLE radiology_reports ADD COLUMN IF NOT EXISTS kritis VARCHAR(1) NOT NULL DEFAULT '0'");
    } catch (err) {}
    try {
        await pool.query("ALTER TABLE radiology_report_revisions ADD COLUMN IF NOT EXISTS kritis VARCHAR(1) NOT NULL DEFAULT '0'");
    } catch (err) {}
    await pool.query(`
      CREATE TABLE IF NOT EXISTS asset_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        asset_code VARCHAR(64) NOT NULL,
        record_date DATE NOT NULL,
        record_type VARCHAR(64) NOT NULL,
        title VARCHAR(255) NOT NULL,
        officer VARCHAR(150) NULL,
        notes TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (asset_code) REFERENCES assets(asset_code) ON DELETE CASCADE,
        INDEX idx_asset_history_asset_date (asset_code, record_date)
      )
    `);
}

const toAssetDate = value => {
    if (!value) return null;
    if (typeof value === 'string') return value.slice(0, 10);
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

const mapAssetRow = row => ({
    id: row.asset_code,
    name: row.name,
    category: row.category,
    brand: row.brand || '',
    model: row.model || '',
    serialNumber: row.serial_number,
    room: row.room || '',
    purchaseDate: toAssetDate(row.purchase_date),
    warrantyExpiredDate: toAssetDate(row.warranty_expired_date),
    lastCalibrationDate: toAssetDate(row.last_calibration_date),
    nextCalibrationDate: toAssetDate(row.next_calibration_date),
    status: row.status,
    operationalStatus: row.operational_status,
    responsiblePerson: row.responsible_person || '',
    vendor: row.vendor || '',
    notes: row.notes || '',
});

const mapAssetHistoryRow = row => ({
    id: row.id,
    date: toAssetDate(row.record_date),
    type: row.record_type,
    title: row.title,
    officer: row.officer || '',
    notes: row.notes || '',
});

const assetStatusSql = `
  CASE
    WHEN operational_status = 'maintenance' THEN 'maintenance'
    WHEN next_calibration_date IS NOT NULL AND next_calibration_date < CURDATE() THEN 'overdue'
    WHEN next_calibration_date IS NOT NULL AND next_calibration_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY) THEN 'due_soon'
    ELSE 'active'
  END
`;

const normalizeAssetPayload = body => ({
    id: String(body?.id || '').trim(),
    name: String(body?.name || '').trim(),
    category: String(body?.category || '').trim().toUpperCase(),
    brand: String(body?.brand || '').trim() || null,
    model: String(body?.model || '').trim() || null,
    serialNumber: String(body?.serialNumber || '').trim(),
    room: String(body?.room || '').trim() || null,
    purchaseDate: body?.purchaseDate || null,
    warrantyExpiredDate: body?.warrantyExpiredDate || null,
    lastCalibrationDate: body?.lastCalibrationDate || null,
    nextCalibrationDate: body?.nextCalibrationDate || null,
    operationalStatus: body?.operationalStatus === 'maintenance' ? 'maintenance' : 'active',
    responsiblePerson: String(body?.responsiblePerson || '').trim() || null,
    vendor: String(body?.vendor || '').trim() || null,
    notes: String(body?.notes || '').trim() || null,
});

const validateAssetPayload = asset => {
    if (!asset.id || !asset.name || !asset.category || !asset.serialNumber) {
        const error = new Error('Asset ID, name, category, and serial number are required');
        error.status = 400;
        throw error;
    }
};

async function ensureRadiologistAssignmentTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS radiologist_assignments (
        study_instance_uid VARCHAR(128) PRIMARY KEY,
        radiologist_id INT,
        assigned_by VARCHAR(100),
        assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX (radiologist_id)
      )
    `);
}

async function ensurePatientTableSchema(db) {
    const query = db && typeof db.query === 'function' ? db.query.bind(db) : pool.query.bind(pool);
    try {
        await query('ALTER TABLE patients ADD COLUMN IF NOT EXISTS no_rm VARCHAR(255) NULL');
    } catch (err) {}
    try {
        await query('ALTER TABLE patients ADD COLUMN IF NOT EXISTS nama_pasien VARCHAR(255) NULL');
    } catch (err) {}
    try {
        await query('ALTER TABLE patients ADD COLUMN IF NOT EXISTS tanggal_lahir DATE NULL');
    } catch (err) {}
    try {
        await query('ALTER TABLE patients ADD COLUMN IF NOT EXISTS kelamin VARCHAR(1) NULL');
    } catch (err) {}
    try {
        await query('ALTER TABLE patients ADD COLUMN IF NOT EXISTS alamat VARCHAR(150) NULL');
    } catch (err) {}
    try {
        await query('ALTER TABLE patients ADD COLUMN IF NOT EXISTS kecamatan VARCHAR(150) NULL');
    } catch (err) {}
    try {
        await query('ALTER TABLE patients ADD COLUMN IF NOT EXISTS kabupaten VARCHAR(150) NULL');
    } catch (err) {}
    try {
        await query('ALTER TABLE patients ADD COLUMN IF NOT EXISTS provinsi VARCHAR(150) NULL');
    } catch (err) {}
    try {
        await query('ALTER TABLE patients ADD COLUMN IF NOT EXISTS kode_pos VARCHAR(7) NULL');
    } catch (err) {}
    try {
        await query('ALTER TABLE patients ADD COLUMN IF NOT EXISTS no_hp VARCHAR(20) NULL');
    } catch (err) {}
    try {
        await query(
            'ALTER TABLE patients ADD COLUMN IF NOT EXISTS waktu_update_pasien DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
        );
    } catch (err) {}
    try {
        await query('ALTER TABLE patients ADD COLUMN IF NOT EXISTS update_simrs VARCHAR(1) NOT NULL DEFAULT "N"');
    } catch (err) {}

    // Backfill from legacy columns when present.
    try {
        await query(
            `
            UPDATE patients
            SET no_rm = COALESCE(NULLIF(no_rm, ''), patient_id)
            WHERE (no_rm IS NULL OR no_rm = '') AND patient_id IS NOT NULL
            `
        );
    } catch (err) {}
    try {
        await query(
            `
            UPDATE patients
            SET nama_pasien = COALESCE(NULLIF(nama_pasien, ''), patient_name)
            WHERE (nama_pasien IS NULL OR nama_pasien = '') AND patient_name IS NOT NULL
            `
        );
    } catch (err) {}
    try {
        await query(
            `
            UPDATE patients
            SET tanggal_lahir = COALESCE(tanggal_lahir, dob)
            WHERE tanggal_lahir IS NULL AND dob IS NOT NULL
            `
        );
    } catch (err) {}
    try {
        await query(
            `
            UPDATE patients
            SET kelamin = COALESCE(NULLIF(kelamin, ''), sex)
            WHERE (kelamin IS NULL OR kelamin = '') AND sex IS NOT NULL
            `
        );
    } catch (err) {}
    try {
        await query(
            `
            UPDATE patients
            SET alamat = COALESCE(NULLIF(alamat, ''), address)
            WHERE (alamat IS NULL OR alamat = '') AND address IS NOT NULL
            `
        );
    } catch (err) {}
    try {
        await query('UPDATE patients SET kelamin = "O" WHERE kelamin IS NULL OR kelamin = ""');
    } catch (err) {}
    try {
        await query('UPDATE patients SET update_simrs = "N" WHERE update_simrs IS NULL OR update_simrs = ""');
    } catch (err) {}
}

// Schema reconciliation (CREATE TABLE IF NOT EXISTS + ~58 ALTER TABLE + index
// creation) is ~80 extra round trips. It used to run on EVERY worklist request,
// which cost ~210 ms per request on the same database where the actual data
// query takes 2 ms. The schema cannot change while the process is running, so
// run it once and memoise. A failed attempt is not cached, so a transient
// database outage still recovers on the next request.
let mwlTablesReady = null;

async function ensureMwlTables() {
    if (mwlTablesReady) return mwlTablesReady;
    if (!mwlTablesEnsureInFlight) {
        mwlTablesEnsureInFlight = ensureMwlTablesUncached()
            .then(() => { mwlTablesReady = true; })
            .catch((error) => {
                console.warn('[mwl] schema ensure failed, will retry:', error.message);
            })
            .finally(() => { mwlTablesEnsureInFlight = null; });
    }
    return mwlTablesEnsureInFlight;
}

let mwlTablesEnsureInFlight = null;

async function ensureMwlTablesUncached() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS patients (
        id INT AUTO_INCREMENT PRIMARY KEY,
        no_rm VARCHAR(255) NOT NULL UNIQUE,
        nama_pasien VARCHAR(255) NOT NULL,
        tanggal_lahir DATE NOT NULL,
        kelamin VARCHAR(1) NOT NULL,
        alamat VARCHAR(150) NULL,
        kecamatan VARCHAR(150) NULL,
        kabupaten VARCHAR(150) NULL,
        provinsi VARCHAR(150) NULL,
        kode_pos VARCHAR(7) NULL,
        no_hp VARCHAR(20) NULL,
        waktu_update_pasien DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        update_simrs VARCHAR(1) NOT NULL DEFAULT 'N',
        INDEX idx_patients_name (nama_pasien),
        INDEX idx_patients_norm (no_rm)
      )
    `);
    await ensurePatientTableSchema(pool);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mwl_orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        patient_record_id INT NOT NULL,
        accession_number VARCHAR(64) NOT NULL UNIQUE,
        study_instance_uid VARCHAR(128) NOT NULL UNIQUE,
        study_date DATE NULL,
        study_time TIME NULL,
        modality VARCHAR(16) NOT NULL,
        cito VARCHAR(1) NULL,
        polirawat VARCHAR(15) NULL,
        kode_ruangan VARCHAR(12) NULL,
        nama_ruangan VARCHAR(50) NULL,
        procedure_code VARCHAR(64) NULL,
        procedure_desc VARCHAR(255) NOT NULL,
        kode_pemeriksaan VARCHAR(12) NULL,
        nama_pemeriksaan VARCHAR(50) NULL,
        kode_dokter VARCHAR(12) NULL,
        nama_dokter VARCHAR(255) NULL,
        kode_admin VARCHAR(12) NULL,
        nama_admin VARCHAR(255) NULL,
        kode_dokter_radiolog VARCHAR(12) NULL,
        nama_radiolog VARCHAR(255) NULL,
        kode_radiografer VARCHAR(12) NULL,
        nama_radiografer VARCHAR(100) NULL,
        radiografer_datetime_start DATETIME NULL,
        radiografer_datetime_end DATETIME NULL,
        cara_bayar VARCHAR(10) NULL,
        kode_asuransi VARCHAR(12) NULL,
        nama_asuransi VARCHAR(255) NULL,
        kode_instalasi_radiologi VARCHAR(12) NULL,
        nama_instalasi_radiologi VARCHAR(50) NULL,
        referring_physician VARCHAR(255) NULL,
        modality_station_ae VARCHAR(64) NULL,
        modality_station_room VARCHAR(150) NULL,
        status ENUM('PENDING','SENT_TO_MWL','COMPLETED','CANCELLED') NOT NULL DEFAULT 'PENDING',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_mwl_orders_status (status),
        INDEX idx_mwl_orders_patient (patient_record_id),
        INDEX idx_mwl_orders_created_at (created_at),
        INDEX idx_mwl_orders_deleted_created (deleted_at, created_at),
        CONSTRAINT fk_mwl_orders_patient FOREIGN KEY (patient_record_id) REFERENCES patients(id) ON DELETE CASCADE
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mwl_studies (
        id INT AUTO_INCREMENT PRIMARY KEY,
        procedure_code VARCHAR(64) NOT NULL,
        modality_code VARCHAR(16) NOT NULL,
        study_description VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_mwl_studies_desc_modality (study_description, modality_code),
        INDEX idx_mwl_studies_desc (study_description),
        INDEX idx_mwl_studies_proc (procedure_code)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mwl_doctors (
        id INT AUTO_INCREMENT PRIMARY KEY,
        kode_dokter VARCHAR(64) NOT NULL UNIQUE,
        nama_dokter VARCHAR(255) NOT NULL,
        role VARCHAR(16) NOT NULL,
        user_id INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_mwl_doctors_user (user_id),
        INDEX idx_mwl_doctors_role (role),
        INDEX idx_mwl_doctors_name (nama_dokter)
      )
    `);
    try {
        await pool.query(
            'ALTER TABLE mwl_doctors ADD COLUMN IF NOT EXISTS user_id INT NULL AFTER role'
        );
    } catch (err) {}
    try {
        await pool.query(
            'ALTER TABLE mwl_modalities MODIFY COLUMN ae_title_station VARCHAR(64) NULL'
        );
    } catch (err) {}
    try {
        await pool.query(
            'ALTER TABLE mwl_doctors ADD UNIQUE INDEX IF NOT EXISTS uq_mwl_doctors_user (user_id)'
        );
    } catch (err) {}
    try {
        await pool.query(
            'ALTER TABLE mwl_doctors ADD CONSTRAINT fk_mwl_doctors_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL'
        );
    } catch (err) {}
    try {
        await pool.query(
            'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS study_instance_uid VARCHAR(128) NOT NULL UNIQUE AFTER accession_number'
        );
    } catch (err) {}
    await applyMwlOrderIndonesiaSchema(pool);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mwl_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id INT NOT NULL,
        orthanc_file_name VARCHAR(255) NULL,
        transport_method VARCHAR(32) NULL,
        orthanc_status VARCHAR(32) NOT NULL DEFAULT 'SENT_TO_ORTHANC',
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        message TEXT NULL,
        sync_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_mwl_logs_order (order_id),
        INDEX idx_mwl_logs_active (is_active),
        CONSTRAINT fk_mwl_logs_order FOREIGN KEY (order_id) REFERENCES mwl_orders(id) ON DELETE CASCADE
      )
    `);
    await ensureMwlOrderIndexes();
}

// CREATE TABLE IF NOT EXISTS does nothing on an existing table, so a database
// created by an older release never receives new indexes. Add them explicitly and
// idempotently — translateSql() rewrites `ADD INDEX IF NOT EXISTS` into
// `CREATE INDEX IF NOT EXISTS`, which PostgreSQL supports.
async function ensureMwlOrderIndexes() {
    const statements = [
        'ALTER TABLE mwl_orders ADD INDEX IF NOT EXISTS idx_mwl_orders_created_at (created_at)',
        'ALTER TABLE mwl_orders ADD INDEX IF NOT EXISTS idx_mwl_orders_deleted_created (deleted_at, created_at)',
        'ALTER TABLE mwl_orders ADD INDEX IF NOT EXISTS idx_mwl_orders_updated_at (updated_at)',
        'ALTER TABLE mwl_orders ADD INDEX IF NOT EXISTS idx_mwl_logs_order_active (order_id, is_active)',
    ];
    for (const statement of statements) {
        try {
            await pool.query(statement);
        } catch (err) {
            // Never fail a worklist request because an index could not be created.
            console.warn('[mwl] index ensure skipped:', err.message);
        }
    }
}

async function applyMwlOrderIndonesiaSchema(db) {
    const query = db && typeof db.query === 'function' ? db.query.bind(db) : pool.query.bind(pool);
    const alterations = [
        'ALTER TABLE mwl_orders MODIFY COLUMN study_date DATE NULL',
        'ALTER TABLE mwl_orders MODIFY COLUMN study_time TIME NULL',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS tanggal_order DATETIME NULL AFTER patient_record_id',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS tanggal_aktivasi DATETIME NULL AFTER tanggal_order',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS no_register VARCHAR(255) NULL AFTER accession_number',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS no_rontgen VARCHAR(16) NULL AFTER no_register',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS actual_study_instance_uid VARCHAR(128) NULL AFTER study_instance_uid',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS reconcile_status VARCHAR(32) NULL AFTER actual_study_instance_uid',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS reconcile_method VARCHAR(64) NULL AFTER reconcile_status',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS reconciled_at DATETIME NULL AFTER reconcile_method',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS reconciled_by VARCHAR(100) NULL AFTER reconciled_at',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS klinis VARCHAR(255) NULL AFTER procedure_desc',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS diagnosa VARCHAR(255) NULL AFTER klinis',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS kode_pemeriksaan VARCHAR(12) NULL AFTER diagnosa',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS nama_pemeriksaan VARCHAR(50) NULL AFTER kode_pemeriksaan',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS cito VARCHAR(1) NULL AFTER modality',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS polirawat VARCHAR(15) NULL AFTER cito',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS kode_ruangan VARCHAR(12) NULL AFTER polirawat',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS nama_ruangan VARCHAR(50) NULL AFTER kode_ruangan',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS kode_dokter VARCHAR(12) NULL AFTER nama_ruangan',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS nama_dokter VARCHAR(255) NULL AFTER kode_dokter',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS kode_admin VARCHAR(12) NULL AFTER nama_dokter',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS nama_admin VARCHAR(255) NULL AFTER kode_admin',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS kode_dokter_radiolog VARCHAR(12) NULL AFTER nama_admin',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS nama_radiolog VARCHAR(255) NULL AFTER kode_dokter_radiolog',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS kode_radiografer VARCHAR(12) NULL AFTER nama_radiolog',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS nama_radiografer VARCHAR(100) NULL AFTER kode_radiografer',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS radiografer_datetime_start DATETIME NULL AFTER nama_radiografer',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS radiografer_datetime_end DATETIME NULL AFTER radiografer_datetime_start',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS cara_bayar VARCHAR(10) NULL AFTER nama_radiografer',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS kode_asuransi VARCHAR(12) NULL AFTER cara_bayar',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS nama_asuransi VARCHAR(255) NULL AFTER kode_asuransi',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS kode_instalasi_radiologi VARCHAR(12) NULL AFTER nama_asuransi',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS nama_instalasi_radiologi VARCHAR(50) NULL AFTER kode_instalasi_radiologi',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS waktu_update_orderin DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER nama_instalasi_radiologi',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS update_ris VARCHAR(1) NOT NULL DEFAULT "N" AFTER waktu_update_orderin',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS assigned_staff_json JSON NULL AFTER modality_station_ae',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS modality_station_room VARCHAR(150) NULL AFTER modality_station_ae',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS deleted_at DATETIME NULL',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS deleted_by VARCHAR(100) NULL',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS deleted_reason VARCHAR(255) NULL',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS restored_at DATETIME NULL',
        'ALTER TABLE mwl_orders ADD COLUMN IF NOT EXISTS restored_by VARCHAR(100) NULL',
        'ALTER TABLE mwl_orders ADD UNIQUE INDEX IF NOT EXISTS uq_mwl_orders_no_rontgen (no_rontgen)',
        'ALTER TABLE mwl_orders ADD INDEX IF NOT EXISTS idx_mwl_orders_status_created (status, created_at)',
        'ALTER TABLE mwl_orders ADD INDEX IF NOT EXISTS idx_mwl_orders_status_updated (status, updated_at)',
        'ALTER TABLE mwl_orders ADD INDEX IF NOT EXISTS idx_mwl_orders_accession (accession_number)',
        'ALTER TABLE mwl_orders ADD INDEX IF NOT EXISTS idx_mwl_orders_no_register (no_register)',
        'ALTER TABLE mwl_orders ADD INDEX IF NOT EXISTS idx_mwl_orders_actual_study_uid (actual_study_instance_uid)',
        'ALTER TABLE mwl_orders ADD INDEX IF NOT EXISTS idx_mwl_orders_reconcile_status (reconcile_status)',
        'ALTER TABLE mwl_orders ADD INDEX IF NOT EXISTS idx_mwl_orders_deleted_at (deleted_at)',
        'ALTER TABLE mwl_orders ADD INDEX IF NOT EXISTS idx_mwl_orders_deleted_created (deleted_at, created_at)'
    ];
    const droppedColumns = [
        'study_master_id',
        'referring_doctor_id',
        'radiologist_doctor_id',
        'modality_station_id',
        'technologist_id',
    ];
    const preDropAlterations = [
        'ALTER TABLE mwl_orders DROP FOREIGN KEY fk_mwl_orders_study_master',
        'ALTER TABLE mwl_orders DROP FOREIGN KEY fk_mwl_orders_modality_station',
        'ALTER TABLE mwl_orders DROP INDEX idx_mwl_orders_study_master',
        'ALTER TABLE mwl_orders DROP INDEX idx_mwl_orders_referring_doctor',
        'ALTER TABLE mwl_orders DROP INDEX idx_mwl_orders_radiologist_doctor',
        'ALTER TABLE mwl_orders DROP INDEX idx_mwl_orders_modality_station',
    ];
    for (const sql of preDropAlterations) {
        try {
            await query(sql);
        } catch (err) {}
    }
    for (const sql of alterations) {
        try {
            await query(sql);
        } catch (err) {}
    }
    for (const columnName of droppedColumns) {
        try {
            await query(`ALTER TABLE mwl_orders DROP COLUMN ${columnName}`);
        } catch (err) {}
    }
}

async function ensurePatientContactTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS patient_contacts (
        patient_id VARCHAR(128) PRIMARY KEY,
        patient_phone VARCHAR(32) NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
}

async function ensurePublicShareTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public_share_links (
        token VARCHAR(64) PRIMARY KEY,
        study_instance_uid VARCHAR(128) NOT NULL,
        created_by VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NULL DEFAULT NULL,
        patient_phone VARCHAR(32) NULL,
        template_id INT NULL,
        INDEX (study_instance_uid)
      )
    `);
    try {
        await pool.query(
            'ALTER TABLE public_share_links ADD COLUMN IF NOT EXISTS patient_phone VARCHAR(32) NULL'
        );
    } catch (err) {}
    try {
        await pool.query(
            'ALTER TABLE public_share_links ADD COLUMN IF NOT EXISTS template_id INT NULL'
        );
    } catch (err) {}
}

async function ensureOrderOutTable() {
    await ensurePublicShareTable();
    await ensureViewerAccessTokenTable();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS order_out (
        id INT AUTO_INCREMENT PRIMARY KEY,
        no_rm VARCHAR(255),
        no_rontgen VARCHAR(16) NOT NULL UNIQUE,
        no_register VARCHAR(255),
        kode_user_admin VARCHAR(32),
        nama_user_admin VARCHAR(100),
        admin_datetime_start DATETIME NULL,
        admin_datetime_end DATETIME NULL,
        kode_radiografer VARCHAR(32),
        nama_radiografer VARCHAR(100),
        radiografer_datetime_start DATETIME NULL,
        radiografer_datetime_end DATETIME NULL,
        kode_radiolog VARCHAR(32),
        nama_radiolog VARCHAR(100),
        radiolog_datetime_start DATETIME NULL,
        radiolog_datetime_end DATETIME NULL,
        klinis VARCHAR(15),
        cito VARCHAR(1),
        kritis VARCHAR(1) DEFAULT '0',
        expertise_text_finding TEXT NULL,
        expertise_text_conclusion TEXT NULL,
        expertise_html_finding TEXT NULL,
        expertise_html_conclusion TEXT NULL,
        urllink1 VARCHAR(255) NULL,
        urllink2 VARCHAR(255) NULL,
        urllink3 VARCHAR(255) NULL,
        urllink4 VARCHAR(255) NULL,
        urllink5 VARCHAR(255) NULL,
        urllink6 VARCHAR(255) NULL,
        alasan VARCHAR(255) NULL,
        waktu_update_orderout DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        update_ris VARCHAR(1) NOT NULL DEFAULT 'N',
        INDEX idx_order_out_norm (no_rm),
        INDEX idx_order_out_register (no_register)
      )
    `);
    try {
        await pool.query("ALTER TABLE order_out ADD COLUMN IF NOT EXISTS kritis VARCHAR(1) NOT NULL DEFAULT '0'");
    } catch (err) {}
}

async function ensureOrderInTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS order_in (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tanggal_order DATETIME NULL,
        tanggal_aktivasi DATETIME NULL,
        no_rm VARCHAR(255),
        nama_pasien VARCHAR(255),
        tanggal_lahir DATE NULL,
        kelamin VARCHAR(1) NULL,
        alamat VARCHAR(150) NULL,
        kecamatan VARCHAR(150) NULL,
        kabupaten VARCHAR(150) NULL,
        provinsi VARCHAR(150) NULL,
        kode_pos VARCHAR(7) NULL,
        no_hp VARCHAR(20) NULL,
        no_register VARCHAR(255) NULL,
        no_rontgen VARCHAR(16) NOT NULL UNIQUE,
        klinis VARCHAR(255) NULL,
        diagnosa VARCHAR(255) NULL,
        kode_pemeriksaan VARCHAR(12) NULL,
        nama_pemeriksaan VARCHAR(50) NULL,
        modality VARCHAR(5) NULL,
        cito VARCHAR(1) NULL,
        polirawat VARCHAR(15) NULL,
        kode_ruangan VARCHAR(12) NULL,
        nama_ruangan VARCHAR(50) NULL,
        kode_dokter VARCHAR(12) NULL,
        nama_dokter VARCHAR(255) NULL,
        kode_admin VARCHAR(12) NULL,
        nama_admin VARCHAR(255) NULL,
        kode_dokter_radiolog VARCHAR(12) NULL,
        nama_radiolog VARCHAR(255) NULL,
        kode_radiografer VARCHAR(12) NULL,
        nama_radiografer VARCHAR(100) NULL,
        radiografer_datetime_start DATETIME NULL,
        radiografer_datetime_end DATETIME NULL,
        cara_bayar VARCHAR(10) NULL,
        kode_asuransi VARCHAR(12) NULL,
        nama_asuransi VARCHAR(255) NULL,
        kode_instalasi_radiologi VARCHAR(12) NULL,
        nama_instalasi_radiologi VARCHAR(50) NULL,
        alasan VARCHAR(255) NULL,
        waktu_update_orderin DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        update_ris VARCHAR(1) NOT NULL DEFAULT 'N',
        sync_status VARCHAR(1) NOT NULL DEFAULT 'N',
        sync_message VARCHAR(500) NULL,
        processing_at DATETIME NULL,
        synced_at DATETIME NULL,
        INDEX idx_order_in_norm (no_rm),
        INDEX idx_order_in_register (no_register),
        INDEX idx_order_in_order_date (tanggal_order)
      )
    `);
    for (const statement of [
        "ALTER TABLE order_in ADD COLUMN IF NOT EXISTS sync_status VARCHAR(1) NOT NULL DEFAULT 'N' AFTER update_ris",
        "ALTER TABLE order_in ADD COLUMN IF NOT EXISTS sync_message VARCHAR(500) NULL AFTER sync_status",
        "ALTER TABLE order_in ADD COLUMN IF NOT EXISTS processing_at DATETIME NULL AFTER sync_message",
        "ALTER TABLE order_in ADD COLUMN IF NOT EXISTS synced_at DATETIME NULL AFTER processing_at",
        "ALTER TABLE order_in ADD INDEX IF NOT EXISTS idx_order_in_sync_status (sync_status, waktu_update_orderin)",
    ]) {
        try { await pool.query(statement); } catch (err) {}
    }
    try {
        await pool.query('ALTER TABLE order_in DROP INDEX idx_order_in_accession');
    } catch (err) {}
    try {
        await pool.query('ALTER TABLE order_in DROP COLUMN accession_number');
    } catch (err) {}
    try {
        await pool.query('ALTER TABLE order_in DROP COLUMN study_date');
    } catch (err) {}
    try {
        await pool.query('ALTER TABLE order_in DROP COLUMN study_time');
    } catch (err) {}
    try {
        await pool.query('ALTER TABLE order_in DROP COLUMN radiografer_datetime_start');
    } catch (err) {}
    try {
        await pool.query('ALTER TABLE order_in DROP COLUMN radiografer_datetime_end');
    } catch (err) {}
}

const toNullableDateTime = value => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

const decodeHtmlEntities = value =>
    String(value || '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'");

const toPlainTextReport = value => {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const decodedRaw = decodeHtmlEntities(raw);
    const withBreaks = decodedRaw
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>\s*<p>/gi, '\n\n')
        .replace(/<\/div>\s*<div>/gi, '\n\n')
        .replace(/<\/li>\s*<li>/gi, '\n');
    const stripped = withBreaks.replace(/<[^>]+>/g, '');
    const decoded = decodeHtmlEntities(stripped)
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return decoded || null;
};

const toHtmlParagraphs = value => {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const decodedRaw = decodeHtmlEntities(raw);
    if (/<[a-z][\s\S]*>/i.test(decodedRaw)) {
        return decodedRaw;
    }
    const paragraphs = decodedRaw
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split(/\n{2,}/)
        .map(part => part.trim())
        .filter(Boolean)
        .map(part => {
            const escaped = part
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
            return `<p>${escaped.replace(/\n/g, '<br />')}</p>`;
        });
    return paragraphs.join('\n') || null;
};

function resolveDicomwebPacsRoot() {
    const appSettings = readAppLinkSettings();
    return String(
        process.env.DICOMWEB_PACS_ROOT ||
        DICOMWEB_PACS_ROOT
    ).replace(/\/+$/, '');
}

async function createDicomSrReportForStudy({
    studyInstanceUid,
    patientId,
    clinicalInfo,
    findings,
    conclusion,
    radiologistName,
    radiologistUsername,
}) {
    if (!studyInstanceUid) {
        return null;
    }
    const baseUrl = resolveDicomwebPacsRoot();
    const response = await fetch(`${baseUrl}/api/reports/sr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            studyInstanceUid,
            patientId,
            clinicalInfo: toPlainTextReport(clinicalInfo),
            findings: toPlainTextReport(findings),
            conclusion: toPlainTextReport(conclusion),
            radiologistName,
            radiologistUsername,
        }),
    });
    const text = await response.text();
    let body = null;
    try {
        body = text ? JSON.parse(text) : null;
    } catch (err) {
        body = text;
    }
    if (!response.ok) {
        const error = new Error(
            body?.error || `Failed to create DICOM SR report (${response.status})`
        );
        error.details = body;
        throw error;
    }
    return body;
}

async function getOrCreatePublicShareLinkForStudy(studyInstanceUid, createdBy) {
    await ensurePublicShareTable();
    const [rows] = await pool.query(
        `
        SELECT token, study_instance_uid, created_by, created_at, expires_at, patient_phone
        FROM public_share_links
        WHERE study_instance_uid = ?
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [studyInstanceUid]
    );
    if (rows.length) {
        return rows[0];
    }
    let token = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const candidate = crypto.randomBytes(16).toString('hex');
        try {
            await pool.query(
                `
                INSERT INTO public_share_links (token, study_instance_uid, created_by, expires_at, patient_phone)
                VALUES (?, ?, ?, NULL, NULL)
                `,
                [candidate, studyInstanceUid, createdBy || 'order-out']
            );
            token = candidate;
            break;
        } catch (err) {
            if (err.code !== 'ER_DUP_ENTRY' || attempt === 2) throw err;
        }
    }
    return token ? { token, study_instance_uid: studyInstanceUid } : null;
}

async function readPublicShare(token) {
    await ensurePublicShareTable();
    const [rows] = await pool.query(
        'SELECT token, study_instance_uid, created_by, created_at, expires_at, patient_phone, template_id FROM public_share_links WHERE token = ?',
        [token]
    );
    return rows[0] || null;
}

async function readExpertiseSettings() {
    await ensureExpertiseTables();
    const [rows] = await pool.query(
        'SELECT header_image, template_html, qr_position FROM expertise_settings WHERE id = 1'
    );
    if (!rows.length) {
        await pool.query('INSERT INTO expertise_settings (id, header_image, template_html, qr_position) VALUES (1, NULL, NULL, NULL)');
        return { headerImage: null, templateHtml: null, qrPosition: null };
    }
    return {
        headerImage: rows[0].header_image || null,
        templateHtml: rows[0].template_html || null,
        qrPosition: rows[0].qr_position || null,
    };
}

async function writeExpertiseSettings(payload) {
    await ensureExpertiseTables();
    const headerImage =
        payload && typeof payload.headerImage === 'string' ? payload.headerImage : null;
    const templateHtml =
        payload && typeof payload.templateHtml === 'string' ? payload.templateHtml : null;
    const qrPositionRaw =
        payload && typeof payload.qrPosition === 'string' ? payload.qrPosition : null;
    const qrPosition =
        qrPositionRaw === 'left' || qrPositionRaw === 'center' || qrPositionRaw === 'right'
            ? qrPositionRaw
            : null;
    await pool.query(
        'INSERT INTO expertise_settings (id, header_image, template_html, qr_position) VALUES (1, ?, ?, ?) ON DUPLICATE KEY UPDATE header_image = VALUES(header_image), template_html = VALUES(template_html), qr_position = VALUES(qr_position)',
        [headerImage, templateHtml, qrPosition]
    );
    return { headerImage, templateHtml, qrPosition };
}

async function readRadiologistSignature(userId) {
    await ensureExpertiseTables();
    const [rows] = await pool.query(
        'SELECT signature_image FROM radiologist_signatures WHERE user_id = ?',
        [userId]
    );
    if (!rows.length) {
        return { signatureImage: null };
    }
    return { signatureImage: rows[0].signature_image || null };
}

const mapExpertiseTemplateRow = row => ({
    id: row.id,
    name: row.name || '',
    headerImage: row.header_image || null,
    templateHtml: row.template_html || null,
    isActive: row.is_active !== 0,
    isDefault: row.is_default === 1,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
});

async function readExpertisePrintTemplates(options = {}) {
    await ensureExpertiseTables();
    const onlyActive = Boolean(options.onlyActive);
    const [rows] = await pool.query(
        `
        SELECT id, name, header_image, template_html, is_active, is_default, created_at, updated_at
        FROM expertise_print_templates
        ${onlyActive ? 'WHERE is_active = 1' : ''}
        ORDER BY is_default DESC, name ASC, id ASC
        `
    );
    return rows.map(mapExpertiseTemplateRow);
}

async function readExpertisePrintTemplate(templateId) {
    await ensureExpertiseTables();
    const id = Number(templateId);
    if (!Number.isFinite(id) || id <= 0) return null;
    const [rows] = await pool.query(
        `
        SELECT id, name, header_image, template_html, is_active, is_default, created_at, updated_at
        FROM expertise_print_templates
        WHERE id = ?
        LIMIT 1
        `,
        [id]
    );
    return rows[0] ? mapExpertiseTemplateRow(rows[0]) : null;
}

async function readDefaultExpertisePrintTemplate() {
    await ensureExpertiseTables();
    const [rows] = await pool.query(
        `
        SELECT id, name, header_image, template_html, is_active, is_default, created_at, updated_at
        FROM expertise_print_templates
        WHERE is_active = 1
        ORDER BY is_default DESC, id ASC
        LIMIT 1
        `
    );
    return rows[0] ? mapExpertiseTemplateRow(rows[0]) : null;
}

async function normalizeExpertiseTemplateId(templateId) {
    const id = Number(templateId);
    if (!Number.isFinite(id) || id <= 0) return null;
    const template = await readExpertisePrintTemplate(id);
    return template?.isActive ? template.id : null;
}

async function writeRadiologistSignature(userId, signatureImage) {
    await ensureExpertiseTables();
    const image = typeof signatureImage === 'string' ? signatureImage : null;
    await pool.query(
        'INSERT INTO radiologist_signatures (user_id, signature_image) VALUES (?, ?) ON DUPLICATE KEY UPDATE signature_image = VALUES(signature_image)',
        [userId, image]
    );
    return { signatureImage: image };
}

async function readUiSettings() {
    await ensureUiSettingsTable();
    let rows;
    try {
        const [fullRows] = await pool.query(
            'SELECT viewer_url, viewer_path, auto_refresh, worklist_series_preview_enabled, radiologist_competition_enabled, viewer_access_link_days, patient_portal_max_images_per_series, radiologist_whatsapp_auto, radiologist_whatsapp_scope, radiologist_whatsapp_template, viewer_config FROM ui_settings WHERE id = 1'
        );
        rows = fullRows;
    } catch (err) {
        const [legacyRows] = await pool.query(
            'SELECT viewer_url, viewer_path, auto_refresh FROM ui_settings WHERE id = 1'
        );
        rows = legacyRows;
    }
    if (!rows.length) {
        const normalized = normalizeUiSettings(DEFAULT_UI_SETTINGS);
        await pool.query(
            'INSERT INTO ui_settings (id, viewer_url, viewer_path, auto_refresh, worklist_series_preview_enabled, radiologist_competition_enabled, viewer_access_link_days, patient_portal_max_images_per_series, radiologist_whatsapp_auto, radiologist_whatsapp_scope, radiologist_whatsapp_template, viewer_config) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                normalized.viewerUrl,
                normalized.viewerPath,
                normalized.autoRefresh ? 1 : 0,
                normalized.worklistSeriesPreviewEnabled ? 1 : 0,
                normalized.radiologistCompetitionEnabled ? 1 : 0,
                normalized.viewerAccessLinkDays,
                normalized.patientPortalMaxImagesPerSeries,
                normalized.radiologistWhatsappNotification.mode === 'auto' ? 1 : 0,
                normalized.radiologistWhatsappNotification.scope,
                normalized.radiologistWhatsappNotification.messageTemplate,
                JSON.stringify(normalized.viewers || []),
            ]
        );
        return normalized;
    }
    const row = rows[0];
    let parsedViewers = undefined;
    if (row.viewer_config) {
        try {
            const value = parseJsonValue(row.viewer_config, null);
            if (Array.isArray(value)) {
                parsedViewers = value;
            }
        } catch (e) {}
    }
    return normalizeUiSettings({
        viewerUrl: row.viewer_url,
        viewerPath: row.viewer_path,
        autoRefresh: Boolean(row.auto_refresh),
        worklistSeriesPreviewEnabled:
            row.worklist_series_preview_enabled == null
                ? DEFAULT_UI_SETTINGS.worklistSeriesPreviewEnabled
                : Boolean(row.worklist_series_preview_enabled),
        radiologistCompetitionEnabled: Boolean(row.radiologist_competition_enabled),
        viewerAccessLinkDays: Number.isFinite(Number(row.viewer_access_link_days))
            ? Number(row.viewer_access_link_days)
            : DEFAULT_UI_SETTINGS.viewerAccessLinkDays,
        patientPortalMaxImagesPerSeries: Number.isFinite(Number(row.patient_portal_max_images_per_series))
            ? Number(row.patient_portal_max_images_per_series)
            : DEFAULT_UI_SETTINGS.patientPortalMaxImagesPerSeries,
        radiologistWhatsappNotification: {
            mode: row.radiologist_whatsapp_auto ? 'auto' : 'manual',
            scope: row.radiologist_whatsapp_scope === 'cito' ? 'cito' : 'all',
            messageTemplate: row.radiologist_whatsapp_template || DEFAULT_UI_SETTINGS.radiologistWhatsappNotification.messageTemplate,
        },
        viewers: parsedViewers,
    });
}

async function writeUiSettings(payload) {
    await ensureUiSettingsTable();
    const normalized = normalizeUiSettings(payload);
    const viewerConfigJson = JSON.stringify(normalized.viewers || []);
    try {
        await pool.query(
            'INSERT INTO ui_settings (id, viewer_url, viewer_path, auto_refresh, worklist_series_preview_enabled, radiologist_competition_enabled, viewer_access_link_days, patient_portal_max_images_per_series, radiologist_whatsapp_auto, radiologist_whatsapp_scope, radiologist_whatsapp_template, viewer_config) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE viewer_url = VALUES(viewer_url), viewer_path = VALUES(viewer_path), auto_refresh = VALUES(auto_refresh), worklist_series_preview_enabled = VALUES(worklist_series_preview_enabled), radiologist_competition_enabled = VALUES(radiologist_competition_enabled), viewer_access_link_days = VALUES(viewer_access_link_days), patient_portal_max_images_per_series = VALUES(patient_portal_max_images_per_series), radiologist_whatsapp_auto = VALUES(radiologist_whatsapp_auto), radiologist_whatsapp_scope = VALUES(radiologist_whatsapp_scope), radiologist_whatsapp_template = VALUES(radiologist_whatsapp_template), viewer_config = VALUES(viewer_config)',
            [
                normalized.viewerUrl,
                normalized.viewerPath,
                normalized.autoRefresh ? 1 : 0,
                normalized.worklistSeriesPreviewEnabled ? 1 : 0,
                normalized.radiologistCompetitionEnabled ? 1 : 0,
                normalized.viewerAccessLinkDays,
                normalized.patientPortalMaxImagesPerSeries,
                normalized.radiologistWhatsappNotification.mode === 'auto' ? 1 : 0,
                normalized.radiologistWhatsappNotification.scope,
                normalized.radiologistWhatsappNotification.messageTemplate,
                viewerConfigJson,
            ]
        );
    } catch (err) {
        await pool.query(
            'INSERT INTO ui_settings (id, viewer_url, viewer_path, auto_refresh, radiologist_competition_enabled, viewer_access_link_days, patient_portal_max_images_per_series, radiologist_whatsapp_auto, radiologist_whatsapp_scope, radiologist_whatsapp_template) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE viewer_url = VALUES(viewer_url), viewer_path = VALUES(viewer_path), auto_refresh = VALUES(auto_refresh), radiologist_competition_enabled = VALUES(radiologist_competition_enabled), viewer_access_link_days = VALUES(viewer_access_link_days), patient_portal_max_images_per_series = VALUES(patient_portal_max_images_per_series), radiologist_whatsapp_auto = VALUES(radiologist_whatsapp_auto), radiologist_whatsapp_scope = VALUES(radiologist_whatsapp_scope), radiologist_whatsapp_template = VALUES(radiologist_whatsapp_template)',
            [
                normalized.viewerUrl,
                normalized.viewerPath,
                normalized.autoRefresh ? 1 : 0,
                normalized.radiologistCompetitionEnabled ? 1 : 0,
                normalized.viewerAccessLinkDays,
                normalized.patientPortalMaxImagesPerSeries,
                normalized.radiologistWhatsappNotification.mode === 'auto' ? 1 : 0,
                normalized.radiologistWhatsappNotification.scope,
                normalized.radiologistWhatsappNotification.messageTemplate,
            ]
        );
    }
    return normalized;
}

const applyTextTemplate = (template, replacements) =>
    String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) =>
        Object.prototype.hasOwnProperty.call(replacements, key) ? String(replacements[key] ?? '') : ''
    );

async function sendAutoRadiologistWhatsappForOrder(orderId, req = null) {
    await ensureUiSettingsTable();
    const settings = await readUiSettings();
    if (settings.radiologistWhatsappNotification?.mode !== 'auto') return null;
    const numericOrderId = Number(orderId);
    if (!Number.isFinite(numericOrderId) || numericOrderId <= 0) return null;
    const [sentRows] = await pool.query('SELECT id FROM radiologist_whatsapp_notifications WHERE order_id = ? LIMIT 1', [numericOrderId]);
    if (sentRows.length) return { skipped: true, reason: 'already_sent' };
    const [rows] = await pool.query(
        `
        SELECT o.id, o.study_instance_uid, o.actual_study_instance_uid, o.accession_number, o.procedure_desc, o.cito,
               p.no_rm, p.nama_pasien,
               drad.kode_dokter AS radiologist_doctor_code,
               drad.nama_dokter AS radiologist_doctor_name,
               u.phone_number AS radiologist_phone
        FROM mwl_orders o
        LEFT JOIN patients p ON p.id = o.patient_record_id
        LEFT JOIN mwl_doctors drad ON drad.kode_dokter = o.kode_dokter_radiolog
        LEFT JOIN users u ON u.id = drad.user_id
        WHERE o.id = ?
        LIMIT 1
        `,
        [numericOrderId]
    );
    const order = rows[0];
    if (!order) return null;
    if (settings.radiologistWhatsappNotification?.scope === 'cito' && normalizeCito(order.cito) !== '1') {
        return { skipped: true, reason: 'not_cito' };
    }
    const number = normalizeWhatsappNumber(order.radiologist_phone, readAppLinkSettings().whatsapp?.phoneCountryCode);
    if (!number) {
        await writeAuditLog(req, {
            eventType: 'radiologist_whatsapp_auto_notify',
            outcome: 'failure',
            studyInstanceUid: order.actual_study_instance_uid || order.study_instance_uid || null,
            targetType: 'whatsapp_radiologist',
            targetId: String(numericOrderId),
            details: {
                status: 'failed',
                reason: 'missing_radiologist_phone',
                accession_number: order.accession_number || null,
                radiologist_doctor_code: order.radiologist_doctor_code || null,
                radiologist_name: order.radiologist_doctor_name || null,
            },
        });
        return { skipped: true, reason: 'missing_radiologist_phone' };
    }
    const studyUid = order.actual_study_instance_uid || order.study_instance_uid || '';
    const baseUrl = String(readAppLinkSettings().publicBaseUrl || '').replace(/\/+$/, '') || `${req?.protocol || 'http'}://${req?.get?.('host') || 'localhost:8080'}`;
    const reportingLink = studyUid ? `${baseUrl}/reporting/report/${encodeURIComponent(studyUid)}` : '';
    const message = applyTextTemplate(settings.radiologistWhatsappNotification.messageTemplate, {
        radiologist_name: order.radiologist_doctor_name || 'Physician',
        patient_name: order.nama_pasien || '-',
        patient_id: order.no_rm || '-',
        accession_number: order.accession_number || '-',
        study_description: order.procedure_desc || '-',
        modality: '',
        priority: normalizeCito(order.cito) === '1' ? 'CITO' : 'Routine',
        reporting_link: reportingLink,
        study_instance_uid: studyUid,
    });
    let result = null;
    let status = 'sent';
    let errorMessage = null;
    try {
        result = await sendWhatsappMessageViaConfiguredProvider({ number, message });
        status = result?.sent ? 'sent' : 'fallback';
    } catch (err) {
        status = 'failed';
        errorMessage = err.message || 'Failed to send WhatsApp';
    }
    await pool.query(
        `
        INSERT INTO radiologist_whatsapp_notifications
          (order_id, study_instance_uid, accession_number, radiologist_doctor_code, phone_number, provider, status, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE status = VALUES(status), error_message = VALUES(error_message)
        `,
        [numericOrderId, studyUid || null, order.accession_number || null, order.radiologist_doctor_code || null, number, result?.provider || null, status, errorMessage]
    );
    await writeAuditLog(req, {
        eventType: 'radiologist_whatsapp_auto_notify',
        outcome: status === 'failed' ? 'failure' : 'success',
        studyInstanceUid: studyUid || null,
        targetType: 'whatsapp_radiologist',
        targetId: number,
        details: {
            status,
            error: errorMessage,
            accession_number: order.accession_number || null,
            order_id: numericOrderId,
            provider: result?.provider || null,
            sent: result?.sent ?? null,
            fallback_url: result?.fallbackUrl || null,
            radiologist_doctor_code: order.radiologist_doctor_code || null,
            radiologist_name: order.radiologist_doctor_name || null,
        },
    });
    return { status, result, error: errorMessage };
}

// === DICOM Nodes (CRUD) ===

app.get('/api/dicom/nodes', requirePermission('view_settings'), async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT id, name, aet, host, port, description, enabled, created_at, updated_at FROM dicom_nodes ORDER BY name ASC'
        );
        const nodes = rows.map(row => ({
            id: row.id,
            name: row.name,
            aet: row.aet,
            host: row.host,
            port: row.port,
            description: row.description,
            enabled: row.enabled === 1,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        }));
        res.json(nodes);
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to load DICOM nodes' });
    }
});

app.post('/api/dicom/nodes', requirePermission('edit_settings'), async (req, res) => {
    const { name, aet, host, port, description, enabled } = req.body || {};
    if (!name || !aet || !host || port === undefined || port === null) {
        res.status(400).json({ error: 'name, aet, host, and port are required' });
        return;
    }
    const parsedPort = Number(port);
    if (!Number.isFinite(parsedPort) || parsedPort <= 0) {
        res.status(400).json({ error: 'Invalid port value' });
        return;
    }
    const enabledValue = enabled === false ? 0 : 1;
    try {
        const [result] = await pool.query(
            'INSERT INTO dicom_nodes (name, aet, host, port, description, enabled) VALUES (?, ?, ?, ?, ?, ?)',
            [name, aet, host, parsedPort, description || null, enabledValue]
        );
        res.json({
            id: result.insertId,
            name,
            aet,
            host,
            port: parsedPort,
            description: description || null,
            enabled: enabledValue === 1,
        });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to create DICOM node' });
    }
});

app.put('/api/dicom/nodes/:id', requirePermission('edit_settings'), async (req, res) => {
    const { name, aet, host, port, description, enabled } = req.body || {};
    const id = req.params.id;
    if (!name || !aet || !host || port === undefined || port === null) {
        res.status(400).json({ error: 'name, aet, host, and port are required' });
        return;
    }
    const parsedPort = Number(port);
    if (!Number.isFinite(parsedPort) || parsedPort <= 0) {
        res.status(400).json({ error: 'Invalid port value' });
        return;
    }
    const enabledValue = enabled === false ? 0 : 1;
    try {
        const [result] = await pool.query(
            'UPDATE dicom_nodes SET name = ?, aet = ?, host = ?, port = ?, description = ?, enabled = ? WHERE id = ?',
            [name, aet, host, parsedPort, description || null, enabledValue, id]
        );
        if (result.affectedRows === 0) {
            res.status(404).json({ error: 'DICOM node not found' });
            return;
        }
        res.json({
            id: Number(id),
            name,
            aet,
            host,
            port: parsedPort,
            description: description || null,
            enabled: enabledValue === 1,
        });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to update DICOM node' });
    }
});

app.delete('/api/dicom/nodes/:id', requirePermission('edit_settings'), async (req, res) => {
    const deleteReason = requireDeleteReason(req, res);
    if (!deleteReason) return;
    const id = req.params.id;
    try {
        const [nodeRows] = await pool.query('SELECT id, name, aet, host, port FROM dicom_nodes WHERE id = ?', [id]);
        const [result] = await pool.query('DELETE FROM dicom_nodes WHERE id = ?', [id]);
        if (result.affectedRows === 0) {
            res.status(404).send('DICOM node not found');
            return;
        }
        await writeAuditLog(req, {
            eventType: 'delete_dicom_node',
            outcome: 'success',
            targetType: 'dicom_node',
            targetId: String(id),
            details: { deleteReason, node: nodeRows[0] || null },
        });
        res.json({ message: 'DICOM node deleted' });
    } catch (err) {
        await writeAuditLog(req, {
            eventType: 'delete_dicom_node',
            outcome: 'failure',
            targetType: 'dicom_node',
            targetId: String(id),
            details: { deleteReason, error: err.message || 'Failed to delete DICOM node' },
        });
        res.status(500).json({ error: err.message || 'Failed to delete DICOM node' });
    }
});

app.post('/api/dicom/nodes/:id/ping', requirePermission('edit_settings'), async (req, res) => {
    const id = req.params.id;
    try {
        const [rows] = await pool.query(
            'SELECT id, name, host, port FROM dicom_nodes WHERE id = ?',
            [id]
        );
        if (!rows.length) {
            res.status(404).send('DICOM node not found');
            return;
        }
        const node = rows[0];
        const host = node.host;
        if (!host) {
            res.status(400).send('DICOM node host is empty');
            return;
        }
        const command =
            process.platform === 'win32'
                ? `ping -n 1 ${host}`
                : `ping -c 1 ${host}`;
        exec(command, { timeout: 5000 }, (err, stdout, stderr) => {
            if (err) {
                const detail = (stderr && String(stderr).trim()) || (stdout && String(stdout).trim());
                res.status(502).send(
                    detail || `Ping to ${host} failed`
                );
                return;
            }
            res.send(`Ping to ${host} succeeded`);
        });
    } catch (err) {
        res.status(500).send(err.message || 'Failed to run ping test');
    }
});

app.post('/api/dicom/nodes/:id/echo', requirePermission('edit_settings'), async (req, res) => {
    const id = req.params.id;
    try {
        const [rows] = await pool.query(
            'SELECT id, name, aet, host, port, enabled FROM dicom_nodes WHERE id = ?',
            [id]
        );
        if (!rows.length) {
            res.status(404).send('DICOM node not found');
            return;
        }
        const node = rows[0];
        if (!node.aet || !node.host || node.port === undefined || node.port === null) {
            res.status(400).send('DICOM node configuration is incomplete');
            return;
        }
        const result = await dicomwebPacs.echoNode(node);
        res.send(
            `Echo to ${node.name} (${result.target.aet} @ ${result.target.ip}:${result.target.port}) succeeded`
        );
    } catch (err) {
        res
            .status(500)
            .send(err.message || 'Failed to run echo test');
    }
});

app.post('/api/dicom/nodes/:id/query-test', requirePermission('edit_settings'), async (req, res) => {
    const id = req.params.id;
    try {
        const [rows] = await pool.query(
            'SELECT id, name, aet, host, port, enabled FROM dicom_nodes WHERE id = ?',
            [id]
        );
        if (!rows.length) {
            res.status(404).json({ error: 'DICOM node not found' });
            return;
        }
        const node = rows[0];
        if (!node.aet || !node.host || node.port === undefined || node.port === null) {
            res.status(400).json({ error: 'DICOM node configuration is incomplete' });
            return;
        }
        const result = await dicomwebPacs.queryNode(node, req.body || {});
        res.json({
            message: `C-FIND query to ${node.name} (${result.target.aet} @ ${result.target.ip}:${result.target.port}) succeeded; ${result.count} record(s) returned.`,
            count: result.count,
            source: result.source,
            target: result.target,
            records: result.records.slice(0, 25),
        });
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message || 'Failed to run C-FIND query test',
        });
    }
});

app.get('/api/dicom/settings', requirePermission('view_settings'), async (req, res) => {
    try {
        const settings = await readDicomwebServerSettings();
        res.json(settings);
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message || 'Failed to load dicomweb-pacs server configuration.',
        });
    }
});

app.get('/api/ui/settings', requireAnyPermission('view_settings', 'view_radiologist', 'view_worklist', 'view_mwl_technologist', 'view_quality_control', 'view_dose_monitor', 'view_dose_report', 'view_dose_idrl'), async (req, res) => {
    try {
        const settings = await readUiSettings();
        res.json(settings);
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message || 'Failed to load UI settings',
        });
    }
});

app.get('/api/public/facility', (req, res) => {
    try {
        const appLinkSettings = readAppLinkSettings();
        res.json({
            facility: resolvePublicFacility(appLinkSettings.facility),
            appVersion: appLinkSettings.appVersion || DEFAULT_APP_LINK_SETTINGS.appVersion,
        });
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message || 'Failed to load facility settings',
        });
    }
});

app.get(
    '/api/ui/viewers',
    requireAnyPermission('view_radiologist', 'view_worklist', 'view_quality_control', 'view_mwl_technologist'),
    async (req, res) => {
    try {
        const appLinkSettings = readAppLinkSettings();
        res.json({ viewers: (appLinkSettings.viewers || []).map(sanitizeViewerConfigForClient) });
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message || 'Failed to load viewer settings',
        });
    }
    }
);

app.post(
    '/api/viewer/velo/launch',
    requireAnyPermission('view_radiologist', 'view_worklist', 'view_quality_control', 'view_mwl_technologist'),
    async (req, res) => {
        try {
            const studyInstanceUid = normalizeNullableString(
                req.body?.StudyInstanceUID || req.body?.studyInstanceUid || req.body?.study_instance_uid,
                128
            );
            const accession = normalizeNullableString(
                req.body?.accession || req.body?.accessionNumber || req.body?.accession_number,
                128
            );
            const patientId = normalizeNullableString(
                req.body?.patientId || req.body?.patient_id || req.body?.noRm || req.body?.no_rm,
                128
            );
            const mode = normalizeNullableString(req.body?.mode, 32) || 'stack';
            const viewerId = normalizeNullableString(req.body?.viewerId || req.body?.viewer_id, 128);

            if (!studyInstanceUid && !accession) {
                return res.status(400).json({
                    error: 'A StudyInstanceUID or Accession Number is required to open the Viewer.',
                });
            }

            const appLinkSettings = readAppLinkSettings();
            if (!appLinkSettings.pacsViewerEnabled) {
                console.warn('[viewer-launch] pacsViewerEnabled is false in settings, continuing because RIS launch is hardened.');
            }
            const launchViewer = resolveRisLaunchViewer(appLinkSettings, viewerId);
            if (!launchViewer) {
                return res.status(404).json({ error: 'Viewer launch configuration not found' });
            }
            const launchBaseUrl = String(launchViewer.baseUrl || appLinkSettings.pacsViewerBaseUrl || '').trim().replace(/\/+$/, '');
            const interactiveLaunchBaseUrl = resolveViewerPublicBaseUrl(req, launchViewer, launchBaseUrl);
            const launchInternalBaseUrl = String(
                launchViewer.internalBaseUrl ||
                launchViewer.launchInternalBaseUrl ||
                launchViewer.internalUrl ||
                launchBaseUrl
            ).trim().replace(/\/+$/, '');
            const launchEndpointPath = String(
                launchViewer.launchEndpoint ||
                appLinkSettings.pacsViewerLaunchEndpoint ||
                '/api/auth/ris/launch'
            ).trim();
            if (!launchBaseUrl || !launchInternalBaseUrl || !launchEndpointPath) {
                return res.status(500).json({ error: 'Viewer URL is not configured' });
            }
            const launchSecret = resolveRisLaunchSecret(launchViewer, appLinkSettings);
            if (!launchSecret) {
                return res.status(500).json({ error: 'Viewer shared secret is not configured' });
            }
            const launchHeaderName = resolveRisLaunchHeaderName(launchViewer);

            const requestUsername = getUsernameFromRequest(req);
            const [users] = await pool.query(
                'SELECT id, username, name, usernamepacs, passwordpacs FROM users WHERE username = ? LIMIT 1',
                [requestUsername]
            );
            const currentUser = users[0];
            if (!currentUser) {
                return res.status(404).json({ error: 'The signed-in RIS user was not found.' });
            }
            const username = normalizeNullableString(currentUser.usernamepacs, 100);
            const password = decryptPacsCredential(currentUser.passwordpacs);
            if (!username || !password) {
                return res.status(409).json({
                    error: 'PACS viewer credentials are not configured for this user. Set PACS Username and PACS Password in User Management.',
                });
            }
            const externalUserId = String(currentUser.id || requestUsername || username);
            const fullName =
                normalizeNullableString(currentUser.name, 150) ||
                normalizeNullableString(currentUser.username, 100) ||
                username;
            const veloPayload = {
                user: {
                    externalUserId,
                    username,
                    fullName,
                    password,
                },
                StudyInstanceUID: studyInstanceUid || '',
                accession: accession || '',
                patientId: patientId || '',
                mode,
            };
            const launchEndpoint = resolveRisLaunchEndpointUrl(launchInternalBaseUrl, launchEndpointPath);

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            let response;
            try {
                response = await fetch(launchEndpoint.toString(), {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        [launchHeaderName]: launchSecret,
                    },
                    body: JSON.stringify(veloPayload),
                    signal: controller.signal,
                });
            } catch (err) {
                return res.status(err?.name === 'AbortError' ? 504 : 502).json({
                    error: err?.name === 'AbortError'
                        ? 'Viewer launch timed out'
                        : err.message || 'The Viewer could not be reached',
                    details: {
                        code: err.code,
                        type: err.type,
                        message: err.message,
                        endpoint: launchEndpoint.toString(),
                    },
                });
            } finally {
                clearTimeout(timeout);
            }

            const responseText = await response.text();
            let payload = null;
            try {
                payload = responseText ? JSON.parse(responseText) : null;
            } catch {
                payload = { raw: responseText };
            }

            if (!response.ok) {
                console.error('VEXAPACS launch failed:', response.status, {
                    request: {
                        StudyInstanceUID: veloPayload.StudyInstanceUID,
                        accession: veloPayload.accession,
                        patientId: veloPayload.patientId,
                        mode: veloPayload.mode,
                        username: veloPayload.user.username,
                        viewerId: launchViewer.id || viewerId || '',
                    },
                    response: payload,
                });
                return res.status(response.status).json({
                    error: payload?.error || payload?.message || 'Could not open the Viewer',
                    status: response.status,
                    details: payload,
                    request: {
                        StudyInstanceUID: veloPayload.StudyInstanceUID,
                        accession: veloPayload.accession,
                        patientId: veloPayload.patientId,
                        mode: veloPayload.mode,
                    },
                });
            }

            if (!payload?.launchUrl) {
                console.error('VEXAPACS launch missing launchUrl:', payload);
                return res.status(502).json({
                    error: 'The Viewer did not return a launchUrl',
                    details: payload,
                });
            }

            const finalLaunchUrl = shouldUseDirectInternalViewerLaunch(req)
                ? rewriteRisLaunchUrlForDev(req, payload.launchUrl, launchViewer)
                : buildGatewayViewerLaunchUrl(req, payload.launchUrl, launchViewer);

            res.json({
                launchUrl: finalLaunchUrl,
            });
        } catch (err) {
            console.error('VEXAPACS launch error:', err);
            res.status(500).json({
                error: err.code === 'ECONNREFUSED'
                    ? 'The Viewer could not be reached'
                    : err.message || 'Could not open the Viewer',
                details: {
                    code: err.code,
                    type: err.type,
                    message: err.message,
                },
            });
        }
    }
);

function escapeXmlValue(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function buildXmlRpcMember(name, value) {
    return `
          <member>
            <name>${escapeXmlValue(name)}</name>
            <value><string>${escapeXmlValue(value)}</string></value>
          </member>`;
}

function buildInobitecRpcXml(viewer, studyInstanceUid) {
    const command = String(viewer.command || 'DownloadAndOpenStudy');
    const commandType = String(viewer.commandType || 'WADO-RS');
    const port = commandType === 'WADO-RS' ? viewer.wadoPort || '5001' : viewer.pacsPort;
    const members = [buildXmlRpcMember('StudyInstanceUID', studyInstanceUid)];

    if (command === 'DownloadAndOpenStudy') {
        if (viewer.pacsAet) members.push(buildXmlRpcMember('AET', viewer.pacsAet));
        if (viewer.pacsIp) members.push(buildXmlRpcMember('IP', viewer.pacsIp));
        if (port) members.push(buildXmlRpcMember('port', port));
        if (commandType === 'WADO-RS') {
            members.push(buildXmlRpcMember('WadoServiceRootPath', viewer.wadoServiceRootPath || '/rs'));
            members.push(buildXmlRpcMember('IsWadoSecured', viewer.isWadoSecured ? 'true' : 'false'));
            members.push(buildXmlRpcMember('WadoPort', viewer.wadoPort || viewer.pacsPort || '5001'));
            members.push(buildXmlRpcMember('WadoAuthLogin', viewer.wadoAuthLogin || ''));
            members.push(buildXmlRpcMember('WadoAuthPassword', viewer.wadoAuthPassword || ''));
        }
        members.push(buildXmlRpcMember('CommandType', commandType));
    }

    return `<?xml version="1.0" encoding="utf-8"?>
<methodCall>
  <methodName>${escapeXmlValue(command)}</methodName>
  <params>
    <param>
      <value>
        <struct>${members.join('')}
        </struct>
      </value>
    </param>
  </params>
</methodCall>`;
}

app.post('/api/viewer/inobitec-rpc', requirePermission('view_radiologist'), async (req, res) => {
    const studyInstanceUid = String(req.body?.studyInstanceUid || '').trim();
    const viewer = req.body?.viewer && typeof req.body.viewer === 'object' ? req.body.viewer : {};
    const rpcUrl = String(viewer.rpcUrl || viewer.baseUrl || 'http://127.0.0.1:9090/').trim();

    if (!studyInstanceUid) {
        res.status(400).json({ error: 'studyInstanceUid is required' });
        return;
    }

    try {
        const response = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/xml' },
            body: buildInobitecRpcXml(viewer, studyInstanceUid),
        });
        if (!response.ok) {
            res.status(502).json({ error: `Inobitec RPC failed with HTTP ${response.status}` });
            return;
        }
        res.json({ ok: true });
    } catch (err) {
        res.status(502).json({ error: err.message || 'Failed to contact Inobitec RPC service' });
    }
});

app.get('/api/viewer/window-command/:slot', (req, res) => {
    pruneViewerWindowState();
    const slot = normalizeViewerWindowSlot(req.params.slot);
    const since = Number(req.query.since || 0);
    const command = viewerWindowCommands.get(slot);

    if (!command || !Number.isFinite(since) || command.id <= since) {
        res.json({ command: null });
        return;
    }

    res.json({ command });
});

app.post('/api/viewer/window-command/:slot', (req, res) => {
    pruneViewerWindowState();
    const slot = normalizeViewerWindowSlot(req.params.slot);
    const viewerUrl = String(req.body?.viewerUrl || '').trim();
    const studyInstanceUid = String(req.body?.studyInstanceUid || '').trim();

    if (!viewerUrl || !studyInstanceUid) {
        res.status(400).json({ error: 'viewerUrl and studyInstanceUid are required' });
        return;
    }

    const command = {
        id: Date.now(),
        slot,
        viewerUrl,
        studyInstanceUid,
        createdAt: Date.now(),
    };
    viewerWindowCommands.set(slot, command);
    res.json({ ok: true, command });
});

app.get('/api/viewer/window-session/:slot', (req, res) => {
    pruneViewerWindowState();
    const slot = normalizeViewerWindowSlot(req.params.slot);
    const session = viewerWindowSessions.get(slot);
    const now = Date.now();
    res.json({
        active: Boolean(session && now - session.lastSeenAt < 5000),
        lastSeenAt: session?.lastSeenAt || null,
    });
});

app.post('/api/viewer/window-session/:slot/heartbeat', (req, res) => {
    pruneViewerWindowState();
    const slot = normalizeViewerWindowSlot(req.params.slot);
    viewerWindowSessions.set(slot, {
        slot,
        lastSeenAt: Date.now(),
        href: String(req.body?.href || ''),
    });
    res.json({ ok: true });
});

app.get('/api/expertise/settings', requirePermission('view_settings'), async (req, res) => {
    try {
        const settings = await readExpertiseSettings();
        res.json(settings);
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message || 'Failed to load expertise settings',
        });
    }
});

app.post('/api/expertise/settings', requirePermission('edit_settings'), async (req, res) => {
    try {
        const settings = await writeExpertiseSettings(req.body || {});
        res.json({ ok: true, settings });
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message || 'Failed to save expertise settings',
        });
    }
});

app.get('/api/expertise/print-templates', requirePermission('view_settings'), async (req, res) => {
    try {
        const templates = await readExpertisePrintTemplates({ onlyActive: req.query.active === '1' });
        res.json({ templates });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Failed to load print templates' });
    }
});

app.post('/api/expertise/print-templates', requirePermission('edit_settings'), async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const headerImage = typeof req.body?.headerImage === 'string' ? req.body.headerImage : null;
    const templateHtml = typeof req.body?.templateHtml === 'string' ? req.body.templateHtml : null;
    const isActive = req.body?.isActive !== false;
    const isDefault = req.body?.isDefault === true;
    if (!name) return res.status(400).json({ error: 'Template name is required' });
    try {
        await ensureExpertiseTables();
        if (isDefault) {
            await pool.query('UPDATE expertise_print_templates SET is_default = 0');
        }
        const [result] = await pool.query(
            'INSERT INTO expertise_print_templates (name, header_image, template_html, is_active, is_default) VALUES (?, ?, ?, ?, ?)',
            [name, headerImage, templateHtml, isActive ? 1 : 0, isDefault ? 1 : 0]
        );
        if (!isDefault) {
            const [defaultRows] = await pool.query('SELECT COUNT(*) AS total FROM expertise_print_templates WHERE is_default = 1');
            if (Number(defaultRows?.[0]?.total || 0) === 0) {
                await pool.query('UPDATE expertise_print_templates SET is_default = 1 WHERE id = ?', [result.insertId]);
            }
        }
        const template = await readExpertisePrintTemplate(result.insertId);
        res.json({ template });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Failed to create print template' });
    }
});

app.put('/api/expertise/print-templates/:id', requirePermission('edit_settings'), async (req, res) => {
    const id = Number(req.params.id);
    const name = String(req.body?.name || '').trim();
    const headerImage = typeof req.body?.headerImage === 'string' ? req.body.headerImage : null;
    const templateHtml = typeof req.body?.templateHtml === 'string' ? req.body.templateHtml : null;
    const isActive = req.body?.isActive !== false;
    const isDefault = req.body?.isDefault === true;
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid template id' });
    if (!name) return res.status(400).json({ error: 'Template name is required' });
    try {
        await ensureExpertiseTables();
        if (isDefault) {
            await pool.query('UPDATE expertise_print_templates SET is_default = 0');
        }
        await pool.query(
            'UPDATE expertise_print_templates SET name = ?, header_image = ?, template_html = ?, is_active = ?, is_default = ? WHERE id = ?',
            [name, headerImage, templateHtml, isActive ? 1 : 0, isDefault ? 1 : 0, id]
        );
        const [defaultRows] = await pool.query('SELECT COUNT(*) AS total FROM expertise_print_templates WHERE is_default = 1');
        if (Number(defaultRows?.[0]?.total || 0) === 0) {
            await pool.query(
                'UPDATE expertise_print_templates SET is_default = 1, is_active = 1 WHERE id = COALESCE((SELECT id FROM (SELECT id FROM expertise_print_templates WHERE is_active = 1 ORDER BY id ASC LIMIT 1) t), ?)',
                [id]
            );
        }
        const template = await readExpertisePrintTemplate(id);
        res.json({ template });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Failed to update print template' });
    }
});

app.delete('/api/expertise/print-templates/:id', requirePermission('edit_settings'), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid template id' });
    try {
        await ensureExpertiseTables();
        await pool.query('DELETE FROM expertise_print_templates WHERE id = ?', [id]);
        const [rows] = await pool.query('SELECT COUNT(*) AS total FROM expertise_print_templates');
        if (Number(rows?.[0]?.total || 0) === 0) {
            const settings = await readExpertiseSettings();
            await pool.query(
                'INSERT INTO expertise_print_templates (name, header_image, template_html, is_active, is_default) VALUES (?, ?, ?, 1, 1)',
                ['Default Template', settings.headerImage || null, settings.templateHtml || null]
            );
        } else {
            const [defaultRows] = await pool.query('SELECT COUNT(*) AS total FROM expertise_print_templates WHERE is_default = 1');
            if (Number(defaultRows?.[0]?.total || 0) === 0) {
                await pool.query('UPDATE expertise_print_templates SET is_default = 1, is_active = 1 ORDER BY id ASC LIMIT 1');
            }
        }
        res.json({ ok: true });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Failed to delete print template' });
    }
});

app.get('/api/expertise/signature/:userId', requirePermission('view_settings'), async (req, res) => {
    const userId = Number(req.params.userId);
    if (!Number.isFinite(userId)) {
        return res.status(400).json({ error: 'Invalid userId' });
    }
    try {
        const payload = await readRadiologistSignature(userId);
        res.json(payload);
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message || 'Failed to load signature',
        });
    }
});

app.post('/api/expertise/signature', requirePermission('edit_settings'), async (req, res) => {
    const { userId, signatureImage } = req.body || {};
    if (!userId) {
        return res.status(400).json({ error: 'userId is required' });
    }
    try {
        const payload = await writeRadiologistSignature(Number(userId), signatureImage);
        res.json({ ok: true, signature: payload });
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message || 'Failed to save signature',
        });
    }
});

app.get('/api/expertise/assets', requirePermission('view_radiologist'), async (req, res) => {
    const { username } = req.query || {};
    if (!username || typeof username !== 'string') {
        return res.status(400).json({ error: 'username is required' });
    }
    try {
        const [userRows] = await pool.query('SELECT id FROM users WHERE username = ?', [
            username,
        ]);
        if (!userRows.length) {
            return res.status(404).json({ error: 'User not found' });
        }
        const userId = userRows[0].id;
        const [header, signature, defaultTemplate] = await Promise.all([
            readExpertiseSettings(),
            readRadiologistSignature(userId),
            readDefaultExpertisePrintTemplate(),
        ]);
        res.json({
            headerImage: defaultTemplate?.headerImage || header.headerImage || null,
            signatureImage: signature.signatureImage || null,
            templateHtml: defaultTemplate?.templateHtml || header.templateHtml || null,
            qrPosition: header.qrPosition || null,
            templateId: defaultTemplate?.id || null,
            templateName: defaultTemplate?.name || null,
        });
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message || 'Failed to load expertise assets',
        });
    }
});

app.post('/api/ui/settings', requirePermission('edit_settings'), async (req, res) => {
    try {
        const settings = await writeUiSettings(req.body || {});
        res.json({ ok: true, settings });
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message || 'Failed to save UI settings',
        });
    }
});

app.post('/api/dicom/settings', requirePermission('edit_settings'), async (req, res) => {
    try {
        const settings = await writeDicomwebServerSettings(req.body || {});
        res.json({ ok: true, settings });
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message || 'Failed to save dicomweb-pacs server configuration.',
        });
    }
});

app.post('/api/dicom/restart', requirePermission('restart_server'), async (req, res) => {
    try {
        await new Promise((resolve, reject) => {
            const command = `PowerShell -NoProfile -Command "Restart-Service -Name '${ORTHANC_SERVICE_NAME}' -Force -ErrorAction Stop"`;
            exec(command, (err, stdout, stderr) => {
                if (err) {
                    const detail = stderr ? String(stderr).trim() : err.message;
                    return reject(new Error(detail || err.message));
                }
                return resolve(stdout);
            });
        });
        return res.json({ ok: true, message: 'Orthanc service restarted' });
    } catch (err) {
        try {
            const response = await fetch(`${ORTHANC_ROOT}/tools/reset`, { method: 'POST' });
            if (response.ok) {
                return res.json({
                    ok: true,
                    message: 'Orthanc reset triggered; service restart failed',
                });
            }
            return res.status(500).json({
                error: `Failed to restart service (${err.message}). Reset also failed (${response.status})`,
            });
        } catch (fallbackError) {
            return res.status(500).json({
                error: `Failed to restart service (${err.message}). Reset failed (${fallbackError.message})`,
            });
        }
    }
});


function getTagValue(tags, keys) {
    for (const key of keys) {
        const v = tags ? tags[key] : undefined;
        if (v === undefined || v === null) continue;
        if (typeof v === 'string' || typeof v === 'number') return String(v);
        if (Array.isArray(v) && v.length) return String(v[0]);
        if (typeof v === 'object' && Array.isArray(v.Value) && v.Value.length) {
            return String(v.Value[0]);
        }
    }
    return '';
}

function extractStudyTags(raw) {
    const tags = raw || {};
    const modality =
        getTagValue(tags, ['ModalitiesInStudy', 'Modality', '00080061', '00080060']);
    const studyDate =
        getTagValue(tags, ['StudyDate', '00080020']);
    const patientId =
        getTagValue(tags, ['PatientID', '00100020']);
    return { modality, studyDate, patientId };
}

function extractSeriesTags(raw) {
    const tags = raw || {};
    const modality =
        getTagValue(tags, ['Modality', '00080060']);
    const studyDate =
        getTagValue(tags, ['StudyDate', '00080020', 'SeriesDate', '00080021']);
    return { modality, studyDate };
}

app.get('/api/dicom/stats', requirePermission('view_dashboard'), async (req, res) => {
    try {
        await ensureQualityControlTable();
        const extractDicomValue = (record, tagId) => {
            const value = record?.[tagId]?.Value?.[0];
            if (value && typeof value === 'object' && value.Alphabetic) {
                return String(value.Alphabetic).trim();
            }
            return value === undefined || value === null ? '' : String(value).trim();
        };
        const extractDicomValues = (record, tagId) => {
            const values = Array.isArray(record?.[tagId]?.Value) ? record[tagId].Value : [];
            return values
                .map(value => {
                    if (value && typeof value === 'object' && value.Alphabetic) {
                        return String(value.Alphabetic).trim();
                    }
                    return value === undefined || value === null ? '' : String(value).trim();
                })
                .filter(Boolean);
        };
        const normalizeDateParam = (value) => {
            if (!value || typeof value !== 'string') return '';
            const digits = value.replace(/[^0-9]/g, '');
            if (digits.length < 8) return '';
            return digits.slice(0, 8);
        };

        const startParam = normalizeDateParam(req.query.start);
        const endParam = normalizeDateParam(req.query.end);
        const hasRange = Boolean(startParam || endParam);
        const cacheKey = `${startParam || '-'}:${endParam || '-'}`;
        if (!global.__dashboardStatsCache) {
            global.__dashboardStatsCache = new Map();
        }
        if (!global.__dashboardStorageCache) {
            global.__dashboardStorageCache = new Map();
        }
        const cacheStore = global.__dashboardStatsCache;
        const storageCache = global.__dashboardStorageCache;
        const nowMs = Date.now();
        const cacheHit = cacheStore.get(cacheKey);
        if (cacheHit && nowMs - cacheHit.ts < 60000) {
            return res.json(cacheHit.data);
        }

        const parseDateFromKey = (value) => {
            if (!value || value.length < 8) return null;
            const year = Number(value.slice(0, 4));
            const month = Number(value.slice(4, 6));
            const day = Number(value.slice(6, 8));
            if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
            return new Date(year, month - 1, day);
        };

        let useDaily = false;
        if (startParam && endParam) {
            const startDate = parseDateFromKey(startParam);
            const endDate = parseDateFromKey(endParam);
            if (startDate && endDate) {
                const diff = Math.floor((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
                useDaily = diff >= 0 && diff <= 31;
            }
        }

        const now = new Date();
        const year = String(now.getFullYear()).padStart(4, '0');
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const today = `${year}${month}${day}`;
        const rangeSql = [];
        const rangeParams = [];
        if (startParam) {
            rangeSql.push('DATE_FORMAT(COALESCE(o.study_date, DATE(o.tanggal_order)), "%Y%m%d") >= ?');
            rangeParams.push(startParam);
        }
        if (endParam) {
            rangeSql.push('DATE_FORMAT(COALESCE(o.study_date, DATE(o.tanggal_order)), "%Y%m%d") <= ?');
            rangeParams.push(endParam);
        }
        const whereClause = rangeSql.length ? `WHERE ${rangeSql.join(' AND ')}` : '';

        const [summaryRows] = await pool.query(
            `
            SELECT
              COUNT(*) AS total_studies,
              COUNT(DISTINCT COALESCE(NULLIF(TRIM(p.no_rm), ''), CONCAT('ORDER-', o.id))) AS total_patients,
              SUM(
                CASE
                  WHEN DATE_FORMAT(COALESCE(o.study_date, DATE(o.tanggal_order)), '%Y%m%d') = ?
                  THEN 1 ELSE 0
                END
              ) AS today_studies
            FROM mwl_orders o
            LEFT JOIN patients p ON p.id = o.patient_record_id
            ${whereClause}
            `,
            [today, ...rangeParams]
        );

        const [workflowRows] = await pool.query(
            `
            SELECT
              SUM(CASE WHEN o.status = 'PENDING' THEN 1 ELSE 0 END) AS pending_orders,
              SUM(CASE WHEN o.status = 'SENT_TO_MWL' THEN 1 ELSE 0 END) AS sent_to_mwl_orders,
              SUM(CASE WHEN o.status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed_orders,
              SUM(CASE WHEN rr.status = 'draft' THEN 1 ELSE 0 END) AS draft_reports,
              SUM(CASE WHEN rr.status = 'final' THEN 1 ELSE 0 END) AS final_reports,
              SUM(CASE WHEN rr.study_instance_uid IS NOT NULL THEN 1 ELSE 0 END) AS radiologist_read,
              SUM(CASE WHEN qc.study_instance_uid IS NOT NULL THEN 1 ELSE 0 END) AS qc_completed
            FROM mwl_orders o
            LEFT JOIN patients p ON p.id = o.patient_record_id
            LEFT JOIN radiology_reports rr ON rr.study_instance_uid = o.study_instance_uid
            LEFT JOIN (
              SELECT DISTINCT study_instance_uid
              FROM quality_control_status
            ) qc ON qc.study_instance_uid = o.study_instance_uid
            ${whereClause}
            `,
            rangeParams
        );

        const [modalityRows] = await pool.query(
            `
            SELECT
              COALESCE(NULLIF(TRIM(o.modality), ''), 'UNKNOWN') AS name,
              COUNT(*) AS count
            FROM mwl_orders o
            LEFT JOIN patients p ON p.id = o.patient_record_id
            ${whereClause}
            GROUP BY COALESCE(NULLIF(TRIM(o.modality), ''), 'UNKNOWN')
            ORDER BY count DESC, name ASC
            `,
            rangeParams
        );

        const [studyDescriptionRows] = await pool.query(
            `
            SELECT
              COALESCE(
                NULLIF(TRIM(o.procedure_desc), ''),
                NULLIF(TRIM(o.nama_pemeriksaan), ''),
                'UNSPECIFIED'
              ) AS name,
              COUNT(*) AS count
            FROM mwl_orders o
            LEFT JOIN patients p ON p.id = o.patient_record_id
            ${whereClause}
            GROUP BY COALESCE(
              NULLIF(TRIM(o.procedure_desc), ''),
              NULLIF(TRIM(o.nama_pemeriksaan), ''),
              'UNSPECIFIED'
            )
            ORDER BY count DESC, name ASC
            `,
            rangeParams
        );

        const recapFormat = useDaily
            ? `DATE_FORMAT(COALESCE(o.study_date, DATE(o.tanggal_order)), '%Y%m%d')`
            : `DATE_FORMAT(COALESCE(o.study_date, DATE(o.tanggal_order)), '%Y%m')`;
        const [recapRows] = await pool.query(
            `
            SELECT
              ${recapFormat} AS month,
              COUNT(*) AS count
            FROM mwl_orders o
            LEFT JOIN patients p ON p.id = o.patient_record_id
            ${whereClause}
            GROUP BY ${recapFormat}
            ORDER BY month ASC
            `,
            rangeParams
        );

        const totalStudies = Number(summaryRows?.[0]?.total_studies || 0);
        const totalPatients = Number(summaryRows?.[0]?.total_patients || 0);
        const todayStudies = Number(summaryRows?.[0]?.today_studies || 0);
        const workflow = workflowRows?.[0] || {};
        let modalities = Array.isArray(modalityRows)
            ? Array.from(
                  modalityRows.reduce((acc, row) => {
                      const names = normalizeDashboardModalities(row.name);
                      names.forEach(name => {
                          acc.set(name, (acc.get(name) || 0) + Number(row.count || 0));
                      });
                      return acc;
                  }, new Map()).entries()
              ).map(([name, count]) => ({
                  name,
                  count: Number(count || 0),
              }))
            : [];
        let monthlyRecap = Array.isArray(recapRows)
            ? recapRows
                  .filter(row => row.month)
                  .map(row => ({
                      month: String(row.month),
                      count: Number(row.count || 0),
                  }))
            : [];
        const studyDescriptions = Array.isArray(studyDescriptionRows)
            ? studyDescriptionRows.map(row => ({
                  name: String(row.name || 'UNSPECIFIED'),
                  count: Number(row.count || 0),
              }))
            : [];
        let pacsTotalStudies = totalStudies;
        let pacsTotalPatients = totalPatients;
        let pacsTodayStudies = todayStudies;
        try {
            const liveStudiesResult = await getStudies({ limit: '20000' });
            const liveStudies = Array.isArray(liveStudiesResult?.data) ? liveStudiesResult.data : [];
            const filteredStudies = liveStudies.filter(record => {
                const studyDate = extractDicomValue(record, '00080020').replace(/[^0-9]/g, '').slice(0, 8);
                if (!studyDate) return !hasRange;
                if (startParam && studyDate < startParam) return false;
                if (endParam && studyDate > endParam) return false;
                return true;
            });
            pacsTotalStudies = filteredStudies.length;
            pacsTotalPatients = new Set(
                filteredStudies
                    .map(record => extractDicomValue(record, '00100020') || extractDicomValue(record, '00100021'))
                    .filter(Boolean)
            ).size;
            pacsTodayStudies = filteredStudies.filter(record => {
                const studyDate = extractDicomValue(record, '00080020').replace(/[^0-9]/g, '').slice(0, 8);
                return studyDate === today;
            }).length;

            const studyUids = Array.from(
                new Set(
                    filteredStudies
                        .map(record => extractDicomValue(record, '0020000D'))
                        .filter(Boolean)
                )
            );
            const accessionNumbers = Array.from(
                new Set(
                    filteredStudies
                        .map(record => extractDicomValue(record, '00080050'))
                        .filter(Boolean)
                )
            );
            const mappedModalities = new Map();
            if (studyUids.length || accessionNumbers.length) {
                const modalityWhere = [];
                const modalityParams = [];
                if (studyUids.length) {
                    modalityWhere.push('study_instance_uid IN (?)');
                    modalityParams.push(studyUids);
                }
                if (accessionNumbers.length) {
                    modalityWhere.push('accession_number IN (?)');
                    modalityParams.push(accessionNumbers);
                }
                if (modalityWhere.length) {
                    const [modalityMapRows] = await pool.query(
                        `
                        SELECT study_instance_uid, accession_number, COALESCE(NULLIF(TRIM(modality), ''), 'UNKNOWN') AS modality
                        FROM mwl_orders
                        WHERE ${modalityWhere.join(' OR ')}
                        `,
                        modalityParams
                    );
                    for (const row of modalityMapRows || []) {
                        const normalized = normalizeDashboardModalities(row.modality);
                        const modality = normalized.length ? normalized.join('\\') : 'UNKNOWN';
                        if (row.study_instance_uid) {
                            mappedModalities.set(`study:${row.study_instance_uid}`, modality);
                        }
                        if (row.accession_number) {
                            mappedModalities.set(`accession:${row.accession_number}`, modality);
                        }
                    }
                }
            }

            const modalityCounter = new Map();
            const recapCounter = new Map();
            for (const record of filteredStudies) {
                const studyUid = extractDicomValue(record, '0020000D');
                const accessionNumber = extractDicomValue(record, '00080050');
                const mappedModality =
                    (studyUid && mappedModalities.get(`study:${studyUid}`)) ||
                    (accessionNumber && mappedModalities.get(`accession:${accessionNumber}`)) ||
                    '';
                const modalityValues = mappedModality
                    ? normalizeDashboardModalities(mappedModality)
                    : normalizeDashboardModalities(...extractDicomValues(record, '00080061'));
                const modalitiesForStudy = modalityValues.length ? modalityValues : ['UNKNOWN'];
                for (const modality of modalitiesForStudy) {
                    modalityCounter.set(modality, (modalityCounter.get(modality) || 0) + 1);
                }
                const studyDate = extractDicomValue(record, '00080020').replace(/[^0-9]/g, '').slice(0, 8);
                if (!studyDate) continue;
                const recapKey = useDaily ? studyDate : studyDate.slice(0, 6);
                recapCounter.set(recapKey, (recapCounter.get(recapKey) || 0) + 1);
            }
            modalities = Array.from(modalityCounter.entries())
                .map(([name, count]) => ({ name, count: Number(count || 0) }))
                .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
            monthlyRecap = Array.from(recapCounter.entries())
                .map(([month, count]) => ({ month, count: Number(count || 0) }))
                .sort((a, b) => a.month.localeCompare(b.month));
        } catch (pacsError) {
            console.warn('[dashboard] failed to read live dicomweb-pacs studies:', pacsError.message);
        }

        const dicomwebSettings = await readDicomwebServerSettings();
        const storagePath = String(dicomwebSettings?.storagePath || process.env.DICOMWEB_PACS_STORAGE_PATH || 'C:');
        const driveMatch = storagePath.match(/^([a-zA-Z]:)/);
        const drive = driveMatch ? driveMatch[1].toUpperCase() : 'C:';

        const storageCacheKey = drive;
        const cachedStorage = storageCache.get(storageCacheKey);
        const baseData = {
            storage: {
                total: cachedStorage?.data?.total || '0 GB',
                used: cachedStorage?.data?.used || '0 GB',
                free: cachedStorage?.data?.free || '0 GB',
                path: storagePath,
            },
            totalStudies: pacsTotalStudies,
            totalPatients: pacsTotalPatients,
            todayStudies: pacsTodayStudies,
            risSummary: {
                pendingOrders: Number(workflow.pending_orders || 0),
                sentToMwl: Number(workflow.sent_to_mwl_orders || 0),
                completedStudies: Number(workflow.completed_orders || 0),
                draftReports: Number(workflow.draft_reports || 0),
                finalReports: Number(workflow.final_reports || 0),
                qcCompleted: Number(workflow.qc_completed || 0),
            },
            dashboardSummary: {
                totalOrder: pacsTotalStudies,
                technologistProcessed:
                    Number(workflow.sent_to_mwl_orders || 0) + Number(workflow.completed_orders || 0),
                radiologist: {
                    read: Number(workflow.radiologist_read || 0),
                    total: Number(workflow.completed_orders || 0),
                    pending:
                        Math.max(
                            0,
                            Number(workflow.completed_orders || 0) - Number(workflow.radiologist_read || 0)
                        ),
                },
                qualityControl: {
                    done: Number(workflow.qc_completed || 0),
                    total: Number(workflow.completed_orders || 0),
                    pending:
                        Math.max(
                            0,
                            Number(workflow.completed_orders || 0) - Number(workflow.qc_completed || 0)
                        ),
                },
            },
            modalities,
            monthlyRecap,
            studyDescriptions,
        };

        cacheStore.set(cacheKey, { ts: Date.now(), data: baseData });
        if (cacheStore.size > 50) {
            const firstKey = cacheStore.keys().next().value;
            if (firstKey) {
                cacheStore.delete(firstKey);
            }
        }
        res.json(baseData);

        const shouldRefreshStorage =
            !cachedStorage || nowMs - cachedStorage.ts >= 5 * 60 * 1000;
        if (shouldRefreshStorage) {
            const psCommand = `PowerShell "Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DeviceID -eq '${drive}' } | Select-Object Size, FreeSpace | ConvertTo-Json"`;
            exec(psCommand, { timeout: 4000 }, (err, stdout) => {
                try {
                    if (!err && stdout) {
                        const diskInfo = JSON.parse(stdout);
                        const totalBytes = BigInt(diskInfo.Size || 0);
                        const freeBytes = BigInt(diskInfo.FreeSpace || 0);
                        if (totalBytes > 0n) {
                            const totalGB = Number(totalBytes) / (1024 * 1024 * 1024);
                            const freeGB = Number(freeBytes) / (1024 * 1024 * 1024);
                            storageCache.set(storageCacheKey, {
                                ts: Date.now(),
                                data: {
                                    total: totalGB.toFixed(1) + ' GB',
                                    used: (totalGB - freeGB).toFixed(1) + ' GB',
                                    free: freeGB.toFixed(1) + ' GB',
                                },
                            });
                            if (storageCache.size > 10) {
                                const firstKey = storageCache.keys().next().value;
                                if (firstKey) {
                                    storageCache.delete(firstKey);
                                }
                            }
                        }
                    }
                } catch (e) { }
            });
        }
    } catch (err) {
        res.status(500).json({ error: 'Could not fetch statistics' });
    }
});

const formatRoutingDate = date => {
    const value = new Date(date);
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
};

const routingSourceDate = schedule => {
    if (schedule.source_date_mode === 'specific_date' && schedule.source_date) return formatRoutingDate(schedule.source_date);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return formatRoutingDate(yesterday);
};

const calculateRoutingNextRun = (recurrence, runTime, scheduledAt) => {
    if (recurrence === 'once') {
        const parsed = new Date(scheduledAt);
        if (!Number.isFinite(parsed.getTime())) throw Object.assign(new Error('A valid scheduled date and time is required'), { status: 400 });
        return parsed;
    }
    const match = String(runTime || '').match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (!match) throw Object.assign(new Error('runTime must use HH:mm format'), { status: 400 });
    const next = new Date();
    next.setHours(Number(match[1]), Number(match[2]), 0, 0);
    if (next <= new Date()) next.setDate(next.getDate() + 1);
    return next;
};

const routingDicomValues = (record, tagId) => {
    const values = record?.[tagId]?.Value;
    if (!Array.isArray(values)) return [];
    return values.map(value => {
        if (value && typeof value === 'object') return String(value.Alphabetic || value.Ideographic || value.Phonetic || '');
        return String(value ?? '');
    }).filter(Boolean);
};
const routingDicomValue = (record, tagId) => routingDicomValues(record, tagId)[0] || '';

async function previewDicomRoutingStudies({ sourceDateMode, sourceDate, modality }) {
    const date = sourceDateMode === 'specific_date' && sourceDate
        ? formatRoutingDate(sourceDate)
        : routingSourceDate({ source_date_mode: 'previous_day' });
    const result = await dicomwebPacs.getStudies({ StudyDate: date, fresh: '1', includeEmpty: 'true' });
    const normalizedModality = String(modality || '').trim().toUpperCase();
    const studies = (result.data || []).map(record => ({
        studyInstanceUid: routingDicomValue(record, '0020000D'),
        studyDate: routingDicomValue(record, '00080020') || date,
        modality: routingDicomValues(record, '00080061').join('\\') || routingDicomValue(record, '00080060'),
        patientName: routingDicomValue(record, '00100010'),
        patientId: routingDicomValue(record, '00100020'),
        description: routingDicomValue(record, '00081030'),
        instances: Number(routingDicomValue(record, '00201208') || 0),
    })).filter(study => study.studyInstanceUid && (!normalizedModality || String(study.modality || '').toUpperCase().split('\\').includes(normalizedModality)));
    return { date, studies, count: studies.length, instances: studies.reduce((sum, study) => sum + study.instances, 0) };
}

let dicomRoutingBusy = false;
async function enqueueDicomRoutingSchedule(schedule) {
    const preview = await previewDicomRoutingStudies({
        sourceDateMode: schedule.source_date_mode,
        sourceDate: schedule.source_date,
        modality: schedule.modality,
    });
    for (const study of preview.studies) {
        await pool.query(
            `INSERT IGNORE INTO dicom_routing_jobs
             (schedule_id, node_id, study_instance_uid, study_date, modality, max_retries, next_attempt_at)
             VALUES (?, ?, ?, ?, ?, ?, NOW())`,
            [schedule.id, schedule.node_id, study.studyInstanceUid, study.studyDate, study.modality || null, schedule.max_retries]
        );
    }
    const nextRun = schedule.recurrence === 'daily'
        ? (() => { const next = new Date(schedule.next_run_at); next.setDate(next.getDate() + 1); return next; })()
        : null;
    await pool.query(
        'UPDATE dicom_routing_schedules SET last_run_at = NOW(), next_run_at = COALESCE(?, next_run_at), enabled = ? WHERE id = ?',
        [nextRun, schedule.recurrence === 'daily' ? 1 : 0, schedule.id]
    );
    return preview;
}

async function runDicomRoutingScheduler() {
    if (dicomRoutingBusy) return;
    dicomRoutingBusy = true;
    try {
        const [dueSchedules] = await pool.query('SELECT * FROM dicom_routing_schedules WHERE enabled = 1 AND next_run_at <= NOW() ORDER BY next_run_at ASC LIMIT 10');
        for (const schedule of dueSchedules) {
            try { await enqueueDicomRoutingSchedule(schedule); }
            catch (error) { console.error('[dicom-routing] schedule failed:', schedule.id, error.message); }
        }
        const [jobs] = await pool.query(
            `SELECT jobs.*, nodes.name AS node_name, nodes.aet, nodes.host, nodes.port, nodes.enabled AS node_enabled
             FROM dicom_routing_jobs jobs JOIN dicom_nodes nodes ON nodes.id = jobs.node_id
             WHERE jobs.status IN ('queued', 'retry') AND jobs.next_attempt_at <= NOW()
             ORDER BY jobs.created_at ASC LIMIT 5`
        );
        for (const job of jobs) {
            if (!job.node_enabled) continue;
            await pool.query("UPDATE dicom_routing_jobs SET status = 'sending', attempts = attempts + 1, started_at = NOW() WHERE id = ?", [job.id]);
            try {
                await dicomwebPacs.forwardStudyToNode(job.study_instance_uid, job);
                await pool.query("UPDATE dicom_routing_jobs SET status = 'success', completed_at = NOW(), last_error = NULL WHERE id = ?", [job.id]);
                await writeAuditLog(null, { eventType: 'dicom_routing', outcome: 'success', username: 'system-scheduler', studyInstanceUid: job.study_instance_uid, targetType: 'dicom_node', targetId: String(job.node_id), details: { scheduleId: job.schedule_id, nodeName: job.node_name } });
            } catch (error) {
                const retry = Number(job.attempts || 0) + 1 < Number(job.max_retries || 3);
                await pool.query(
                    `UPDATE dicom_routing_jobs SET status = ?, next_attempt_at = DATE_ADD(NOW(), INTERVAL 5 MINUTE), last_error = ? WHERE id = ?`,
                    [retry ? 'retry' : 'failed', String(error.message || error).slice(0, 4000), job.id]
                );
                await writeAuditLog(null, { eventType: 'dicom_routing', outcome: 'failure', username: 'system-scheduler', studyInstanceUid: job.study_instance_uid, targetType: 'dicom_node', targetId: String(job.node_id), details: { scheduleId: job.schedule_id, error: error.message || String(error), retry } });
            }
        }
    } finally { dicomRoutingBusy = false; }
}

app.get('/api/dicom/routing/schedules', requirePermission('edit_settings'), async (req, res) => {
    try {
        const [rows] = await pool.query(`SELECT schedules.*, nodes.name AS node_name, nodes.aet FROM dicom_routing_schedules schedules JOIN dicom_nodes nodes ON nodes.id = schedules.node_id ORDER BY schedules.created_at DESC`);
        res.json(rows.map(row => ({ ...row, enabled: Boolean(row.enabled) })));
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/dicom/routing/preview', requirePermission('edit_settings'), async (req, res) => {
    try { res.json(await previewDicomRoutingStudies(req.body || {})); }
    catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});

app.post('/api/dicom/routing/schedules', requirePermission('edit_settings'), async (req, res) => {
    try {
        const body = req.body || {};
        const nodeId = Number(body.nodeId);
        const recurrence = body.recurrence === 'once' ? 'once' : 'daily';
        const sourceDateMode = body.sourceDateMode === 'specific_date' ? 'specific_date' : 'previous_day';
        const [nodes] = await pool.query('SELECT id FROM dicom_nodes WHERE id = ? AND enabled = 1', [nodeId]);
        if (!nodes.length) return res.status(400).json({ error: 'Select an enabled DICOM destination' });
        const nextRun = calculateRoutingNextRun(recurrence, body.runTime || '01:00', body.scheduledAt);
        const [result] = await pool.query(
            `INSERT INTO dicom_routing_schedules
             (name, node_id, enabled, recurrence, run_time, source_date_mode, source_date, modality, max_retries, next_run_at, created_by)
             VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [String(body.name || 'DICOM Routing Schedule').trim(), nodeId, recurrence, String(body.runTime || '01:00'), sourceDateMode, sourceDateMode === 'specific_date' ? body.sourceDate || null : null, String(body.modality || '').trim().toUpperCase() || null, Math.min(10, Math.max(1, Number(body.maxRetries || 3))), nextRun, getUsernameFromRequest(req)]
        );
        await writeAuditLog(req, { eventType: 'dicom_routing_schedule', outcome: 'success', targetType: 'dicom_node', targetId: String(nodeId), details: { scheduleId: result.insertId, recurrence, nextRun } });
        res.status(201).json({ id: result.insertId });
    } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});

app.patch('/api/dicom/routing/schedules/:id', requirePermission('edit_settings'), async (req, res) => {
    try {
        const enabled = req.body?.enabled === true;
        await pool.query('UPDATE dicom_routing_schedules SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, Number(req.params.id)]);
        res.json({ ok: true, enabled });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/api/dicom/routing/schedules/:id', requirePermission('edit_settings'), async (req, res) => {
    try {
        await pool.query('DELETE FROM dicom_routing_jobs WHERE schedule_id = ?', [Number(req.params.id)]);
        await pool.query('DELETE FROM dicom_routing_schedules WHERE id = ?', [Number(req.params.id)]);
        res.json({ ok: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/dicom/routing/schedules/:id/run', requirePermission('edit_settings'), async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM dicom_routing_schedules WHERE id = ?', [Number(req.params.id)]);
        if (!rows.length) return res.status(404).json({ error: 'Schedule not found' });
        const preview = await enqueueDicomRoutingSchedule(rows[0]);
        setImmediate(() => runDicomRoutingScheduler());
        res.json({ queued: preview.count, date: preview.date });
    } catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});

app.get('/api/dicom/routing/jobs', requirePermission('edit_settings'), async (req, res) => {
    try {
        const [rows] = await pool.query(`SELECT jobs.*, schedules.name AS schedule_name, nodes.name AS node_name FROM dicom_routing_jobs jobs JOIN dicom_routing_schedules schedules ON schedules.id = jobs.schedule_id JOIN dicom_nodes nodes ON nodes.id = jobs.node_id ORDER BY jobs.created_at DESC LIMIT 200`);
        res.json(rows);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/dicom/forward', requirePermission('download_study'), async (req, res) => {
    try {
        const { studyInstanceUids, nodeId } = req.body || {};
        if (!Array.isArray(studyInstanceUids) || studyInstanceUids.length === 0) {
            return res.status(400).json({ error: 'studyInstanceUids must be a non-empty array' });
        }
        if (!nodeId) {
            return res.status(400).json({ error: 'nodeId is required' });
        }

        const [rows] = await pool.query(
            'SELECT id, name, aet, host, port, enabled FROM dicom_nodes WHERE id = ?',
            [nodeId]
        );
        if (!rows.length) {
            return res.status(404).json({ error: 'DICOM node not found' });
        }
        const node = rows[0];
        if (!node.enabled) {
            return res.status(400).json({ error: 'DICOM node is disabled' });
        }

        const uniqueUids = Array.from(
            new Set(
                studyInstanceUids
                    .map(uid => (typeof uid === 'string' ? uid.trim() : ''))
                    .filter(Boolean)
            )
        );
        if (!uniqueUids.length) {
            return res.status(400).json({ error: 'No valid StudyInstanceUIDs provided' });
        }

        const results = [];
        for (const studyInstanceUid of uniqueUids) {
            try {
                const job = await dicomwebPacs.forwardStudyToNode(studyInstanceUid, node);
                results.push({
                    studyInstanceUid,
                    status: 'ok',
                    job,
                    message: job?.verification?.existedBefore
                        ? 'Study verified at destination; it already existed before this transfer, so duplicate instances may not create a new entry.'
                        : 'Study sent and verified at destination.',
                });
                await writeAuditLog(req, {
                    eventType: 'dicom_forward',
                    outcome: 'success',
                    studyInstanceUid,
                    targetType: 'dicom_node',
                    targetId: String(node.id),
                    details: { nodeName: node.name, aet: node.aet, host: node.host, port: node.port },
                });
            } catch (err) {
                results.push({
                    studyInstanceUid,
                    status: 'error',
                    message: err.message || 'Unexpected error',
                });
                await writeAuditLog(req, {
                    eventType: 'dicom_forward',
                    outcome: 'failure',
                    studyInstanceUid,
                    targetType: 'dicom_node',
                    targetId: String(node.id),
                    details: { error: err.message || 'Unexpected error', nodeName: node.name, aet: node.aet },
                });
            }
        }

        res.json({
            node: {
                id: node.id,
                name: node.name,
                aet: node.aet,
                host: node.host,
                port: node.port,
            },
            results,
        });
    } catch (err) {
        res.status(err.status || 500).json({
            error: err.message || 'Failed to forward studies to DICOM node',
        });
    }
});

app.get('/api/dicom/forward/destinations', requirePermission('download_study'), async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT id, name, aet, host, port, description, enabled, created_at, updated_at FROM dicom_nodes WHERE enabled = 1 ORDER BY name ASC'
        );
        const nodes = rows.map(row => ({
            id: row.id,
            name: row.name,
            aet: row.aet,
            host: row.host,
            port: row.port,
            description: row.description,
            enabled: Boolean(row.enabled),
            created_at: row.created_at,
            updated_at: row.updated_at,
        }));
        res.json(nodes);
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to load DICOM forward destinations' });
    }
});

app.get('/api/dicom/series/:seriesInstanceUid/thumbnail', async (req, res) => {
    const seriesInstanceUid = req.params.seriesInstanceUid;
    if (!seriesInstanceUid) {
        return res.status(400).json({ error: 'Missing seriesInstanceUid' });
    }
    try {
        const studyInstanceUid =
            typeof req.query.studyInstanceUID === 'string'
                ? req.query.studyInstanceUID
                : typeof req.query.studyUid === 'string'
                  ? req.query.studyUid
                  : null;
        const result = await dicomwebPacs.renderSeriesThumbnail(seriesInstanceUid, studyInstanceUid);
        const contentType = result.contentType || 'image/png';
        const isPlaceholder = String(contentType).includes('image/svg+xml');
        const notReady = Boolean(result.notReady) || !result.buffer || Number(result.buffer.length) === 0;
        res.set('Content-Type', contentType);
        // Placeholder "belum siap" TIDAK boleh disimpan browser: kalau ikut di-cache, tile
        // seri baru tetap hitam walaupun gambarnya sudah jadi beberapa detik kemudian.
        res.set(
            'Cache-Control',
            notReady ? 'no-store' : isPlaceholder ? 'private, max-age=60' : 'private, max-age=86400, immutable'
        );
        if (notReady) res.set('Retry-After', '2');
        if (result.etag) res.set('ETag', result.etag);
        res.send(result.buffer);
    } catch (err) {
        res
            .status(err.status || 500)
            .json({ error: err.message || 'Failed to fetch series thumbnail' });
    }
});

async function findInstanceIdsInSeries(seriesInstanceUID, sopInstanceUID) {
    if (
        !seriesInstanceUID ||
        typeof seriesInstanceUID !== 'string' ||
        !sopInstanceUID ||
        typeof sopInstanceUID !== 'string'
    ) {
        return [];
    }
    const seriesIds = await findOrthancIds('Series', {
        SeriesInstanceUID: seriesInstanceUID,
    });
    if (!Array.isArray(seriesIds) || !seriesIds.length) {
        return [];
    }
    const matches = [];
    for (const seriesId of seriesIds) {
        const metaRes = await fetch(`${ORTHANC_ROOT}/series/${seriesId}`);
        if (!metaRes.ok) {
            continue;
        }
        let meta;
        try {
            meta = await metaRes.json();
        } catch {
            continue;
        }
        const instances = Array.isArray(meta.Instances) ? meta.Instances : [];
        for (const instId of instances) {
            const instRes = await fetch(`${ORTHANC_ROOT}/instances/${instId}`);
            if (!instRes.ok) {
                continue;
            }
            try {
                const instMeta = await instRes.json();
                const tags = instMeta.MainDicomTags || {};
                if (
                    String(tags.SOPInstanceUID || '') === String(sopInstanceUID)
                ) {
                    matches.push(instId);
                }
            } catch {
            }
        }
    }
    if (matches.length) {
        setCachedIds(
            'Instance',
            {
                SOPInstanceUID: sopInstanceUID,
            },
            matches
        );
    }
    return matches;
}

app.get('/api/dicom/instances/preview', async (req, res) => {
    const sopInstanceUID = req.query.sopInstanceUID || req.query.sop || req.query.uid;
    const seriesInstanceUID =
        req.query.seriesInstanceUID || req.query.seriesUid || req.query.series;
    const studyInstanceUID =
        req.query.studyInstanceUID || req.query.studyUid || req.query.study;
    const requestedWindowWidth = Number(req.query.ww ?? req.query.windowWidth);
    const requestedWindowLevel = Number(req.query.wl ?? req.query.wc ?? req.query.windowLevel ?? req.query.windowCenter);
    const requestedFrame = Number(req.query.frame);
    const windowWidth = Number.isFinite(requestedWindowWidth) && requestedWindowWidth > 1
        ? requestedWindowWidth
        : undefined;
    const windowCenter = Number.isFinite(requestedWindowLevel)
        ? requestedWindowLevel
        : undefined;
    if (!sopInstanceUID || typeof sopInstanceUID !== 'string') {
        return res.status(400).json({ error: 'Missing sopInstanceUID' });
    }
    try {
        const result = await dicomwebPacs.renderInstancePreview({
            studyUid: typeof studyInstanceUID === 'string' ? studyInstanceUID : null,
            seriesUid: typeof seriesInstanceUID === 'string' ? seriesInstanceUID : null,
            sopInstanceUid: sopInstanceUID,
            frame: Number.isFinite(requestedFrame) && requestedFrame > 0
                ? Math.floor(requestedFrame)
                : 1,
            windowCenter,
            windowWidth,
        });
        const { contentType, buffer, etag } = result;
        const isPlaceholder = String(contentType || '').includes('image/svg+xml');
        // Body kosong / placeholder = gambar belum siap: jangan pernah dikunci browser
        // sehari, kalau tidak tile di daftar seri tetap hitam walau gambarnya sudah jadi.
        const notReady = Boolean(result.notReady) || !buffer || Number(buffer.length) === 0;
        if (req.headers['if-none-match'] === etag) {
            return res.status(304).end();
        }
        res.set('Content-Type', contentType);
        res.set(
            'Cache-Control',
            notReady ? 'no-store' : isPlaceholder ? 'private, max-age=60' : 'private, max-age=86400, immutable'
        );
        if (notReady) res.set('Retry-After', '2');
        res.set('ETag', etag);
        res.send(buffer);
    } catch (err) {
        res
            .status(err.status || 500)
            .json({ error: err.message || 'Failed to fetch instance preview' });
    }
});

async function findOrthancIds(level, query) {
    const cached = getCachedIds(level, query);
    if (cached && cached.length) {
        return cached;
    }
    const body = {
        Level: level,
        Expand: false,
        Query: query,
    };
    const response = await fetch(`${ORTHANC_ROOT}/tools/find`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...getOrthancAuthHeaders(),
        },
        body: JSON.stringify(body),
    });
    if (response.ok) {
        const results = await response.json();
        if (Array.isArray(results)) {
            const ids = results
                .map(r => {
                    if (typeof r === 'string') return r;
                    if (r && typeof r === 'object' && typeof r.ID === 'string') return r.ID;
                    return null;
                })
                .filter(Boolean);
            if (ids.length) {
                setCachedIds(level, query, ids);
                return ids;
            }
        }
    }

    const lower = String(level || '').toLowerCase();
    let collection = '';
    if (lower === 'study' || lower === 'studies') {
        collection = 'studies';
    } else if (lower === 'series') {
        collection = 'series';
    }

    if (collection) {
        const listRes = await fetch(`${ORTHANC_ROOT}/${collection}`, {
            headers: {
                ...getOrthancAuthHeaders(),
            },
        });
        if (!listRes.ok) {
            const err = new Error(`Orthanc /${collection} failed (${listRes.status})`);
            err.status = listRes.status;
            throw err;
        }
        const ids = await listRes.json();
        if (Array.isArray(ids) && ids.length) {
            const matches = [];
            for (const id of ids) {
                const metaRes = await fetch(`${ORTHANC_ROOT}/${collection}/${id}`, {
                    headers: {
                        ...getOrthancAuthHeaders(),
                    },
                });
                if (!metaRes.ok) {
                    continue;
                }
                try {
                    const meta = await metaRes.json();
                    const tags = meta.MainDicomTags || {};
                    let ok = true;
                    for (const [key, value] of Object.entries(query || {})) {
                        if (value === undefined || value === null || value === '') {
                            continue;
                        }
                        if (String(tags[key] || '') !== String(value)) {
                            ok = false;
                            break;
                        }
                    }
                    if (ok) {
                        matches.push(id);
                    }
                } catch {
                }
            }
            if (matches.length) {
                setCachedIds(level, query, matches);
                return matches;
            }
        }
        return [];
    }

    if (!response.ok) {
        const err = new Error(`Orthanc /tools/find failed (${response.status})`);
        err.status = response.status;
        throw err;
    }
    return [];
}

async function deleteOrthancResources(resourceType, level, query) {
    const ids = await findOrthancIds(level, query);
    if (!ids.length) {
        const err = new Error('Resource not found');
        err.status = 404;
        throw err;
    }
    for (const id of ids) {
        const response = await fetch(`${ORTHANC_ROOT}/${resourceType}/${id}`, {
            method: 'DELETE',
        });
        if (!response.ok) {
            const err = new Error(`Failed to delete ${resourceType.slice(0, -1)} (${response.status})`);
            err.status = response.status;
            throw err;
        }
    }
}

async function updateOrthancStudy(query, replace) {
    const ids = await findOrthancIds('Study', query);
    if (!ids.length) {
        const err = new Error('Study not found');
        err.status = 404;
        throw err;
    }
    const payload = {
        Replace: replace,
        Force: true,
        KeepSource: false,
    };
    for (const id of ids) {
        const response = await fetch(`${ORTHANC_ROOT}/studies/${id}/modify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!response.ok) {
            let detail = '';
            try {
                const contentType = response.headers.get('content-type') || '';
                if (contentType.includes('application/json')) {
                    const parsed = await response.json();
                    if (parsed && typeof parsed === 'object') {
                        detail = parsed.error || parsed.message || JSON.stringify(parsed);
                    }
                } else {
                    detail = await response.text();
                }
            } catch {
            }
            const suffix = detail ? `: ${detail}` : '';
            const err = new Error(`Failed to update study (${response.status})${suffix}`);
            err.status = response.status;
            throw err;
        }
    }
}

app.delete('/api/dicom/studies/:studyInstanceUid', requireAnyPermission('delete_study', 'view_dicom_manager'), async (req, res) => {
    const deleteReason = requireDeleteReason(req, res);
    if (!deleteReason) return;
    const studyInstanceUid = req.params.studyInstanceUid;
    const auditStudyInfo = await getAuditStudyInfo(studyInstanceUid);
    try {
        await dicomwebPacs.deleteStudy(studyInstanceUid);
        orthancIdCache.delete(`study:${studyInstanceUid}`);
        clearQidoCache();
        await writeAuditLog(req, {
            eventType: 'dicom_delete_study',
            outcome: 'success',
            studyInstanceUid,
            targetType: 'study',
            targetId: studyInstanceUid,
            details: {
                deleteReason,
                ...(auditStudyInfo ? { studyInfo: auditStudyInfo } : {}),
            },
        });
        res.json({ ok: true });
    } catch (err) {
        await writeAuditLog(req, {
            eventType: 'dicom_delete_study',
            outcome: 'failure',
            studyInstanceUid,
            targetType: 'study',
            targetId: studyInstanceUid,
            details: {
                deleteReason,
                error: err.message || 'Failed to delete study',
                ...(auditStudyInfo ? { studyInfo: auditStudyInfo } : {}),
            },
        });
        res.status(err.status || 500).json({ error: err.message || 'Failed to delete study' });
    }
});

app.put('/api/dicom/studies/:studyInstanceUid/metadata', requireAnyPermission('edit_metadata', 'view_dicom_manager'), async (req, res) => {
    const studyInstanceUid = req.params.studyInstanceUid;
    const managerContext = req.body?._managerOperation;
    const {
        patientName,
        patientId,
        patientBirthDate,
        patientSex,
        otherPatientIds,
        accessionNumber,
        institutionName,
        studyDescription,
        referringPhysician,
        studyDate,
        studyTime,
        studyId,
    } = req.body || {};
    const replace = {};
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'patientName')) {
        replace.PatientName = patientName || '';
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'patientId')) {
        replace.PatientID = patientId || '';
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'patientBirthDate')) {
        replace.PatientBirthDate = patientBirthDate || '';
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'patientSex')) {
        replace.PatientSex = patientSex || '';
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'otherPatientIds')) {
        replace.OtherPatientIDs = otherPatientIds || '';
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'accessionNumber')) {
        replace.AccessionNumber = accessionNumber || '';
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'institutionName')) {
        replace.InstitutionName = institutionName || '';
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'studyDescription')) {
        replace.StudyDescription = studyDescription || '';
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'referringPhysician')) {
        replace.ReferringPhysicianName = referringPhysician || '';
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'studyDate')) {
        replace.StudyDate = studyDate || '';
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'studyTime')) {
        replace.StudyTime = studyTime || '';
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'studyId')) {
        replace.StudyID = studyId || '';
    }
    if (!Object.keys(replace).length) {
        return res.status(400).json({ error: 'No fields to update' });
    }
    const beforeStudyInfo = await getAuditStudyInfo(studyInstanceUid);
    let managerOperation = null;
    try {
        if (managerContext?.type === 'patient_correction') {
            managerOperation = await dicomwebPacs.beginManagerOperation({
                operationType: 'patient_correction',
                sourceStudyUid: studyInstanceUid,
                targetPatientId: managerContext.targetPatientId || patientId || null,
                username: getUsernameFromRequest(req),
                reason: managerContext.reason || 'DICOM Manager patient correction',
                input: { replace },
            });
        }
        const updated = await dicomwebPacs.updateStudyMetadata(studyInstanceUid, replace);
        if (managerOperation) {
            await dicomwebPacs.completeManagerOperation(managerOperation.operationId, updated);
        }
        orthancIdCache.delete(`study:${studyInstanceUid}`);
        clearQidoCache();
        const afterStudyInfo = await getAuditStudyInfo(studyInstanceUid);
        await writeAuditLog(req, {
            eventType: 'dicom_update_metadata',
            outcome: 'success',
            studyInstanceUid,
            targetType: 'study',
            targetId: studyInstanceUid,
            details: {
                fields: Object.keys(replace),
                before: beforeStudyInfo,
                after: afterStudyInfo,
                changes: buildAuditMetadataChanges(replace, beforeStudyInfo, afterStudyInfo),
                managerOperationId: managerOperation?.operationId || null,
            },
        });
        res.json({ ok: true, ...updated, managerOperationId: managerOperation?.operationId || null });
    } catch (err) {
        await dicomwebPacs.failManagerOperation(managerOperation?.operationId, err);
        await writeAuditLog(req, {
            eventType: 'dicom_update_metadata',
            outcome: 'failure',
            studyInstanceUid,
            targetType: 'study',
            targetId: studyInstanceUid,
            details: {
                fields: Object.keys(replace),
                before: beforeStudyInfo,
                attempted: replace,
                managerOperationId: managerOperation?.operationId || null,
                error: err.message || 'Failed to update study',
            },
        });
        res.status(err.status || 500).json({ error: err.message || 'Failed to update study' });
    }
});

app.put('/api/dicom/studies/:studyInstanceUid/series/:seriesInstanceUid/metadata', requireAnyPermission('edit_metadata', 'view_dicom_manager'), async (req, res) => {
    const { studyInstanceUid, seriesInstanceUid } = req.params;
    const {
        modality,
        seriesDescription,
        seriesNumber,
        bodyPartExamined,
        protocolName,
        laterality,
    } = req.body || {};
    const replace = {};
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'modality')) {
        replace.Modality = modality || '';
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'seriesDescription')) {
        replace.SeriesDescription = seriesDescription || '';
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'seriesNumber')) {
        replace.SeriesNumber = seriesNumber || '';
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'bodyPartExamined')) {
        replace.BodyPartExamined = bodyPartExamined || '';
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'protocolName')) {
        replace.ProtocolName = protocolName || '';
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'laterality')) {
        replace.Laterality = laterality || '';
    }
    if (!Object.keys(replace).length) {
        return res.status(400).json({ error: 'No fields to update' });
    }
    try {
        const updated = await dicomwebPacs.updateSeriesMetadata(studyInstanceUid, seriesInstanceUid, replace);
        orthancIdCache.delete(`series:${seriesInstanceUid}`);
        clearQidoCache();
        await writeAuditLog(req, {
            eventType: 'dicom_update_series_metadata',
            outcome: 'success',
            studyInstanceUid,
            seriesInstanceUid,
            targetType: 'series',
            targetId: seriesInstanceUid,
            details: { fields: Object.keys(replace), replace },
        });
        res.json({ ok: true, ...updated });
    } catch (err) {
        await writeAuditLog(req, {
            eventType: 'dicom_update_series_metadata',
            outcome: 'failure',
            studyInstanceUid,
            seriesInstanceUid,
            targetType: 'series',
            targetId: seriesInstanceUid,
            details: { fields: Object.keys(replace), attempted: replace, error: err.message || 'Failed to update series' },
        });
        res.status(err.status || 500).json({ error: err.message || 'Failed to update series' });
    }
});

app.put('/api/dicom/studies/:studyInstanceUid/series/:seriesInstanceUid/instances/:sopInstanceUid/metadata', requireAnyPermission('edit_metadata', 'view_dicom_manager'), async (req, res) => {
    const { studyInstanceUid, seriesInstanceUid, sopInstanceUid } = req.params;
    const {
        instanceNumber,
        imageComments,
        viewPosition,
    } = req.body || {};
    const replace = {};
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'instanceNumber')) {
        replace.InstanceNumber = instanceNumber || '';
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'imageComments')) {
        replace.ImageComments = imageComments || '';
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'viewPosition')) {
        replace.ViewPosition = viewPosition || '';
    }
    if (!Object.keys(replace).length) {
        return res.status(400).json({ error: 'No fields to update' });
    }
    try {
        const updated = await dicomwebPacs.updateInstanceMetadata(studyInstanceUid, seriesInstanceUid, sopInstanceUid, replace);
        orthancIdCache.delete(`instance:${sopInstanceUid}`);
        clearQidoCache();
        await writeAuditLog(req, {
            eventType: 'dicom_update_instance_metadata',
            outcome: 'success',
            studyInstanceUid,
            seriesInstanceUid,
            sopInstanceUid,
            targetType: 'instance',
            targetId: sopInstanceUid,
            details: { fields: Object.keys(replace), replace },
        });
        res.json({ ok: true, ...updated });
    } catch (err) {
        await writeAuditLog(req, {
            eventType: 'dicom_update_instance_metadata',
            outcome: 'failure',
            studyInstanceUid,
            seriesInstanceUid,
            sopInstanceUid,
            targetType: 'instance',
            targetId: sopInstanceUid,
            details: { fields: Object.keys(replace), attempted: replace, error: err.message || 'Failed to update image' },
        });
        res.status(err.status || 500).json({ error: err.message || 'Failed to update image' });
    }
});

app.post('/api/dicom/studies', requireAnyPermission('edit_metadata', 'view_dicom_manager'), async (req, res) => {
    try {
        const created = await dicomwebPacs.createStudyPlaceholder(req.body || {});
        clearQidoCache();
        await writeAuditLog(req, {
            eventType: 'dicom_create_study',
            outcome: 'success',
            studyInstanceUid: created.studyInstanceUid,
            targetType: 'study',
            targetId: created.studyInstanceUid,
            details: { payload: req.body || {} },
        });
        res.status(201).json({ ok: true, ...created });
    } catch (err) {
        await writeAuditLog(req, {
            eventType: 'dicom_create_study',
            outcome: 'failure',
            targetType: 'study',
            details: { payload: req.body || {}, error: err.message || 'Failed to create study' },
        });
        res.status(err.status || 500).json({ error: err.message || 'Failed to create study' });
    }
});

app.post('/api/dicom/studies/:studyInstanceUid/series', requireAnyPermission('edit_metadata', 'view_dicom_manager'), async (req, res) => {
    const { studyInstanceUid } = req.params;
    try {
        const created = await dicomwebPacs.createSeriesPlaceholder(studyInstanceUid, req.body || {});
        orthancIdCache.delete(`study:${studyInstanceUid}`);
        clearQidoCache();
        await writeAuditLog(req, {
            eventType: 'dicom_create_series',
            outcome: 'success',
            studyInstanceUid,
            seriesInstanceUid: created.seriesInstanceUid,
            targetType: 'series',
            targetId: created.seriesInstanceUid,
            details: { payload: req.body || {} },
        });
        res.status(201).json({ ok: true, ...created });
    } catch (err) {
        await writeAuditLog(req, {
            eventType: 'dicom_create_series',
            outcome: 'failure',
            studyInstanceUid,
            targetType: 'series',
            details: { payload: req.body || {}, error: err.message || 'Failed to create series' },
        });
        res.status(err.status || 500).json({ error: err.message || 'Failed to create series' });
    }
});

app.post('/api/dicom/studies/:studyInstanceUid/series/:seriesInstanceUid/instances/upload-image', requireAnyPermission('edit_metadata', 'view_dicom_manager'), async (req, res) => {
    const { studyInstanceUid, seriesInstanceUid } = req.params;
    try {
        const created = await dicomwebPacs.createImageFromUpload(studyInstanceUid, seriesInstanceUid, req.body || {});
        orthancIdCache.delete(`study:${studyInstanceUid}`);
        orthancIdCache.delete(`series:${seriesInstanceUid}`);
        clearQidoCache();
        const mwlReconcile = await safeReconcileMwlOrderForManagerStudy(studyInstanceUid, {
            req,
            method: 'dicom_manager_upload_image',
            message: 'Study completed by DICOM Manager image upload',
            details: { seriesInstanceUid, sopInstanceUid: created.sopInstanceUid },
        });
        await writeAuditLog(req, {
            eventType: 'dicom_create_image',
            outcome: 'success',
            studyInstanceUid,
            seriesInstanceUid,
            sopInstanceUid: created.sopInstanceUid,
            targetType: 'instance',
            targetId: created.sopInstanceUid,
            details: {
                fileName: req.body?.fileName || null,
                mimeType: req.body?.mimeType || null,
                rows: created.rows,
                columns: created.columns,
                mwlReconcile,
            },
        });
        res.status(201).json({ ok: true, ...created });
    } catch (err) {
        await writeAuditLog(req, {
            eventType: 'dicom_create_image',
            outcome: 'failure',
            studyInstanceUid,
            seriesInstanceUid,
            targetType: 'instance',
            details: {
                fileName: req.body?.fileName || null,
                mimeType: req.body?.mimeType || null,
                error: err.message || 'Failed to create image',
            },
        });
        res.status(err.status || 500).json({ error: err.message || 'Failed to create image' });
    }
});

async function ensureManagerTargetStudyPlaceholder(studyInstanceUid) {
    const uid = String(studyInstanceUid || '').trim();
    if (!uid) return;
    const [rows] = await pool.query(
        `
        SELECT o.*, p.no_rm, p.nama_pasien, p.tanggal_lahir, p.kelamin
        FROM mwl_orders o
        INNER JOIN patients p ON p.id = o.patient_record_id
        WHERE o.study_instance_uid = ? OR o.actual_study_instance_uid = ?
        ORDER BY o.updated_at DESC, o.id DESC
        LIMIT 1
        `,
        [uid, uid]
    );
    const order = rows[0];
    if (!order) return;
    await dicomwebPacs.createScheduledStudyPlaceholder({
        studyInstanceUid: uid,
        patientId: order.no_rm,
        patientName: order.nama_pasien,
        patientBirthDate: toDicomDate(order.tanggal_lahir),
        patientSex: order.kelamin || 'O',
        accessionNumber: order.accession_number,
        studyDate: toDicomDate(order.study_date || order.tanggal_aktivasi || order.tanggal_order || order.created_at),
        studyTime: order.study_time,
        modality: order.modality,
        studyDescription: order.procedure_desc || order.nama_pemeriksaan,
        studyId: order.no_rontgen || order.accession_number,
        referringPhysician: order.referring_physician || order.nama_dokter,
    });
}

app.get(
    '/api/dicom/manager/operations',
    requireAnyPermission('view_dicom_manager', 'restore_dicom_manager_operation'),
    async (req, res) => {
        try {
            const operations = await dicomwebPacs.listManagerOperations({
                studyUid: req.query.studyInstanceUid || req.query.studyUid || null,
                status: req.query.status || null,
                limit: req.query.limit || 100,
            });
            res.json({ operations });
        } catch (err) {
            res.status(err.status || 500).json({ error: err.message || 'Failed to load DICOM Manager history' });
        }
    }
);

app.post(
    '/api/dicom/manager/operations/:operationId/cancel',
    requireAnyPermission('edit_metadata', 'view_dicom_manager'),
    async (req, res) => {
        try {
            const result = await dicomwebPacs.requestManagerOperationCancel(req.params.operationId);
            await writeAuditLog(req, {
                eventType: 'dicom_manager_cancel_request',
                outcome: result.requested ? 'success' : 'failure',
                targetType: 'manager_operation',
                targetId: req.params.operationId,
                details: { reason: String(req.body?.reason || 'Operator requested cancellation'), requested: result.requested },
            });
            res.json({ ok: result.requested, ...result });
        } catch (err) {
            res.status(err.status || 500).json({ error: err.message || 'Failed to request cancellation' });
        }
    }
);

app.post(
    '/api/dicom/manager/studies/:studyInstanceUid/reindex',
    requireAnyPermission('edit_metadata', 'view_dicom_manager'),
    async (req, res) => {
        const studyInstanceUid = String(req.params.studyInstanceUid || '').trim();
        // `wait=1` keeps the old synchronous behaviour for scripts and support probes.
        const waitForResult = ['1', 'true', 'yes'].includes(String(req.query?.wait || req.body?.wait || '').toLowerCase());
        try {
            if (!studyInstanceUid) {
                return res.status(400).json({ error: 'studyInstanceUid is required' });
            }
            // Scoped re-index of one study: the recovery path for images that stayed
            // in the archive without being indexed ("unindexed"/"skipped" in history).
            const mode = req.body?.mode === 'store' ? 'store' : undefined;
            const reason = String(req.body?.reason || 'Operator re-indexed the study from DICOM Manager');
            const journal = await dicomwebPacs.beginReindexOperation({
                studyInstanceUid,
                username: getUsernameFromRequest(req),
                reason,
            });
            const run = () => dicomwebPacs.runReindexOperation(journal.operationId, studyInstanceUid, { mode });
            const audit = (refresh, status) => writeAuditLog(req, {
                eventType: 'dicom_manager_reindex',
                // Only a clean `refreshed` is a success: the `refreshed-with-*` statuses
                // mean files are still missing from the index and need an operator.
                outcome: String(refresh?.status || '') === 'refreshed' ? 'success' : (status === 'cancelled' ? 'cancelled' : 'failure'),
                studyInstanceUid,
                targetType: 'manager_operation',
                targetId: journal.operationId,
                details: { reason, status: refresh?.status || status || null, mode: refresh?.mode || mode || null, reindex: refresh?.reindex || null },
            }).catch(() => {});

            if (!waitForResult) {
                // Re-indexing a large study takes minutes: answer immediately and let the
                // client follow the operation (progress columns + GET operations).
                void run()
                    .then(result => {
                        clearQidoCache();
                        orthancIdCache.clear();
                        return audit(result.refresh, result.operationStatus);
                    })
                    .catch(error => audit({ status: 'failed', message: error?.message || String(error) }, 'failed'));
                return res.status(202).json({
                    ok: true,
                    accepted: true,
                    studyInstanceUid,
                    operationId: journal.operationId,
                    status: 'running',
                });
            }

            const result = await run();
            clearQidoCache();
            orthancIdCache.clear();
            await audit(result.refresh, result.operationStatus);
            const refreshed = String(result.refresh?.status || '') === 'refreshed';
            res.json({
                ok: refreshed,
                studyInstanceUid,
                operationId: journal.operationId,
                status: result.operationStatus,
                refresh: result.refresh,
            });
        } catch (err) {
            await writeAuditLog(req, {
                eventType: 'dicom_manager_reindex',
                outcome: 'failure',
                studyInstanceUid,
                targetType: 'study',
                targetId: studyInstanceUid,
                details: { error: err.message || 'Study re-index failed' },
            }).catch(() => {});
            res.status(err.status || 500).json({ error: err.message || 'Failed to re-index the study' });
        }
    }
);

app.get(
    '/api/dicom/manager/operations/:operationId/restore-preflight',
    requireAnyPermission('view_dicom_manager', 'restore_dicom_manager_operation'),
    async (req, res) => {
        try {
            res.json(await dicomwebPacs.preflightManagerOperationRestore(req.params.operationId));
        } catch (err) {
            res.status(err.status || 500).json({ error: err.message || 'Failed to check restore readiness' });
        }
    }
);

app.get(
    '/api/dicom/manager/operations/:operationId',
    requireAnyPermission('view_dicom_manager', 'restore_dicom_manager_operation'),
    async (req, res) => {
        try {
            res.json({ operation: await dicomwebPacs.getManagerOperation(req.params.operationId) });
        } catch (err) {
            res.status(err.status || 500).json({ error: err.message || 'Failed to load DICOM Manager operation' });
        }
    }
);

app.post(
    '/api/dicom/manager/operations/:operationId/restore',
    requirePermission('restore_dicom_manager_operation'),
    async (req, res) => {
        const reason = String(req.body?.reason || '').trim();
        let operation = null;
        try {
            operation = await dicomwebPacs.getManagerOperation(req.params.operationId);
            const restored = await dicomwebPacs.restoreManagerOperation(req.params.operationId, {
                username: getUsernameFromRequest(req),
                reason,
            });
            orthancIdCache.clear();
            clearQidoCache();
            await writeAuditLog(req, {
                eventType: 'dicom_manager_restore',
                outcome: 'success',
                studyInstanceUid: operation.sourceStudyUid,
                seriesInstanceUid: operation.sourceSeriesUid,
                sopInstanceUid: operation.sourceSopUid,
                targetType: operation.operationType,
                targetId: operation.id,
                details: {
                    reason,
                    operationId: operation.id,
                    restoreOperationId: restored.restoreOperationId,
                    restoredObjectCount: restored.restoredObjectCount,
                },
            });
            res.json({ ok: true, ...restored });
        } catch (err) {
            await writeAuditLog(req, {
                eventType: 'dicom_manager_restore',
                outcome: 'failure',
                studyInstanceUid: operation?.sourceStudyUid || null,
                seriesInstanceUid: operation?.sourceSeriesUid || null,
                sopInstanceUid: operation?.sourceSopUid || null,
                targetType: operation?.operationType || 'manager_operation',
                targetId: req.params.operationId,
                details: {
                    reason,
                    operationId: req.params.operationId,
                    conflicts: err.conflicts || null,
                    error: err.message || 'Failed to restore DICOM Manager operation',
                },
            });
            res.status(err.status || 500).json({
                error: err.message || 'Failed to restore DICOM Manager operation',
                ...(err.conflicts ? { conflicts: err.conflicts } : {}),
            });
        }
    }
);

app.post('/api/dicom/studies/:studyInstanceUid/move', requireAnyPermission('edit_metadata', 'view_dicom_manager'), async (req, res) => {
    const { studyInstanceUid } = req.params;
    const targetStudyInstanceUid = String(req.body?.targetStudyInstanceUid || req.body?.targetStudyUid || '').trim();
    const reason = String(req.body?.reason || 'DICOM Manager drag-and-drop study bind').trim();
    if (!targetStudyInstanceUid) {
        return res.status(400).json({ error: 'targetStudyInstanceUid is required' });
    }
    let managerOperation = null;
    try {
        managerOperation = await dicomwebPacs.beginManagerOperation({
            operationType: 'study_merge',
            sourceStudyUid: studyInstanceUid,
            targetStudyUid: targetStudyInstanceUid,
            username: getUsernameFromRequest(req),
            reason,
            input: { targetStudyInstanceUid },
        });
        await ensureManagerTargetStudyPlaceholder(targetStudyInstanceUid);
        const moved = await dicomwebPacs.moveStudyToStudy(studyInstanceUid, targetStudyInstanceUid, {
            operationId: managerOperation.operationId,
            expectedInstances: managerOperation.manifest?.entries?.length || 0,
        });
        if (moved.cancelled) {
            const cancelled = await dicomwebPacs.cancelManagerOperation(managerOperation.operationId, moved);
            orthancIdCache.delete(`study:${studyInstanceUid}`);
            orthancIdCache.delete(`study:${targetStudyInstanceUid}`);
            clearQidoCache();
            await writeAuditLog(req, {
                eventType: 'dicom_move_study',
                outcome: 'cancelled',
                studyInstanceUid,
                targetType: 'study',
                targetId: studyInstanceUid,
                details: {
                    reason,
                    sourceStudyInstanceUid: studyInstanceUid,
                    targetStudyInstanceUid,
                    movedSeriesCount: moved.movedSeriesCount || 0,
                    movedInstanceCount: moved.movedInstanceCount || 0,
                    pendingSeriesCount: moved.pendingSeriesUids?.length || 0,
                    pendingSeriesUids: (moved.pendingSeriesUids || []).slice(0, 50),
                    skippedInstanceCount: moved.skippedInstances?.length || 0,
                    managerOperationId: managerOperation.operationId,
                    status: cancelled.status,
                },
            });
            return res.json({ ok: true, cancelled: true, ...moved, managerOperationId: managerOperation.operationId });
        }
        await dicomwebPacs.completeManagerOperation(managerOperation.operationId, moved);
        orthancIdCache.delete(`study:${studyInstanceUid}`);
        orthancIdCache.delete(`study:${targetStudyInstanceUid}`);
        clearQidoCache();
        const mwlReconcile = await safeReconcileMwlOrderForManagerStudy(targetStudyInstanceUid, {
            req,
            method: 'dicom_manager_move_study',
            message: 'Study completed by DICOM Manager study merge',
            details: { sourceStudyInstanceUid: studyInstanceUid },
        });
        await writeAuditLog(req, {
            eventType: 'dicom_move_study',
            outcome: 'success',
            studyInstanceUid,
            targetType: 'study',
            targetId: studyInstanceUid,
            details: {
                reason,
                sourceStudyInstanceUid: studyInstanceUid,
                targetStudyInstanceUid,
                movedSeriesCount: moved.movedSeries?.length || 0,
                movedInstanceCount: moved.movedInstanceCount || 0,
                skippedInstanceCount: moved.skippedInstances?.length || 0,
                skippedInstances: (moved.skippedInstances || []).slice(0, 20),
                sourceStudyRemoved: moved.sourceStudyRemoved,
                targetRefreshStatus: moved.targetRefresh?.status || null,
                targetRefreshMode: moved.targetRefresh?.mode || null,
                managerOperationId: managerOperation.operationId,
                mwlReconcile,
            },
        });
        res.json({ ok: true, ...moved, managerOperationId: managerOperation.operationId });
    } catch (err) {
        await dicomwebPacs.failManagerOperation(managerOperation?.operationId, err);
        await writeAuditLog(req, {
            eventType: 'dicom_move_study',
            outcome: 'failure',
            studyInstanceUid,
            targetType: 'study',
            targetId: studyInstanceUid,
            details: {
                reason,
                sourceStudyInstanceUid: studyInstanceUid,
                targetStudyInstanceUid,
                managerOperationId: managerOperation?.operationId || null,
                error: err.message || 'Failed to move study',
            },
        });
        res.status(err.status || 500).json({ error: err.message || 'Failed to move study' });
    }
});

app.post('/api/dicom/studies/:studyInstanceUid/series/:seriesInstanceUid/move', requireAnyPermission('edit_metadata', 'view_dicom_manager'), async (req, res) => {
    const { studyInstanceUid, seriesInstanceUid } = req.params;
    const targetStudyInstanceUid = String(req.body?.targetStudyInstanceUid || req.body?.targetStudyUid || '').trim();
    const reason = String(req.body?.reason || 'DICOM Manager drag-and-drop series move').trim();
    if (!targetStudyInstanceUid) {
        return res.status(400).json({ error: 'targetStudyInstanceUid is required' });
    }
    let managerOperation = null;
    try {
        managerOperation = await dicomwebPacs.beginManagerOperation({
            operationType: 'series_move',
            sourceStudyUid: studyInstanceUid,
            sourceSeriesUid: seriesInstanceUid,
            targetStudyUid: targetStudyInstanceUid,
            username: getUsernameFromRequest(req),
            reason,
            input: { targetStudyInstanceUid },
        });
        await ensureManagerTargetStudyPlaceholder(targetStudyInstanceUid);
        const moved = await dicomwebPacs.moveSeriesToStudy(studyInstanceUid, seriesInstanceUid, targetStudyInstanceUid);
        await dicomwebPacs.completeManagerOperation(managerOperation.operationId, moved);
        orthancIdCache.delete(`series:${seriesInstanceUid}`);
        orthancIdCache.delete(`study:${studyInstanceUid}`);
        orthancIdCache.delete(`study:${targetStudyInstanceUid}`);
        clearQidoCache();
        const mwlReconcile = await safeReconcileMwlOrderForManagerStudy(targetStudyInstanceUid, {
            req,
            method: 'dicom_manager_move_series',
            message: 'Study completed by DICOM Manager series merge',
            details: { sourceStudyInstanceUid: studyInstanceUid, sourceSeriesInstanceUid: seriesInstanceUid },
        });
        await writeAuditLog(req, {
            eventType: 'dicom_move_series',
            outcome: 'success',
            studyInstanceUid,
            seriesInstanceUid,
            targetType: 'series',
            targetId: seriesInstanceUid,
            details: {
                reason,
                sourceStudyInstanceUid: studyInstanceUid,
                targetStudyInstanceUid,
                movedInstances: moved.movedInstances?.map(item => item.sopInstanceUid) || [],
                sourceStudyRemoved: moved.sourceStudyRemoved,
                managerOperationId: managerOperation.operationId,
                mwlReconcile,
            },
        });
        res.json({ ok: true, ...moved, managerOperationId: managerOperation.operationId });
    } catch (err) {
        await dicomwebPacs.failManagerOperation(managerOperation?.operationId, err);
        await writeAuditLog(req, {
            eventType: 'dicom_move_series',
            outcome: 'failure',
            studyInstanceUid,
            seriesInstanceUid,
            targetType: 'series',
            targetId: seriesInstanceUid,
            details: {
                reason,
                sourceStudyInstanceUid: studyInstanceUid,
                targetStudyInstanceUid,
                managerOperationId: managerOperation?.operationId || null,
                error: err.message || 'Failed to move series',
            },
        });
        res.status(err.status || 500).json({ error: err.message || 'Failed to move series' });
    }
});

app.post('/api/dicom/studies/:studyInstanceUid/series/:seriesInstanceUid/instances/:sopInstanceUid/move', requireAnyPermission('edit_metadata', 'view_dicom_manager'), async (req, res) => {
    const { studyInstanceUid, seriesInstanceUid, sopInstanceUid } = req.params;
    const targetStudyInstanceUid = String(req.body?.targetStudyInstanceUid || req.body?.targetStudyUid || '').trim();
    const targetSeriesInstanceUid = String(req.body?.targetSeriesInstanceUid || req.body?.targetSeriesUid || '').trim();
    const reason = String(req.body?.reason || 'DICOM Manager drag-and-drop image move').trim();
    if (!targetStudyInstanceUid || !targetSeriesInstanceUid) {
        return res.status(400).json({ error: 'targetStudyInstanceUid and targetSeriesInstanceUid are required' });
    }
    let managerOperation = null;
    try {
        managerOperation = await dicomwebPacs.beginManagerOperation({
            operationType: 'instance_move',
            sourceStudyUid: studyInstanceUid,
            sourceSeriesUid: seriesInstanceUid,
            sourceSopUid: sopInstanceUid,
            targetStudyUid: targetStudyInstanceUid,
            targetSeriesUid: targetSeriesInstanceUid,
            username: getUsernameFromRequest(req),
            reason,
            input: { targetStudyInstanceUid, targetSeriesInstanceUid },
        });
        const moved = await dicomwebPacs.moveInstanceToSeries(
            studyInstanceUid,
            seriesInstanceUid,
            sopInstanceUid,
            targetStudyInstanceUid,
            targetSeriesInstanceUid
        );
        await dicomwebPacs.completeManagerOperation(managerOperation.operationId, moved);
        orthancIdCache.delete(`instance:${sopInstanceUid}`);
        orthancIdCache.delete(`series:${seriesInstanceUid}`);
        orthancIdCache.delete(`series:${targetSeriesInstanceUid}`);
        orthancIdCache.delete(`study:${studyInstanceUid}`);
        orthancIdCache.delete(`study:${targetStudyInstanceUid}`);
        clearQidoCache();
        const mwlReconcile = await safeReconcileMwlOrderForManagerStudy(targetStudyInstanceUid, {
            req,
            method: 'dicom_manager_move_image',
            message: 'Study completed by DICOM Manager image move',
            details: {
                sourceStudyInstanceUid: studyInstanceUid,
                sourceSeriesInstanceUid: seriesInstanceUid,
                sourceSopInstanceUid: sopInstanceUid,
                targetSeriesInstanceUid,
            },
        });
        await writeAuditLog(req, {
            eventType: 'dicom_move_instance',
            outcome: 'success',
            studyInstanceUid,
            seriesInstanceUid,
            sopInstanceUid,
            targetType: 'instance',
            targetId: sopInstanceUid,
            details: {
                reason,
                sourceStudyInstanceUid: studyInstanceUid,
                sourceSeriesInstanceUid: seriesInstanceUid,
                targetStudyInstanceUid,
                targetSeriesInstanceUid,
                sourceStudyRemoved: moved.sourceStudyRemoved,
                managerOperationId: managerOperation.operationId,
                mwlReconcile,
            },
        });
        res.json({ ok: true, ...moved, managerOperationId: managerOperation.operationId });
    } catch (err) {
        await dicomwebPacs.failManagerOperation(managerOperation?.operationId, err);
        await writeAuditLog(req, {
            eventType: 'dicom_move_instance',
            outcome: 'failure',
            studyInstanceUid,
            seriesInstanceUid,
            sopInstanceUid,
            targetType: 'instance',
            targetId: sopInstanceUid,
            details: {
                reason,
                sourceStudyInstanceUid: studyInstanceUid,
                sourceSeriesInstanceUid: seriesInstanceUid,
                targetStudyInstanceUid,
                targetSeriesInstanceUid,
                managerOperationId: managerOperation?.operationId || null,
                error: err.message || 'Failed to move image',
            },
        });
        res.status(err.status || 500).json({ error: err.message || 'Failed to move image' });
    }
});

app.delete('/api/dicom/studies/:studyInstanceUid/series/:seriesInstanceUid', requireAnyPermission('delete_series', 'view_dicom_manager'), async (req, res) => {
    const deleteReason = requireDeleteReason(req, res);
    if (!deleteReason) return;
    try {
        await dicomwebPacs.deleteSeries(
            req.params.studyInstanceUid,
            req.params.seriesInstanceUid
        );
        orthancIdCache.delete(`series:${req.params.seriesInstanceUid}`);
        clearQidoCache();
        await writeAuditLog(req, {
            eventType: 'dicom_delete_series',
            outcome: 'success',
            studyInstanceUid: req.params.studyInstanceUid,
            seriesInstanceUid: req.params.seriesInstanceUid,
            targetType: 'series',
            targetId: req.params.seriesInstanceUid,
            details: { deleteReason },
        });
        res.json({ ok: true });
    } catch (err) {
        await writeAuditLog(req, {
            eventType: 'dicom_delete_series',
            outcome: 'failure',
            studyInstanceUid: req.params.studyInstanceUid,
            seriesInstanceUid: req.params.seriesInstanceUid,
            targetType: 'series',
            targetId: req.params.seriesInstanceUid,
            details: { deleteReason, error: err.message || 'Failed to delete series' },
        });
        res.status(err.status || 500).json({ error: err.message || 'Failed to delete series' });
    }
});

app.delete(
    '/api/dicom/studies/:studyInstanceUid/series/:seriesInstanceUid/instances/:sopInstanceUid',
    requireAnyPermission('delete_instance', 'view_dicom_manager'),
    async (req, res) => {
        const deleteReason = requireDeleteReason(req, res);
        if (!deleteReason) return;
        try {
            await dicomwebPacs.deleteInstance(
                req.params.studyInstanceUid,
                req.params.seriesInstanceUid,
                req.params.sopInstanceUid
            );
            orthancIdCache.delete(`instance:${req.params.sopInstanceUid}`);
            clearQidoCache();
            await writeAuditLog(req, {
                eventType: 'dicom_delete_instance',
                outcome: 'success',
                studyInstanceUid: req.params.studyInstanceUid,
                seriesInstanceUid: req.params.seriesInstanceUid,
                sopInstanceUid: req.params.sopInstanceUid,
                targetType: 'instance',
                targetId: req.params.sopInstanceUid,
                details: { deleteReason },
            });
            res.json({ ok: true });
        } catch (err) {
            await writeAuditLog(req, {
                eventType: 'dicom_delete_instance',
                outcome: 'failure',
                studyInstanceUid: req.params.studyInstanceUid,
                seriesInstanceUid: req.params.seriesInstanceUid,
                sopInstanceUid: req.params.sopInstanceUid,
                targetType: 'instance',
                targetId: req.params.sopInstanceUid,
                details: { deleteReason, error: err.message || 'Failed to delete instance' },
            });
            res.status(err.status || 500).json({ error: err.message || 'Failed to delete instance' });
        }
    }
);

app.get('/api/dicom/studies/:studyInstanceUid/archive', requirePermission('download_study'), async (req, res) => {
    try {
        const buffer = await dicomwebPacs.archiveStudy(req.params.studyInstanceUid);
        await writeAuditLog(req, {
            eventType: 'dicom_download_archive',
            outcome: 'success',
            studyInstanceUid: req.params.studyInstanceUid,
            targetType: 'study',
            targetId: req.params.studyInstanceUid,
            details: { bytes: buffer.length },
        });
        res.set('Content-Type', 'application/zip');
        res.set(
            'Content-Disposition',
            `attachment; filename="${req.params.studyInstanceUid}.zip"`
        );
        res.send(buffer);
    } catch (err) {
        await writeAuditLog(req, {
            eventType: 'dicom_download_archive',
            outcome: 'failure',
            studyInstanceUid: req.params.studyInstanceUid,
            targetType: 'study',
            targetId: req.params.studyInstanceUid,
            details: { error: err.message || 'Failed to resolve archive URL' },
        });
        res.status(err.status || 500).json({ error: err.message || 'Failed to resolve archive URL' });
    }
});

function getDicomAuditString(record, tagId) {
    const value = record?.[tagId]?.Value?.[0];
    if (value && typeof value === 'object' && value.Alphabetic) {
        return String(value.Alphabetic);
    }
    return value === undefined || value === null ? '' : String(value);
}

function buildAuditStudyInfo(record) {
    if (!record) return null;
    return {
        patient_id: getDicomAuditString(record, '00100020'),
        patient_name: getDicomAuditString(record, '00100010'),
        other_patient_ids: getDicomAuditString(record, '00101000'),
        patient_birth_date: getDicomAuditString(record, '00100030'),
        patient_sex: getDicomAuditString(record, '00100040'),
        accession_number: getDicomAuditString(record, '00080050'),
        institution_name: getDicomAuditString(record, '00080080'),
        study_description: getDicomAuditString(record, '00081030'),
        referring_physician: getDicomAuditString(record, '00080090'),
        modality: getDicomAuditString(record, '00080061') || getDicomAuditString(record, '00080060'),
        study_date: getDicomAuditString(record, '00080020'),
        study_time: getDicomAuditString(record, '00080030'),
        study_id: getDicomAuditString(record, '00200010'),
    };
}

const auditMetadataFieldMap = {
    PatientName: ['Patient Name', 'patient_name'],
    PatientID: ['Patient ID', 'patient_id'],
    OtherPatientIDs: ['Other Patient IDs', 'other_patient_ids'],
    PatientBirthDate: ['Patient Birth Date', 'patient_birth_date'],
    PatientSex: ['Patient Sex', 'patient_sex'],
    AccessionNumber: ['Accession', 'accession_number'],
    InstitutionName: ['Institution', 'institution_name'],
    StudyDescription: ['Study Description', 'study_description'],
    ReferringPhysicianName: ['Referring Physician', 'referring_physician'],
    StudyDate: ['Study Date', 'study_date'],
    StudyTime: ['Study Time', 'study_time'],
    StudyID: ['Study ID', 'study_id'],
};

function buildAuditMetadataChanges(replace, beforeInfo, afterInfo) {
    const changes = {};
    for (const [keyword, requestedValue] of Object.entries(replace || {})) {
        const [label, infoKey] = auditMetadataFieldMap[keyword] || [keyword, keyword];
        const beforeValue = beforeInfo?.[infoKey] || '';
        const afterValue = afterInfo?.[infoKey] ?? requestedValue ?? '';
        changes[keyword] = {
            label,
            from: beforeValue,
            to: afterValue,
        };
    }
    return changes;
}

async function getAuditStudyInfo(studyInstanceUid) {
    const studyUid = String(studyInstanceUid || '').trim();
    if (!studyUid) return null;
    try {
        const result = await dicomwebPacs.getStudies({ StudyInstanceUID: studyUid, fresh: '1' });
        const record = (result.data || []).find(item => getDicomAuditString(item, '0020000D') === studyUid);
        return buildAuditStudyInfo(record);
    } catch (error) {
        console.warn('[audit] failed to capture study snapshot:', error.message);
        return null;
    }
}

function parseAuditDetails(details) {
    if (!details) return null;
    if (typeof details === 'object') return details;
    try {
        return JSON.parse(details);
    } catch {
        return null;
    }
}

async function enrichAuditLogs(rows) {
    const studyUids = Array.from(
        new Set(
            rows
                .map(row => String(row.study_instance_uid || '').trim())
                .filter(Boolean)
        )
    );
    if (!studyUids.length) return rows;

    const studyMap = new Map();
    try {
        const result = await dicomwebPacs.getStudies({ fresh: '1' });
        for (const record of result.data || []) {
            const studyUid = getDicomAuditString(record, '0020000D');
            if (!studyUid || !studyUids.includes(studyUid)) continue;
            studyMap.set(studyUid, buildAuditStudyInfo(record));
        }
    } catch (error) {
        console.warn('[audit] failed to enrich audit logs from dicomweb-pacs:', error.message);
    }

    return rows.map(row => {
        const details = parseAuditDetails(row.details_json);
        const snapshot = details?.studyInfo || null;
        return {
            ...row,
            study_info: row.study_instance_uid
                ? studyMap.get(String(row.study_instance_uid)) || snapshot || null
                : snapshot,
        };
    });
}

app.get('/api/audit-logs', requirePermission('view_settings'), async (req, res) => {
    try {
        await ensureAuditLogTable();
        const limitRaw = Number(req.query.limit || 100);
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 500) : 100;
        const params = [];
        const where = [];
        if (typeof req.query.studyInstanceUid === 'string' && req.query.studyInstanceUid.trim()) {
            where.push('study_instance_uid = ?');
            params.push(req.query.studyInstanceUid.trim());
        }
        if (typeof req.query.eventType === 'string' && req.query.eventType.trim()) {
            where.push('event_type = ?');
            params.push(req.query.eventType.trim());
        }
        if (typeof req.query.username === 'string' && req.query.username.trim()) {
            where.push('username = ?');
            params.push(req.query.username.trim());
        }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        params.push(limit);
        const [rows] = await pool.query(
            `
            SELECT id, event_type, outcome, username, role, ip_address, user_agent,
                   study_instance_uid, series_instance_uid, sop_instance_uid,
                   target_type, target_id, details_json, created_at
            FROM audit_logs
            ${whereSql}
            ORDER BY created_at DESC, id DESC
            LIMIT ?
            `,
            params
        );
        res.json({ logs: await enrichAuditLogs(rows) });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to load audit logs' });
    }
});

app.get('/api/dicom/studies/:studyInstanceUid/archive', requirePermission('download_study'), async (req, res) => {
    try {
        const buffer = await dicomwebPacs.archiveStudy(req.params.studyInstanceUid);
        await writeAuditLog(req, {
            eventType: 'dicom_download_archive',
            outcome: 'success',
            studyInstanceUid: req.params.studyInstanceUid,
            targetType: 'study',
            targetId: req.params.studyInstanceUid,
            details: { bytes: buffer.length },
        });
        res.set('Content-Type', 'application/zip');
        res.set(
            'Content-Disposition',
            `attachment; filename="${req.params.studyInstanceUid}.zip"`
        );
        res.send(buffer);
    } catch (err) {
        await writeAuditLog(req, {
            eventType: 'dicom_download_archive',
            outcome: 'failure',
            studyInstanceUid: req.params.studyInstanceUid,
            targetType: 'study',
            targetId: req.params.studyInstanceUid,
            details: { error: err.message || 'Failed to resolve archive URL' },
        });
        res.status(err.status || 500).json({ error: err.message || 'Failed to resolve archive URL' });
    }
});

function getDicomAuditString(record, tagId) {
    const value = record?.[tagId]?.Value?.[0];
    if (value && typeof value === 'object' && value.Alphabetic) {
        return String(value.Alphabetic);
    }
    return value === undefined || value === null ? '' : String(value);
}

function buildAuditStudyInfo(record) {
    if (!record) return null;
    return {
        patient_id: getDicomAuditString(record, '00100020'),
        patient_name: getDicomAuditString(record, '00100010'),
        other_patient_ids: getDicomAuditString(record, '00101000'),
        patient_birth_date: getDicomAuditString(record, '00100030'),
        patient_sex: getDicomAuditString(record, '00100040'),
        accession_number: getDicomAuditString(record, '00080050'),
        institution_name: getDicomAuditString(record, '00080080'),
        study_description: getDicomAuditString(record, '00081030'),
        referring_physician: getDicomAuditString(record, '00080090'),
        modality: getDicomAuditString(record, '00080061') || getDicomAuditString(record, '00080060'),
        study_date: getDicomAuditString(record, '00080020'),
        study_time: getDicomAuditString(record, '00080030'),
        study_id: getDicomAuditString(record, '00200010'),
    };
}


const toNumber = value => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
};

const normalizeSystemLogRows = rows =>
    (rows || []).map(row => ({
        ...row,
        id: toNumber(row.id),
        count: row.count === undefined ? undefined : toNumber(row.count),
    }));

function defaultBackupConfig() {
    return {
        backupRoot: 'D:\\VEXAPACS-Backup',
        dataPath: process.env.DICOMWEB_PACS_STORAGE_PATH || process.env.DICOM_STORAGE_PATH || path.resolve(__dirname, '..', '..', 'DATA'),
        programDataPath: PROGRAM_DATA_DIR,
        includeDicomData: true,
        includeProgramData: true,
        postgres: {
            host: process.env.PACS_DB_HOST || process.env.DB_HOST || 'localhost',
            port: Number(process.env.PACS_DB_PORT || process.env.DB_PORT || 5432),
            user: process.env.PACS_DB_USER || process.env.DB_USER || 'postgres',
            password: process.env.PACS_DB_PASS || process.env.DB_PASS || 'velo',
            risDb: process.env.DB_NAME || 'vexaris_db',
            pacsDb: process.env.PACS_DB_NAME || 'vexapacs_db',
            binPath: process.env.POSTGRES_BIN_PATH || '',
        },
        services: [
            'VexaRISBackend',
            'VexaRISFrontend',
            'VexaPacsDicomweb',
            'VexaPacsDimse',
            'VexaMwlService',
            'VexaDesktopViewer',
            'VexaMobileViewer',
            'VexaEcgViewer',
            'VexaCaddy',
        ],
        retention: { keepLast: 7 },
        schedule: {
            // Enabled by default: a fresh install must have a restore point
            // without anyone remembering to open Backup & Restore first. The
            // installer registers the Windows task immediately after install
            // (installer/scripts/backup/register-backup-task.ps1); an operator
            // can still turn it off from the Backup & Restore page.
            enabled: true,
            frequency: 'daily',
            time: '23:00',
            interval: 1,
            daysOfWeek: ['MON'],
            dayOfMonth: 1,
        },
    };
}

function ensureBackupConfigFile() {
    fs.mkdirSync(path.dirname(BACKUP_CONFIG_PATH), { recursive: true });
    if (!fs.existsSync(BACKUP_CONFIG_PATH)) {
        fs.writeFileSync(BACKUP_CONFIG_PATH, JSON.stringify(defaultBackupConfig(), null, 2), 'utf8');
    }
}

function readBackupConfig() {
    ensureBackupConfigFile();
    try {
        const parsed = JSON.parse(fs.readFileSync(BACKUP_CONFIG_PATH, 'utf8'));
        return {
            ...defaultBackupConfig(),
            ...parsed,
            postgres: {
                ...defaultBackupConfig().postgres,
                ...(parsed.postgres || {}),
            },
            retention: {
                ...defaultBackupConfig().retention,
                ...(parsed.retention || {}),
            },
            schedule: {
                ...defaultBackupConfig().schedule,
                ...(parsed.schedule || {}),
            },
        };
    } catch {
        return defaultBackupConfig();
    }
}

const BACKUP_SCHEDULE_DAYS = new Set(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']);

function normalizeBackupSchedule(input, current = defaultBackupConfig().schedule) {
    const source = input && typeof input === 'object' ? input : {};
    const frequency = ['daily', 'weekly', 'monthly'].includes(String(source.frequency || '').toLowerCase())
        ? String(source.frequency).toLowerCase()
        : current.frequency || 'daily';
    const time = /^\d{2}:\d{2}$/.test(String(source.time || ''))
        ? String(source.time)
        : current.time || '23:00';
    const [hour, minute] = time.split(':').map(Number);
    if (hour > 23 || minute > 59) {
        const error = new Error('Time must be in HH:mm format with valid values');
        error.status = 400;
        throw error;
    }
    const interval = Number.isFinite(Number(source.interval))
        ? Math.max(1, Math.min(365, Math.floor(Number(source.interval))))
        : Number(current.interval || 1);
    const daysOfWeekInput = Array.isArray(source.daysOfWeek) ? source.daysOfWeek : current.daysOfWeek;
    const daysOfWeek = (Array.isArray(daysOfWeekInput) ? daysOfWeekInput : [])
        .map(day => String(day).toUpperCase())
        .filter(day => BACKUP_SCHEDULE_DAYS.has(day));
    const dayOfMonth = Number.isFinite(Number(source.dayOfMonth))
        ? Math.max(1, Math.min(31, Math.floor(Number(source.dayOfMonth))))
        : Number(current.dayOfMonth || 1);
    return {
        enabled: source.enabled === undefined ? Boolean(current.enabled) : source.enabled !== false,
        frequency,
        time,
        interval,
        daysOfWeek: daysOfWeek.length ? daysOfWeek : ['MON'],
        dayOfMonth,
    };
}

function sanitizeBackupConfigPayload(payload) {
    const input = payload && typeof payload === 'object' ? payload : {};
    const current = readBackupConfig();
    const postgres = input.postgres && typeof input.postgres === 'object' ? input.postgres : {};
    const retention = input.retention && typeof input.retention === 'object' ? input.retention : {};
    const schedule = input.schedule && typeof input.schedule === 'object' ? input.schedule : current.schedule;
    return {
        backupRoot: normalizeNullableString(input.backupRoot, 500) || current.backupRoot,
        dataPath: normalizeNullableString(input.dataPath, 500) || current.dataPath,
        programDataPath: normalizeNullableString(input.programDataPath, 500) || current.programDataPath,
        includeDicomData: input.includeDicomData !== false,
        includeProgramData: input.includeProgramData !== false,
        postgres: {
            host: normalizeNullableString(postgres.host, 255) || current.postgres.host,
            port: Number.isFinite(Number(postgres.port)) ? Number(postgres.port) : Number(current.postgres.port || 5432),
            user: normalizeNullableString(postgres.user, 255) || current.postgres.user,
            password: typeof postgres.password === 'string' ? postgres.password : current.postgres.password,
            risDb: normalizeNullableString(postgres.risDb, 255) || current.postgres.risDb,
            pacsDb: normalizeNullableString(postgres.pacsDb, 255) || current.postgres.pacsDb,
            binPath: typeof postgres.binPath === 'string' ? postgres.binPath.trim() : current.postgres.binPath,
        },
        services: Array.isArray(input.services)
            ? input.services.map(item => normalizeNullableString(item, 120)).filter(Boolean)
            : current.services,
        retention: {
            keepLast: Number.isFinite(Number(retention.keepLast))
                ? Math.max(0, Math.floor(Number(retention.keepLast)))
                : Number(current.retention?.keepLast || 7),
        },
        schedule: normalizeBackupSchedule(schedule, current.schedule),
    };
}

function publicBackupConfig(config = readBackupConfig()) {
    return {
        ...config,
        postgres: {
            ...(config.postgres || {}),
            password: config.postgres?.password ? '********' : '',
            passwordConfigured: Boolean(config.postgres?.password),
        },
        configPath: BACKUP_CONFIG_PATH,
        backupScriptPath: BACKUP_SCRIPT_PATH,
        restoreScriptPath: RESTORE_SCRIPT_PATH,
    };
}

function writeBackupConfig(payload) {
    const normalized = sanitizeBackupConfigPayload(payload);
    fs.mkdirSync(path.dirname(BACKUP_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(BACKUP_CONFIG_PATH, JSON.stringify(normalized, null, 2), 'utf8');
    return normalized;
}

async function ensureBackupManagerTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS backup_settings (
        id INT PRIMARY KEY,
        config_json TEXT NOT NULL,
        updated_by VARCHAR(100) NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS backup_job_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        job_type VARCHAR(20) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'running',
        backup_path VARCHAR(1000) NULL,
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        finished_at TIMESTAMP NULL,
        exit_code INT NULL,
        progress_percent INT NULL,
        progress_message VARCHAR(255) NULL,
        output_tail TEXT NULL,
        config_json TEXT NULL,
        requested_by VARCHAR(100) NULL
      )
    `);
}

async function readBackupConfigFromDb() {
    await ensureBackupManagerTables();
    const [rows] = await pool.query('SELECT config_json FROM backup_settings WHERE id = 1 LIMIT 1');
    if (rows.length) {
        try {
            const parsed = parseJsonValue(rows[0].config_json, {});
            const normalized = sanitizeBackupConfigPayload(parsed);
            writeBackupConfig(normalized);
            return normalized;
        } catch (err) {
            console.error('[backup] invalid DB config, fallback to file:', err.message);
        }
    }
    const fileConfig = readBackupConfig();
    await writeBackupConfigToDb(fileConfig, 'system-bootstrap');
    return fileConfig;
}

async function writeBackupConfigToDb(config, username = null) {
    await ensureBackupManagerTables();
    const normalized = sanitizeBackupConfigPayload(config);
    writeBackupConfig(normalized);
    await pool.query(
        `
        INSERT INTO backup_settings (id, config_json, updated_by, updated_at)
        VALUES (1, ?, ?, CURRENT_TIMESTAMP)
        ON DUPLICATE KEY UPDATE
          config_json = VALUES(config_json),
          updated_by = VALUES(updated_by),
          updated_at = CURRENT_TIMESTAMP
        `,
        [JSON.stringify(normalized), username || null]
    );
    return normalized;
}

async function createBackupJobLog(type, config, req, backupPath = null) {
    await ensureBackupManagerTables();
    const [result] = await pool.query(
        `
        INSERT INTO backup_job_logs (job_type, status, backup_path, config_json, requested_by)
        VALUES (?, 'running', ?, ?, ?)
        `,
        [type, backupPath, JSON.stringify(config || {}), getUsernameFromRequest(req)]
    );
    return result.insertId || null;
}

async function updateBackupJobLog(logId, job) {
    if (!logId) return;
    try {
        await ensureBackupManagerTables();
        const progress = parseRuntimeProgress(job.output, job.running, job.exitCode);
        await pool.query(
            `
            UPDATE backup_job_logs
            SET status = ?,
                finished_at = ?,
                exit_code = ?,
                progress_percent = ?,
                progress_message = ?,
                output_tail = ?
            WHERE id = ?
            `,
            [
                job.running ? 'running' : (job.exitCode === 0 ? 'success' : 'failed'),
                job.running ? null : new Date(),
                job.exitCode ?? null,
                progress?.percent ?? null,
                progress?.message || null,
                String(job.output || '').slice(-8000),
                logId,
            ]
        );
    } catch (err) {
        console.error('[backup] failed to update job log:', err.message);
    }
}

async function listBackupJobLogs(limit = 50) {
    await ensureBackupManagerTables();
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    const [rows] = await pool.query(
        `
        SELECT id, job_type, status, backup_path, started_at, finished_at, exit_code,
               progress_percent, progress_message, requested_by
        FROM backup_job_logs
        ORDER BY id DESC
        LIMIT ?
        `,
        [safeLimit]
    );
    return rows;
}

function listBackupManifests(config = readBackupConfig()) {
    const backupRoot = String(config.backupRoot || '').trim();
    if (!backupRoot || !fs.existsSync(backupRoot)) return [];
    return fs.readdirSync(backupRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => {
            const backupPath = path.join(backupRoot, entry.name);
            const manifestPath = path.join(backupPath, 'manifest.json');
            if (!fs.existsSync(manifestPath)) return null;
            try {
                const manifestText = fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '');
                const manifest = JSON.parse(manifestText);
                return {
                    name: entry.name,
                    path: backupPath,
                    createdAt: manifest.createdAt || null,
                    backupVersion: manifest.backupVersion || null,
                    includeDicomData: Boolean(manifest.includeDicomData),
                    includeProgramData: Boolean(manifest.includeProgramData),
                    databases: manifest.databases || {},
                };
            } catch {
                return {
                    name: entry.name,
                    path: backupPath,
                    createdAt: null,
                    invalid: true,
                };
            }
        })
        .filter(Boolean)
        .sort((a, b) => String(b.name).localeCompare(String(a.name)));
}

function parseRuntimeProgress(output, running, exitCode) {
    const text = String(output || '');
    const matches = [...text.matchAll(/\[PROGRESS\]\s+(\d{1,3})\s+(.+)/g)];
    if (matches.length) {
        const latest = matches[matches.length - 1];
        return {
            percent: Math.max(0, Math.min(100, Number(latest[1]))),
            message: String(latest[2] || '').trim(),
        };
    }
    if (!running && exitCode === 0) return { percent: 100, message: 'Completed' };
    if (running) return { percent: 5, message: 'Running process...' };
    return null;
}

function backupJobStatus() {
    if (!backupRuntimeJob) return { running: false };
    return {
        running: backupRuntimeJob.running,
        type: backupRuntimeJob.type,
        startedAt: backupRuntimeJob.startedAt,
        finishedAt: backupRuntimeJob.finishedAt || null,
        exitCode: backupRuntimeJob.exitCode,
        error: backupRuntimeJob.error || null,
        output: backupRuntimeJob.output.slice(-8000),
        progress: parseRuntimeProgress(backupRuntimeJob.output, backupRuntimeJob.running, backupRuntimeJob.exitCode),
    };
}

function runPowerShellJob(type, scriptPath, args, logId = null) {
    if (backupRuntimeJob?.running) {
        const error = new Error(`${backupRuntimeJob.type} is already running`);
        error.status = 409;
        throw error;
    }
    if (!fs.existsSync(scriptPath)) {
        const error = new Error(`Script not found: ${scriptPath}`);
        error.status = 500;
        throw error;
    }
    const startedAt = new Date().toISOString();
    const child = spawn('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        ...args,
    ], {
        windowsHide: true,
    });
    const job = {
        running: true,
        type,
        startedAt,
        finishedAt: null,
        exitCode: null,
        output: '',
        child,
        logId,
    };
    backupRuntimeJob = job;
    const appendOutput = data => {
        job.output += data.toString();
        if (job.output.length > 12000) job.output = job.output.slice(-12000);
        void updateBackupJobLog(logId, job);
    };
    child.stdout.on('data', appendOutput);
    child.stderr.on('data', appendOutput);
    child.on('error', err => {
        job.running = false;
        job.finishedAt = new Date().toISOString();
        job.error = err.message;
        void updateBackupJobLog(logId, job);
    });
    child.on('close', code => {
        job.running = false;
        job.finishedAt = new Date().toISOString();
        job.exitCode = code;
        void updateBackupJobLog(logId, job);
    });
    return backupJobStatus();
}

function getBackupScheduleStatus() {
    try {
        const config = readBackupConfig();
        const configuredSchedule = normalizeBackupSchedule(config.schedule, defaultBackupConfig().schedule);
        const output = execFileSync('schtasks.exe', ['/Query', '/TN', BACKUP_TASK_NAME, '/FO', 'LIST'], {
            encoding: 'utf8',
            windowsHide: true,
        });
        return { ...configuredSchedule, enabled: true, taskName: BACKUP_TASK_NAME, raw: output };
    } catch (err) {
        let fallbackSchedule;
        try {
            fallbackSchedule = normalizeBackupSchedule(defaultBackupConfig().schedule, defaultBackupConfig().schedule);
        } catch {
            fallbackSchedule = {
                enabled: false,
                frequency: 'daily',
                time: '23:00',
                interval: 1,
                daysOfWeek: ['MON'],
                dayOfMonth: 1,
            };
        }
        return {
            ...fallbackSchedule,
            enabled: false,
            taskName: BACKUP_TASK_NAME,
            error: err?.message || 'Failed to read backup schedule',
        };
    }
}

function runBackupTaskScript(schedule) {
    const normalized = normalizeBackupSchedule(schedule, defaultBackupConfig().schedule);
    if (!fs.existsSync(BACKUP_TASK_SCRIPT_PATH)) {
        const error = new Error(`Register backup task script not found: ${BACKUP_TASK_SCRIPT_PATH}`);
        error.status = 500;
        throw error;
    }
    const args = [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', BACKUP_TASK_SCRIPT_PATH,
        '-TaskName', BACKUP_TASK_NAME,
        '-BackupScript', BACKUP_SCRIPT_PATH,
        '-ConfigPath', BACKUP_CONFIG_PATH,
        '-Frequency', normalized.frequency,
        '-Time', normalized.time,
        '-Interval', String(normalized.interval || 1),
        '-DayOfMonth', String(normalized.dayOfMonth || 1),
    ];
    if (normalized.frequency === 'weekly' && normalized.daysOfWeek.length) {
        args.push('-DaysOfWeek', normalized.daysOfWeek.join(','));
    }
    const output = execFileSync('powershell.exe', args, {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
    });
    const jsonLine = String(output || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.startsWith('{'))
        .pop();
    if (!jsonLine) {
        throw new Error(`Unexpected backup task registration output: ${String(output || '').slice(-500)}`);
    }
    return JSON.parse(jsonLine);
}

function createBackupSchedule(schedule) {
    const result = runBackupTaskScript(schedule);
    if (result?.warning) {
        console.warn(`[backup] ${result.warning}`);
    }
    return {
        runLevel: result.registeredAs || 'SYSTEM',
        runsWithoutUserLoggedOn: Boolean(result.runsWithoutUserLoggedOn),
        nextRunTime: result.nextRunTime || null,
        taskState: result.state || null,
        warning: result.warning || '',
    };
}

function removeBackupScheduleTask() {
    if (!fs.existsSync(BACKUP_TASK_SCRIPT_PATH)) {
        execFileSync('schtasks.exe', ['/Delete', '/TN', BACKUP_TASK_NAME, '/F'], { windowsHide: true });
        return;
    }
    try {
        execFileSync('powershell.exe', [
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-File', BACKUP_TASK_SCRIPT_PATH,
            '-TaskName', BACKUP_TASK_NAME,
            '-BackupScript', BACKUP_SCRIPT_PATH,
            '-ConfigPath', BACKUP_CONFIG_PATH,
            '-RemoveOnly',
        ], {
            encoding: 'utf8',
            windowsHide: true,
            maxBuffer: 4 * 1024 * 1024,
        });
    } catch (err) {
        execFileSync('schtasks.exe', ['/Delete', '/TN', BACKUP_TASK_NAME, '/F'], { windowsHide: true });
    }
}


app.get('/api/system-logs', requirePermission('view_settings'), async (req, res) => {
    const startedAt = Date.now();
    try {
        await ensureAuditLogTable();
        await pool.query('SELECT 1');
        const dbLatencyMs = Date.now() - startedAt;
        const memory = process.memoryUsage();

        const [auditSummaryRows] = await pool.query(`
            SELECT
              COUNT(*) AS total_events_24h,
              SUM(CASE WHEN outcome <> 'success' THEN 1 ELSE 0 END) AS failure_events_24h,
              SUM(CASE WHEN event_type = 'login' THEN 1 ELSE 0 END) AS login_events_24h,
              SUM(CASE WHEN event_type = 'login' AND outcome <> 'success' THEN 1 ELSE 0 END) AS failed_login_events_24h,
              COUNT(DISTINCT NULLIF(ip_address, '')) AS unique_ip_count_24h
            FROM audit_logs
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
        `);

        const [recentFailureRows] = await pool.query(`
            SELECT id, created_at, event_type, outcome, username, role, ip_address, target_type, target_id, details_json
            FROM audit_logs
            WHERE outcome <> 'success'
            ORDER BY created_at DESC, id DESC
            LIMIT 12
        `);

        const [recentSecurityRows] = await pool.query(`
            SELECT id, created_at, event_type, outcome, username, role, ip_address, target_type, target_id, details_json
            FROM audit_logs
            WHERE event_type IN ('login', 'logout', 'user_created', 'user_updated', 'user_deleted', 'password_changed')
               OR target_type = 'user'
            ORDER BY created_at DESC, id DESC
            LIMIT 12
        `);

        const [eventTypeRows] = await pool.query(`
            SELECT event_type, COUNT(*) AS count
            FROM audit_logs
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
            GROUP BY event_type
            ORDER BY count DESC, event_type ASC
            LIMIT 10
        `);

        const [hourlyRows] = await pool.query(`
            SELECT DATE_FORMAT(created_at, '%Y-%m-%d %H:00:00') AS bucket, COUNT(*) AS count
            FROM audit_logs
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
            GROUP BY bucket
            ORDER BY bucket ASC
        `);

        let mwlSummary = {
            total_queries_24h: 0,
            error_queries_24h: 0,
            no_match_queries_24h: 0,
            recent_errors: [],
            unavailable: false,
            error: null,
        };

        try {
            await ensurePacsMwlTables();
            const pacsDb = dicomwebPacs.getPacsMetadataDb();
            const [mwlSummaryRows] = await pacsDb.query(`
                SELECT
                  COUNT(*) AS total_queries_24h,
                  SUM(CASE WHEN outcome IN ('error', 'failure', 'failed') THEN 1 ELSE 0 END) AS error_queries_24h,
                  SUM(CASE WHEN match_count = 0 THEN 1 ELSE 0 END) AS no_match_queries_24h
                FROM mwl_query_logs
                WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
            `);
            const [recentMwlErrorRows] = await pacsDb.query(`
                SELECT id, created_at, calling_ae_title, remote_address, patient_id, accession_number,
                       modality, match_count, outcome, status_code, error_message
                FROM mwl_query_logs
                WHERE outcome IN ('error', 'failure', 'failed') OR error_message IS NOT NULL
                ORDER BY created_at DESC, id DESC
                LIMIT 12
            `);
            mwlSummary = {
                total_queries_24h: toNumber(mwlSummaryRows?.[0]?.total_queries_24h),
                error_queries_24h: toNumber(mwlSummaryRows?.[0]?.error_queries_24h),
                no_match_queries_24h: toNumber(mwlSummaryRows?.[0]?.no_match_queries_24h),
                recent_errors: normalizeSystemLogRows(recentMwlErrorRows),
                unavailable: false,
                error: null,
            };
        } catch (mwlError) {
            mwlSummary.unavailable = true;
            mwlSummary.error = mwlError.message || 'MWL query logs unavailable';
        }

        const auditSummary = auditSummaryRows?.[0] || {};
        const failureCount = toNumber(auditSummary.failure_events_24h) + toNumber(mwlSummary.error_queries_24h);
        const status =
            failureCount > 10 || dbLatencyMs > 500
                ? 'warning'
                : failureCount > 0
                  ? 'attention'
                  : 'healthy';

        res.json({
            generatedAt: new Date().toISOString(),
            health: {
                status,
                uptimeSeconds: Math.round(process.uptime()),
                dbLatencyMs,
                memory: {
                    rssMb: Math.round(memory.rss / 1024 / 1024),
                    heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
                    heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
                },
                backendPort: port,
                nodeEnv: process.env.NODE_ENV || 'development',
            },
            troubleshooting: {
                failureEvents24h: toNumber(auditSummary.failure_events_24h),
                mwlErrors24h: toNumber(mwlSummary.error_queries_24h),
                recentFailures: normalizeSystemLogRows(recentFailureRows),
                recentMwlErrors: mwlSummary.recent_errors,
            },
            security: {
                loginEvents24h: toNumber(auditSummary.login_events_24h),
                failedLoginEvents24h: toNumber(auditSummary.failed_login_events_24h),
                uniqueIpCount24h: toNumber(auditSummary.unique_ip_count_24h),
                recentEvents: normalizeSystemLogRows(recentSecurityRows),
            },
            performance: {
                auditEvents24h: toNumber(auditSummary.total_events_24h),
                mwlQueries24h: toNumber(mwlSummary.total_queries_24h),
                mwlNoMatchQueries24h: toNumber(mwlSummary.no_match_queries_24h),
                hourlyAuditEvents: normalizeSystemLogRows(hourlyRows),
                topEventTypes: normalizeSystemLogRows(eventTypeRows),
            },
            compliance: {
                retentionSource: 'audit_logs',
                latestAuditId: recentSecurityRows?.[0]?.id || recentFailureRows?.[0]?.id || null,
                evidenceFields: [
                    'created_at',
                    'event_type',
                    'outcome',
                    'username',
                    'role',
                    'ip_address',
                    'user_agent',
                    'target_type',
                    'target_id',
                    'details_json',
                ],
            },
            mwl: mwlSummary,
        });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to load system logs' });
    }
});

app.get('/api/system/backup/config', requirePermission('view_backup_restore'), async (req, res) => {
    try {
        res.json({ config: publicBackupConfig(await readBackupConfigFromDb()) });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to read backup config' });
    }
});

app.put('/api/system/backup/config', requirePermission('manage_backup_restore'), async (req, res) => {
    try {
        const saved = await writeBackupConfigToDb(req.body || {}, getUsernameFromRequest(req));
        res.json({ config: publicBackupConfig(saved) });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to save backup config' });
    }
});

app.get('/api/system/backup/list', requirePermission('view_backup_restore'), (req, res) => {
    try {
        res.json({ backups: listBackupManifests() });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to list backups' });
    }
});

app.get('/api/system/backup/status', requirePermission('view_backup_restore'), (req, res) => {
    try {
        res.json({ job: backupJobStatus(), schedule: getBackupScheduleStatus() });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to read backup status' });
    }
});

app.get('/api/system/backup/jobs', requirePermission('view_backup_restore'), async (req, res) => {
    try {
        res.json({ jobs: await listBackupJobLogs(req.query.limit) });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to list backup jobs' });
    }
});

app.post('/api/system/backup/run', requirePermission('manage_backup_restore'), async (req, res) => {
    try {
        const config = await readBackupConfigFromDb();
        const args = ['-ConfigPath', BACKUP_CONFIG_PATH];
        if (req.body?.skipDicomData) args.push('-SkipDicomData');
        if (req.body?.skipProgramData) args.push('-SkipProgramData');
        if (req.body?.noStopServices) args.push('-NoStopServices');
        const logId = await createBackupJobLog('backup', config, req);
        if (logId) args.push('-JobLogId', String(logId));
        const status = runPowerShellJob('backup', BACKUP_SCRIPT_PATH, args, logId);
        res.status(202).json({ job: status });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Failed to start backup' });
    }
});

app.post('/api/system/restore/run', requirePermission('manage_backup_restore'), async (req, res) => {
    try {
        const config = await readBackupConfigFromDb();
        const backupPath = normalizeNullableString(req.body?.backupPath, 1000);
        const confirmation = String(req.body?.confirmation || '').trim();
        if (!backupPath) {
            return res.status(400).json({ error: 'Backup path is required' });
        }
        if (confirmation !== 'RESTORE') {
            return res.status(400).json({ error: 'Type RESTORE to confirm the restore' });
        }
        const args = ['-BackupPath', backupPath, '-ConfigPath', BACKUP_CONFIG_PATH, '-ConfirmRestore'];
        if (req.body?.skipDatabase) args.push('-SkipDatabase');
        if (req.body?.skipDicomData) args.push('-SkipDicomData');
        if (req.body?.skipProgramData) args.push('-SkipProgramData');
        if (req.body?.noStopServices) args.push('-NoStopServices');
        if (req.body?.noStartServices) args.push('-NoStartServices');
        const logId = await createBackupJobLog('restore', config, req, backupPath);
        const status = runPowerShellJob('restore', RESTORE_SCRIPT_PATH, args, logId);
        res.status(202).json({ job: status });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Failed to start restore' });
    }
});

app.get('/api/system/backup/schedule', requirePermission('view_backup_restore'), (req, res) => {
    res.json({ schedule: getBackupScheduleStatus() });
});

app.post('/api/system/backup/schedule', requirePermission('manage_backup_restore'), async (req, res) => {
    try {
        const current = await readBackupConfigFromDb();
        const incomingSchedule = req.body?.schedule && typeof req.body.schedule === 'object'
            ? req.body.schedule
            : req.body;
        const schedule = normalizeBackupSchedule({ ...incomingSchedule, enabled: true }, current.schedule);
        const result = createBackupSchedule(schedule);
        await writeBackupConfigToDb({ ...current, schedule: { ...schedule, enabled: true } }, getUsernameFromRequest(req));
        res.json({ schedule: { ...getBackupScheduleStatus(), ...result } });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Failed to create backup schedule' });
    }
});

app.delete('/api/system/backup/schedule', requirePermission('manage_backup_restore'), async (req, res) => {
    try {
        removeBackupScheduleTask();
        const current = await readBackupConfigFromDb();
        await writeBackupConfigToDb({ ...current, schedule: { ...current.schedule, enabled: false } }, getUsernameFromRequest(req));
        res.json({ schedule: getBackupScheduleStatus() });
    } catch {
        const current = await readBackupConfigFromDb();
        await writeBackupConfigToDb({ ...current, schedule: { ...current.schedule, enabled: false } }, getUsernameFromRequest(req));
        res.json({ schedule: getBackupScheduleStatus() });
    }
});

app.get('/api/system/health', async (req, res) => {
    const startedAt = Date.now();
    let database = 'ok';
    let dbLatencyMs = null;

    try {
        await pool.query('SELECT 1');
        dbLatencyMs = Date.now() - startedAt;
    } catch (err) {
        database = 'error';
    }

    res.status(database === 'ok' ? 200 : 503).json({
        service: 'ris-backend',
        status: database === 'ok' ? 'ok' : 'degraded',
        generatedAt: new Date().toISOString(),
        uptimeSeconds: Math.round(process.uptime()),
        database,
        dbLatencyMs,
    });
});

// Local-only guard for maintenance endpoints. A full sync walks the entire
// DICOM storage tree and re-reads every file's header, so it must never be
// reachable from the LAN — only from the server itself (or a loopback caller
// such as the Vexa System Utility running on the same host).
function requireLocalRequest(req, res) {
    const remoteAddress = normalizeClientIp(req.ip || req.socket?.remoteAddress || '');
    if (['127.0.0.1', '::1', 'localhost'].includes(remoteAddress)) {
        return true;
    }
    res.status(403).json({ error: 'Synchronization can only be run from this server (localhost).' });
    return false;
}

// Rescan DICOM storage and rebuild PACS metadata (pacs_instances/series/studies).
// This is the same routine the PACS runs after every C-STORE; exposing it here
// lets the utility index files that were copied into the storage folder by hand,
// which otherwise only happens if something happens to trigger a QIDO refresh.
app.post('/api/system/sync/pacs', async (req, res) => {
    if (!requireLocalRequest(req, res)) return;
    const startedAt = Date.now();
    try {
        const result = await dicomwebPacs.syncPacsMetadataFromStorage(true);
        res.json({
            ok: true,
            target: 'pacs',
            elapsedMs: Date.now() - startedAt,
            result: result || { status: 'synchronized' },
        });
    } catch (err) {
        res.status(500).json({ ok: false, target: 'pacs', error: err.message || 'PACS metadata synchronization failed.' });
    }
});

// Reconcile RIS MWL orders against what the PACS actually holds: any order still
// sitting in SENT_TO_MWL whose study already exists in PACS is moved to
// COMPLETED (same routine the worklist uses, but run to exhaustion instead of
// the usual 200-row / 30-second throttled nudge). Run the PACS half FIRST so the
// studies are indexed before we ask whether they exist.
app.post('/api/system/sync/ris', async (req, res) => {
    if (!requireLocalRequest(req, res)) return;
    const startedAt = Date.now();
    const maxPasses = Math.max(1, Math.min(Number(req.body?.maxPasses) || 25, 200));
    try {
        await ensureMwlTables();
        let checked = 0;
        let completed = 0;
        let passes = 0;
        for (let pass = 0; pass < maxPasses; pass += 1) {
            const result = await syncCompletedMwlOrdersFromOrthanc({ limit: 200 });
            passes += 1;
            checked += Number(result?.checked || 0);
            completed += Number(result?.completed || 0);
            // A pass that completed nothing means the SENT_TO_MWL remainder does
            // not exist in PACS yet (modality has not sent) - stop instead of
            // re-scanning the same rows forever.
            if (Number(result?.completed || 0) === 0 || Number(result?.checked || 0) === 0) break;
        }
        res.json({
            ok: true,
            target: 'ris',
            elapsedMs: Date.now() - startedAt,
            passes,
            checked,
            completed,
        });
    } catch (err) {
        res.status(500).json({ ok: false, target: 'ris', error: err.message || 'RIS order synchronization failed.' });
    }
});

// One-shot "sync everything" used by the Vexa System Utility button:
// storage -> PACS metadata -> RIS MWL order statuses.
app.post('/api/system/sync/all', async (req, res) => {
    if (!requireLocalRequest(req, res)) return;
    const startedAt = Date.now();
    const steps = {};
    try {
        steps.pacs = { ok: true, result: await dicomwebPacs.syncPacsMetadataFromStorage(true) };
    } catch (err) {
        steps.pacs = { ok: false, error: err.message || 'PACS metadata synchronization failed.' };
    }
    try {
        await ensureMwlTables();
        let checked = 0;
        let completed = 0;
        let passes = 0;
        for (let pass = 0; pass < 25; pass += 1) {
            const result = await syncCompletedMwlOrdersFromOrthanc({ limit: 200 });
            passes += 1;
            checked += Number(result?.checked || 0);
            completed += Number(result?.completed || 0);
            if (Number(result?.completed || 0) === 0 || Number(result?.checked || 0) === 0) break;
        }
        steps.ris = { ok: true, passes, checked, completed };
    } catch (err) {
        steps.ris = { ok: false, error: err.message || 'RIS order synchronization failed.' };
    }
    const ok = Object.values(steps).every(step => step.ok);
    res.status(ok ? 200 : 500).json({
        ok,
        target: 'all',
        elapsedMs: Date.now() - startedAt,
        steps,
    });
});

app.get('/api/system/performance', requirePermission('view_settings'), async (req, res) => {
    try {
        const memory = process.memoryUsage();
        res.json({
            service: 'ris-backend',
            generatedAt: new Date().toISOString(),
            uptimeSeconds: Math.round(process.uptime()),
            memory: {
                rssMb: Math.round(memory.rss / 1024 / 1024),
                heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
                heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
            },
            dicomweb: getDicomwebRuntimeStats(),
            backup: backupJobStatus(),
        });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to load performance stats' });
    }
});

app.listen(port, () => {
    console.log(`Nexia Backend listening at http://localhost:${port}`);
    setTimeout(() => runOrderInWorker().catch(error => console.error('[order-in-worker] startup failed:', error.message)), 5000);
    setInterval(() => runOrderInWorker().catch(error => console.error('[order-in-worker] failed:', error.message)), 5000);
    setTimeout(() => runDicomRoutingScheduler().catch(error => console.error('[dicom-routing] startup failed:', error.message)), 15000);
    setInterval(() => runDicomRoutingScheduler().catch(error => console.error('[dicom-routing] scheduler failed:', error.message)), 30000);
});
