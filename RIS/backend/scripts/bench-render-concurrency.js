/**
 * Where the parallel render burst serializes: RIS proxy, or PACS render pipeline?
 *
 * 20 thumbnails in one burst (what a study selection triggers) each took ~500 ms while
 * a single one costs ~40 ms - the shape of serialized work. This sweeps concurrency
 * against PACS directly and through the RIS.
 *
 *   node RIS/backend/scripts/bench-render-concurrency.js [--levels=1,2,4,8,20]
 */
const os = require('os');
const path = require('path');
const BACKEND = path.resolve(__dirname, '..');
require(path.join(BACKEND, 'node_modules', 'dotenv')).config({ path: path.join(BACKEND, '.env') });
const fetch = require(path.join(BACKEND, 'node_modules', 'node-fetch'));

const levelsArg = (process.argv.find(a => a.startsWith('--levels=')) || '').split('=')[1];
const LEVELS = (levelsArg || '1,2,4,8,20').split(',').map(Number);
const OFFSET = Number((process.argv.find(a => a.startsWith('--offset=')) || '').split('=')[1] || 200);
const PREWARM = Number((process.argv.find(a => a.startsWith('--prewarm=')) || '').split('=')[1] || 0);
const SERIES_RANK = Number((process.argv.find(a => a.startsWith('--series-rank=')) || '').split('=')[1] || 0);
const SEQUENTIAL = Number((process.argv.find(a => a.startsWith('--sequential=')) || '').split('=')[1] || 0);
const PACS = 'http://127.0.0.1:5001';
const RIS = 'http://127.0.0.1:3001';
const HEADERS = { 'x-user-role': 'administrator' };
const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function timeOne(url, headers) {
  const started = Date.now();
  const response = await fetch(url, { headers });
  await response.buffer();
  return Date.now() - started;
}

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
    'SELECT series_instance_uid, study_instance_uid FROM pacs_instances GROUP BY series_instance_uid, study_instance_uid ORDER BY COUNT(*) DESC LIMIT 1 OFFSET $1',
    [SERIES_RANK],
  )).rows[0];
  const sops = (await client.query(
    'SELECT sop_instance_uid FROM pacs_instances WHERE series_instance_uid = $1 ORDER BY sop_instance_uid OFFSET $2 LIMIT 40',
    [series.series_instance_uid, OFFSET],
  )).rows.map(r => r.sop_instance_uid);
  await client.end();
  console.log(`cpu=${os.cpus().length} core | seri uji ${sops.length} instance | prewarm ${PREWARM}\n`);

  // --prewarm=N renders N frames one at a time (a different slice, so the measured
  // frames stay cold) to bring the decoder workers up before the burst.
  if (PREWARM > 0) {
    const warmUps = (await (async () => {
      const { Client: C } = require(path.join(BACKEND, 'node_modules', 'pg'));
      const c = new C({
        host: process.env.PACS_DB_HOST || 'localhost',
        port: Number(process.env.PACS_DB_PORT || 5432),
        user: process.env.PACS_DB_USER || 'postgres',
        password: process.env.PACS_DB_PASS || process.env.PACS_DB_PASSWORD,
        database: process.env.PACS_DB_NAME || 'velopacs_db',
      });
      await c.connect();
      const rows = (await c.query(
        'SELECT sop_instance_uid FROM pacs_instances WHERE series_instance_uid = $1 ORDER BY sop_instance_uid OFFSET $2 LIMIT $3',
        [series.series_instance_uid, Math.max(0, OFFSET - 60), PREWARM],
      )).rows.map(r => r.sop_instance_uid);
      await c.end();
      return rows;
    })());
    for (const sop of warmUps) {
      await timeOne(`${PACS}/rs/studies/${series.study_instance_uid}/series/${series.series_instance_uid}/instances/${sop}/rendered`, {});
    }
    console.log(`prewarm selesai: ${warmUps.length} frame sequential di-decoder-kan\n`);
  }

  if (SEQUENTIAL > 0) {
    const times = [];
    for (const sop of sops.slice(0, SEQUENTIAL)) {
      times.push(await timeOne(`${PACS}/rs/studies/${series.study_instance_uid}/series/${series.series_instance_uid}/instances/${sop}/rendered`, {}));
    }
    console.log(`sequential ${times.length} frame: [${times.join(', ')}] | median ${median(times)} ms`);
    return;
  }

  for (const level of LEVELS) {
    const pacsUrls = sops.slice(0, level).map(sop =>
      `${PACS}/rs/studies/${series.study_instance_uid}/series/${series.series_instance_uid}/instances/${sop}/rendered`);
    let started = Date.now();
    const pacs = await Promise.all(pacsUrls.map(url => timeOne(url, {})));
    const pacsTotal = Date.now() - started;

    const risUrls = sops.slice(level, level * 2).map(sop =>
      `${RIS}/api/dicom/instances/preview?studyInstanceUID=${series.study_instance_uid}&seriesInstanceUID=${series.series_instance_uid}&sopInstanceUID=${sop}`);
    started = Date.now();
    const ris = await Promise.all(risUrls.map(url => timeOne(url, HEADERS)));
    const risTotal = Date.now() - started;

    console.log(`paralel ${String(level).padStart(2)}: PACS total ${String(pacsTotal).padStart(5)} ms median ${String(median(pacs)).padStart(4)} ms max ${String(Math.max(...pacs)).padStart(4)} ms | RIS total ${String(risTotal).padStart(5)} ms median ${String(median(ris)).padStart(4)} ms max ${String(Math.max(...ris)).padStart(4)} ms`);
  }
})().catch(error => { console.log('ERR', error.message); process.exit(1); });
