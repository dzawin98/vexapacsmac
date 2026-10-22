/**
 * What actually costs milliseconds on the RIS image endpoints.
 *
 * Measures the three things a cheaper fix could target: the burst a study selection
 * triggers (thumbnail/preview panels), how long the preview cache really hides the
 * render cost, and whether RIS -> PACS calls reuse their TCP connection.
 *
 *   node RIS/backend/scripts/bench-image-endpoints.js [--burst=20] [--ttl-wait=65]
 */
const path = require('path');
const http = require('http');
const BACKEND = path.resolve(__dirname, '..');
require(path.join(BACKEND, 'node_modules', 'dotenv')).config({ path: path.join(BACKEND, '.env') });
const fetch = require(path.join(BACKEND, 'node_modules', 'node-fetch'));
const svc = require(path.join(BACKEND, 'src', 'services', 'dicomwebPacsService.js'));

const argOf = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};
const BURST = argOf('burst', 20);
const TTL_WAIT = argOf('ttl-wait', 65);
const RIS = (process.argv.find(a => a.startsWith('--base=')) || '').split('=')[1] || 'http://127.0.0.1:3001';
const OMIT_STUDY = process.argv.includes('--no-study');
const PACS = 'http://127.0.0.1:5001';
const HEADERS = { 'x-user-role': 'administrator' };

const rowsOf = result => (result && result.rows) || result || [];

async function timed(url, headers = HEADERS) {
  const started = Date.now();
  const response = await fetch(url, { headers });
  const body = await response.buffer();
  return { ms: Date.now() - started, status: response.status, bytes: body.length, type: response.headers.get('content-type') };
}
const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];

(async () => {
  const { Client } = require(path.join(BACKEND, 'node_modules', 'pg'));
  const client = new Client({
    host: process.env.PACS_DB_HOST || 'localhost',
    port: Number(process.env.PACS_DB_PORT || 5432),
    user: process.env.PACS_DB_USER || 'postgres',
    password: process.env.PACS_DB_PASS || process.env.PACS_DB_PASSWORD,
    database: process.env.PACS_DB_NAME || 'velopacs_db',
  });
  await client.connect();
  const series = (await client.query(
    'SELECT series_instance_uid, study_instance_uid, COUNT(*) AS n FROM pacs_instances GROUP BY series_instance_uid, study_instance_uid ORDER BY COUNT(*) DESC LIMIT 1',
  )).rows[0];
  const studyUid = series.study_instance_uid;
  const seriesUid = series.series_instance_uid;
  const instances = (await client.query(
    'SELECT sop_instance_uid FROM pacs_instances WHERE series_instance_uid = $1 ORDER BY sop_instance_uid LIMIT 40',
    [seriesUid],
  )).rows.map(r => r.sop_instance_uid);
  await client.end();
  console.log(`seri uji: ${instances.length} instance (total seri ${series.n})\n`);

  // A. the thumbnail burst a 20-series study panel triggers (browser runs ~6 at a time)
  const thumbUrls = instances.slice(0, BURST).map(() =>
    `${RIS}/api/dicom/series/${encodeURIComponent(seriesUid)}/thumbnail${OMIT_STUDY ? '' : `?studyInstanceUID=${encodeURIComponent(studyUid)}`}`);
  let started = Date.now();
  const thumbs = await Promise.all(thumbUrls.map(url => timed(url)));
  console.log(`A. ${BURST} thumbnail PARALEL (RIS)   : total ${Date.now() - started} ms | median ${median(thumbs.map(t => t.ms))} ms | max ${Math.max(...thumbs.map(t => t.ms))} ms | ${thumbs[0].bytes}b ${thumbs[0].type}`);

  // B. the same burst on previews (distinct frames, all cold right after a restart)
  const previewUrls = instances.slice(0, BURST).map(sop =>
    `${RIS}/api/dicom/instances/preview?studyInstanceUID=${encodeURIComponent(studyUid)}&seriesInstanceUID=${encodeURIComponent(seriesUid)}&sopInstanceUID=${encodeURIComponent(sop)}`);
  started = Date.now();
  const previews = await Promise.all(previewUrls.map(url => timed(url)));
  console.log(`B. ${BURST} preview PARALEL (RIS)    : total ${Date.now() - started} ms | median ${median(previews.map(p => p.ms))} ms | max ${Math.max(...previews.map(p => p.ms))} ms | ${previews[0].bytes}b ${previews[0].type}`);

  // C. how much the 60 s preview cache hides: one SOP, first cold-ish, then after the TTL
  const sop = instances[instances.length - 1];
  const previewUrl = `${RIS}/api/dicom/instances/preview?studyInstanceUID=${encodeURIComponent(studyUid)}&seriesInstanceUID=${encodeURIComponent(seriesUid)}&sopInstanceUID=${encodeURIComponent(sop)}`;
  const first = await timed(previewUrl);
  const again = await timed(previewUrl);
  console.log(`C. preview 1x=${first.ms} ms, ulang=${again.ms} ms -> menunggu ${TTL_WAIT} s (TTL cache: RIS_PREVIEW_CACHE_MS, default 10 menit)`);
  await new Promise(resolve => setTimeout(resolve, TTL_WAIT * 1000));
  const afterTtl = await timed(previewUrl);
  console.log(`C. preview setelah TTL kedaluwarsa: ${afterTtl.ms} ms (cache 60 s -> render ulang)`);

  // D. does RIS -> PACS reuse connections? same rendered frame, default agent vs keep-alive
  const renderedUrl = `${PACS}/rs/studies/${encodeURIComponent(studyUid)}/series/${encodeURIComponent(seriesUid)}/instances/${encodeURIComponent(instances[0])}/rendered`;
  const fresh = [];
  for (let i = 0; i < 8; i += 1) fresh.push((await timed(renderedUrl, {})).ms);
  const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });
  const kept = [];
  for (let i = 0; i < 8; i += 1) {
    const startedAt = Date.now();
    const response = await fetch(renderedUrl, { agent: keepAliveAgent });
    await response.buffer();
    kept.push(Date.now() - startedAt);
  }
  keepAliveAgent.destroy();
  console.log(`D. PACS rendered 8x: koneksi baru median ${median(fresh)} ms (${fresh.join('/')})`);
  console.log(`D. PACS rendered 8x: keep-alive  median ${median(kept)} ms (${kept.join('/')})`);
})().catch(error => { console.log('ERR', error.message); process.exit(1); });
