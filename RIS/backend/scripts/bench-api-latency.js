/**
 * Latency sweep of the RIS backend (and the PACS endpoints it proxies to).
 *
 * Measures wall time per request against the running dev stack, 5 samples each,
 * and reports min/median/max so a "high ms in the log" report can be turned into
 * a ranked list of the endpoints that are actually slow.
 *
 * Usage: node scratch/bench-api-latency.js [--base=http://127.0.0.1:3001] [--samples=5]
 */
const base = (process.argv.find(a => a.startsWith('--base=')) || '--base=http://127.0.0.1:3001').split('=')[1];
const samples = Number((process.argv.find(a => a.startsWith('--samples=')) || '--samples=5').split('=')[1]) || 5;
const headers = { 'x-user-role': 'administrator', 'x-user-username': 'bench' };

const endpoints = [
  ['GET', '/api/public/facility'],
  ['GET', '/api/ui/settings'],
  ['GET', '/api/dicom/stats'],
  ['GET', '/api/dicom/nodes'],
  ['GET', '/api/dicom/settings'],
  ['GET', '/api/mwl/status'],
  ['GET', '/api/mwl/published?active=all'],
  ['GET', '/api/mwl/query-logs?limit=50'],
  ['GET', '/api/mwl/modalities'],
  ['GET', '/api/mwl/doctors'],
  ['GET', '/api/mwl/studies'],
  ['GET', '/api/mwl/patients'],
  ['GET', '/api/mwl/orders?limit=50'],
  ['GET', '/api/simrs/order-in?limit=50'],
  ['GET', '/api/dose/reports'],
  ['GET', '/api/dose/rules'],
  ['GET', '/api/dose/idrl'],
  ['GET', '/api/users'],
  ['GET', '/api/roles'],
  ['GET', '/api/reports/templates?radiologistUsername=admin'],
  ['GET', '/api/dicom/traffic-logs?limit=50'],
  ['GET', '/api/audit-logs?limit=50'],
  ['GET', '/api/system-logs'],
  ['GET', '/api/management-reports'],
];

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

(async () => {
  const rows = [];
  for (const [method, path] of endpoints) {
    const times = [];
    let status = 0;
    let bytes = 0;
    for (let i = 0; i < samples; i += 1) {
      const startedAt = performance.now();
      try {
        const response = await fetch(`${base}${path}`, { method, headers });
        status = response.status;
        const body = await response.text();
        bytes = body.length;
      } catch (error) {
        status = -1;
      }
      times.push(performance.now() - startedAt);
    }
    rows.push({
      path,
      status,
      bytes,
      min: Math.round(Math.min(...times)),
      median: Math.round(median(times)),
      max: Math.round(Math.max(...times)),
    });
  }
  rows.sort((a, b) => b.median - a.median);
  console.log(`base=${base} samples=${samples}`);
  console.log('median_ms  min  max  status  bytes   endpoint');
  for (const row of rows) {
    console.log(`${String(row.median).padStart(8)}  ${String(row.min).padStart(4)} ${String(row.max).padStart(4)}  ${String(row.status).padStart(6)}  ${String(row.bytes).padStart(7)}  ${row.path}`);
  }
})();
