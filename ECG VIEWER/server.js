const http = require('http');
const fs = require('fs');
const path = require('path');
const { enforceLicenseAtStartup } = require('../scripts/license/licenseRuntime');
const { getRelatedStudyWaveforms, getStudyWaveform } = require('./waveform');

enforceLicenseAtStartup('ECG_VIEWER');

const PORT = Number(process.env.ECG_VIEWER_PORT || 7771);
const ECG_PUBLIC_DIR = path.resolve(__dirname, 'public');
const DICOM_STORAGE_PATH = process.env.DICOM_STORAGE_PATH
  ? path.resolve(process.env.DICOM_STORAGE_PATH)
  : path.resolve(__dirname, '..', 'DATA');
const DICOMWEB_RS_ROOT = String(process.env.DICOMWEB_RS_ROOT || 'http://127.0.0.1:5001/rs').replace(/\/+$/, '');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function send(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...headers,
  });
  res.end(body);
}

function safePublicPath(relativePath) {
  const filePath = path.resolve(ECG_PUBLIC_DIR, relativePath.replace(/^\/+/, ''));
  if (!filePath.startsWith(ECG_PUBLIC_DIR)) return null;
  return filePath;
}

function servePublicFile(res, relativePath) {
  const filePath = safePublicPath(relativePath);
  if (!filePath) {
    send(res, 400, 'Invalid path');
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(res, 404, 'File not found');
      return;
    }
    const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    send(res, 200, data, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  });
}

async function handleWaveformRoute(res, pathname) {
  const match = pathname.match(/^\/rs\/studies\/([^/]+)\/(waveform|waveforms)$/);
  if (!match) {
    send(res, 404, JSON.stringify({ error: 'Not found' }), { 'Content-Type': 'application/json; charset=utf-8' });
    return;
  }

  try {
    const studyInstanceUid = decodeURIComponent(match[1]);
    let payload = match[2] === 'waveforms'
      ? await getRelatedStudyWaveforms(DICOM_STORAGE_PATH, studyInstanceUid)
      : await getStudyWaveform(DICOM_STORAGE_PATH, studyInstanceUid);
    if (!payload || (Array.isArray(payload) && payload.length === 0)) {
      payload = await getDicomwebWaveform(studyInstanceUid, match[2]);
    }
    if (!payload || (Array.isArray(payload) && payload.length === 0)) {
      send(res, 404, JSON.stringify({ error: 'DICOM waveform not found' }), { 'Content-Type': 'application/json; charset=utf-8' });
      return;
    }
    send(res, 200, JSON.stringify(payload), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  } catch (error) {
    send(
      res,
      500,
      JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to read ECG waveform' }),
      { 'Content-Type': 'application/json; charset=utf-8' }
    );
  }
}

async function getDicomwebWaveform(studyInstanceUid, resource) {
  const response = await fetch(`${DICOMWEB_RS_ROOT}/studies/${encodeURIComponent(studyInstanceUid)}/${resource}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404) return resource === 'waveforms' ? [] : null;
  if (!response.ok) {
    throw new Error(`DICOMweb waveform request failed with HTTP ${response.status}`);
  }
  return response.json();
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    send(res, 204, '');
    return;
  }
  if (req.method !== 'GET') {
    send(res, 405, 'Method not allowed');
    return;
  }

  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  if (requestUrl.pathname === '/' || requestUrl.pathname === '/viewer') {
    servePublicFile(res, 'ecg-viewer.html');
    return;
  }
  if (requestUrl.pathname === '/health') {
    let dicomweb = { ok: false, status: null, error: null };
    try {
      const response = await fetch(`${DICOMWEB_RS_ROOT}/studies`, {
        headers: { Accept: 'application/dicom+json' },
        signal: AbortSignal.timeout(5000),
      });
      dicomweb = { ok: response.ok, status: response.status, error: response.ok ? null : `HTTP ${response.status}` };
    } catch (error) {
      dicomweb = { ok: false, status: null, error: error instanceof Error ? error.message : 'DICOMweb unavailable' };
    }
    send(res, dicomweb.ok ? 200 : 503, JSON.stringify({
      ok: dicomweb.ok,
      service: 'vexa-ecg',
      storagePath: DICOM_STORAGE_PATH,
      dicomwebRsRoot: DICOMWEB_RS_ROOT,
      dicomweb,
    }), { 'Content-Type': 'application/json; charset=utf-8' });
    return;
  }
  if (requestUrl.pathname.startsWith('/rs/')) {
    await handleWaveformRoute(res, requestUrl.pathname);
    return;
  }
  if (requestUrl.pathname === '/ecg-viewer.js') {
    servePublicFile(res, 'ecg-viewer.js');
    return;
  }
  if (requestUrl.pathname === '/analysis-core.js') {
    servePublicFile(res, 'analysis-core.js');
    return;
  }
  if (requestUrl.pathname === '/logo.png') {
    servePublicFile(res, 'logo.png');
    return;
  }

  send(res, 404, 'Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`VEXA ECG listening on http://127.0.0.1:${PORT}/viewer`);
  console.log(`Reading ECG DICOM data from ${DICOM_STORAGE_PATH}`);
  console.log(`Using DICOMweb waveform fallback from ${DICOMWEB_RS_ROOT}`);
});
