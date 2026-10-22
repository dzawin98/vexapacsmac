/**
 * Latency of the study/image pipeline: PACS QIDO + WADO against the RIS proxies.
 *
 * The DICOM path is where a PACS UI actually waits (metadata queries, first frame
 * render, thumbnails), so measure it with real UIDs instead of guessing from logs.
 *
 * Usage: node scratch/bench-pipeline-latency.js [--pacs=http://127.0.0.1:5001] [--ris=http://127.0.0.1:3001] [--samples=3]
 */
const arg = (name, fallback) => (process.argv.find(a => a.startsWith(`--${name}=`)) || `--${name}=${fallback}`).split('=').slice(1).join('=');
const pacs = arg('pacs', 'http://127.0.0.1:5001');
const ris = arg('ris', 'http://127.0.0.1:3001');
const samples = Number(arg('samples', '3')) || 3;
const risHeaders = { 'x-user-role': 'administrator', 'x-user-username': 'bench' };

async function timed(label, url, headers = {}) {
  const times = [];
  let bytes = 0;
  let status = 0;
  for (let i = 0; i < samples; i += 1) {
    const startedAt = performance.now();
    try {
      const response = await fetch(url, { headers });
      status = response.status;
      const buffer = await response.arrayBuffer();
      bytes = buffer.byteLength;
    } catch (error) {
      status = -1;
      bytes = 0;
    }
    times.push(Math.round(performance.now() - startedAt));
  }
  console.log(`${label.padEnd(46)} status=${String(status).padStart(4)} bytes=${String(bytes).padStart(8)} ms=[${times.join(', ')}]`);
}

(async () => {
  const studies = await (await fetch(`${pacs}/rs/studies?limit=30&includefield=00201209`)).json();
  console.log(`studi tersedia: ${studies.length}`);
  await timed('PACS QIDO /rs/studies?limit=30', `${pacs}/rs/studies?limit=30&includefield=00201209`);

  let picked = null;
  for (const study of studies) {
    const uid = study['0020000D']?.Value?.[0];
    if (!uid) continue;
    const series = await (await fetch(`${pacs}/rs/studies/${uid}/series`)).json();
    for (const item of series) {
      const seriesUid = item['0020000E']?.Value?.[0];
      if (!seriesUid) continue;
      const instances = await (await fetch(`${pacs}/rs/studies/${uid}/series/${seriesUid}/instances`)).json();
      if (!instances.length) continue;
      picked = {
        studyUid: uid,
        patient: study['00100010']?.Value?.[0]?.Alphabetic || '?',
        modality: study['00080061']?.Value?.[0] || '?',
        seriesUid,
        seriesCount: series.length,
        instanceCount: instances.length,
        sop: instances[0]['00080018'].Value[0],
      };
      break;
    }
    if (picked) break;
  }
  if (!picked) {
    console.log('tidak ada studi dengan image — berhenti');
    return;
  }
  console.log(`studi uji: ${picked.patient} (${picked.modality}) series=${picked.seriesCount} inst=${picked.instanceCount}`);

  await timed('PACS QIDO /studies/<uid>/series', `${pacs}/rs/studies/${picked.studyUid}/series`);
  await timed('PACS QIDO /series/<s>/instances', `${pacs}/rs/studies/${picked.studyUid}/series/${picked.seriesUid}/instances`);
  await timed(
    'PACS WADO frame (first instance)',
    `${pacs}/wado?requestType=WADO&studyUID=${picked.studyUid}&seriesUID=${picked.seriesUid}&objectUID=${picked.sop}&contentType=application%2Fdicom`
  );
  await timed(
    'RIS preview (RenderedImage)',
    `${ris}/api/dicom/instances/preview?studyInstanceUID=${picked.studyUid}&seriesInstanceUID=${picked.seriesUid}&sopInstanceUID=${picked.sop}`,
    risHeaders
  );
  await timed('RIS series thumbnail', `${ris}/api/dicom/series/${picked.seriesUid}/thumbnail`, risHeaders);
})();
