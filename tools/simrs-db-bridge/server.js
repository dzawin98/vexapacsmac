const fs = require('fs');
const path = require('path');
const express = require('express');
const { createDatabaseClient, defaultPort, normalizeDriver } = require('./dbAdapters');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DEFAULT_SETTINGS_PATH = path.join(ROOT_DIR, 'RIS', 'backend', 'settings.json');
const SETTINGS_PATH = process.env.VEXA_SETTINGS_PATH || process.env.SIMRS_BRIDGE_SETTINGS_PATH || DEFAULT_SETTINGS_PATH;
const PORT = Number(process.env.SIMRS_DB_BRIDGE_PORT || 3109);

const app = express();
app.use(express.json({ limit: '2mb' }));

let runtime = {
  running: false,
  lastRunAt: null,
  lastSuccessAt: null,
  lastError: null,
  counters: {
    pulledOrderIn: 0,
    pushedOrderOut: 0,
    orderInErrors: 0,
    orderOutErrors: 0,
  },
};

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    return fallback;
  }
}

function normalizeDbConfig(input = {}, fallbackDriver = 'postgresql') {
  const driver = normalizeDriver(input.driver || fallbackDriver);
  return {
    driver,
    dialect: input.dialect,
    host: input.host || '127.0.0.1',
    port: Number(input.port || defaultPort(driver)),
    database: input.database || (['mysql', 'mariadb'].includes(driver) ? 'mysql' : driver === 'sqlserver' ? 'master' : 'postgres'),
    user: input.user || (driver === 'sqlserver' ? 'sa' : driver === 'mysql' || driver === 'mariadb' ? 'root' : 'postgres'),
    password: input.password || '',
    ssl: input.ssl || false,
    encrypt: input.encrypt === true,
    trustServerCertificate: input.trustServerCertificate !== false,
    instanceName: input.instanceName,
    connectionString: input.connectionString,
    connectionTimeoutMs: input.connectionTimeoutMs,
    requestTimeoutMs: input.requestTimeoutMs,
  };
}

function normalizeSide(input = {}, fallback = {}, driver = 'postgresql', defaultTable = 'order_in') {
  return {
    enabled: input.enabled !== false,
    table: input.table || fallback.table || defaultTable,
    db: normalizeDbConfig(input.db || fallback.db || {}, driver),
    columnMap: input.columnMap || fallback.columnMap || {},
    updateRisFilter: input.updateRisFilter || fallback.updateRisFilter || 'N',
    ackInternalAfterPush: input.ackInternalAfterPush === true,
  };
}

function loadConfig() {
  const settings = readJson(SETTINGS_PATH, {});
  const bridge = settings.simrsDbBridge || {};
  const enabledOverride = String(process.env.SIMRS_DB_BRIDGE_ENABLED || '').trim().toLowerCase();
  const legacy = bridge.postgres || {};
  const configuredConnectors = Array.isArray(bridge.connectors) ? bridge.connectors : [];
  const connectors = (configuredConnectors.length ? configuredConnectors : [{
    id: 'postgresql-default', name: 'PostgreSQL staging', enabled: true, driver: 'postgresql',
    orderIn: legacy.orderIn || {}, orderOut: legacy.orderOut || {},
  }]).map((item, index) => {
    const driver = normalizeDriver(item.driver || item.orderIn?.db?.driver || item.orderOut?.db?.driver || 'postgresql');
    return {
      id: String(item.id || `connector-${index + 1}`),
      name: String(item.name || `${driver} connector`),
      enabled: item.enabled !== false,
      driver,
      orderIn: normalizeSide(item.orderIn, legacy.orderIn, driver, 'test_orderin'),
      orderOut: normalizeSide(item.orderOut, legacy.orderOut, driver, 'test_orderout'),
    };
  });
  return {
    enabled: enabledOverride ? ['1', 'true', 'yes', 'on'].includes(enabledOverride) : Boolean(bridge.enabled),
    mode: bridge.mode || 'api-and-db',
    pollIntervalMs: Math.max(3000, Number(process.env.SIMRS_DB_BRIDGE_POLL_MS || bridge.pollIntervalMs || 5000)),
    batchSize: Math.min(500, Math.max(1, Number(bridge.batchSize || 50))),
    risApi: {
      baseUrl: bridge.risApi?.baseUrl || process.env.SIMRS_BRIDGE_RIS_API || 'http://127.0.0.1:3001/api',
      apiKey: bridge.risApi?.apiKey || settings.simrsApi?.apiKey || process.env.SIMRS_API_KEY || '',
    },
    connectors,
  };
}

async function apiRequest(config, method, route, body) {
  const url = `${String(config.risApi.baseUrl).replace(/\/$/, '')}${route}`;
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.risApi.apiKey,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    const message = payload?.error || payload?.message || text || `${method} ${route} failed`;
    throw new Error(message);
  }
  return payload;
}

async function reportIntegrationFailure(config, payload) {
  try {
    await apiRequest(config, 'POST', '/simrs/integration-log', {
      source: 'db-bridge',
      ...payload,
    });
  } catch (err) {
    console.error(`[bridge-log] ${err.message || err}`);
  }
}

function toOrderInPayload(row, columnMap = {}) {
  const value = field => row[columnMap[field] || field];
  return {
    ...Object.fromEntries([
      'tanggal_order','tanggal_aktivasi','no_rm','nama_pasien','tanggal_lahir','kelamin','alamat','kecamatan',
      'kabupaten','provinsi','kode_pos','no_hp','no_register','no_rontgen','klinis','diagnosa','kode_pemeriksaan',
      'nama_pemeriksaan','modality','cito','polirawat','kode_ruangan','nama_ruangan','kode_dokter','nama_dokter',
      'kode_admin','nama_admin','kode_dokter_radiolog','nama_radiolog','kode_radiografer','nama_radiografer',
      'cara_bayar','kode_asuransi','nama_asuransi','kode_instalasi_radiologi','nama_instalasi_radiologi',
    ].map(field => [field, value(field)])),
    update_ris: 'N',
  };
}

async function pullOrderIn(config, connector) {
  const side = connector.orderIn;
  if (!side.enabled) return 0;
  const client = await createDatabaseClient(side.db);
  const table = client.quote(side.table);
  const q = name => client.quote(side.columnMap[name] || name);
  let processed = 0;
  try {
    const limit = client.parameter(1);
    const select = client.dialect === 'sqlserver'
      ? `SELECT TOP (${limit}) * FROM ${table} WHERE COALESCE(${q('sync_status')}, ${q('update_ris')}, 'N') IN ('N','U') ORDER BY COALESCE(${q('waktu_update_orderin')}, ${q('tanggal_order')}, CURRENT_TIMESTAMP), ${q('id')}`
      : `SELECT * FROM ${table} WHERE COALESCE(${q('sync_status')}, ${q('update_ris')}, 'N') IN ('N','U') ORDER BY COALESCE(${q('waktu_update_orderin')}, ${q('tanggal_order')}, CURRENT_TIMESTAMP), ${q('id')} LIMIT ${limit}`;
    const rows = await client.query(select, [config.batchSize]);
    for (const row of rows) {
      const payload = toOrderInPayload(row, side.columnMap);
      try {
        await apiRequest(config, 'POST', '/simrs/order-in', payload);
        await client.query(`UPDATE ${table} SET ${q('sync_status')}='Y', ${q('sync_message')}=NULL, ${q('synced_at')}=CURRENT_TIMESTAMP WHERE ${q('no_rontgen')}=${client.parameter(1)}`, [payload.no_rontgen]);
        processed += 1;
      } catch (err) {
        runtime.counters.orderInErrors += 1;
        const reason = String(err.message || err).slice(0, 500);
        await client.query(`UPDATE ${table} SET ${q('sync_status')}='E', ${q('sync_message')}=${client.parameter(2)}, ${q('synced_at')}=CURRENT_TIMESTAMP WHERE ${q('no_rontgen')}=${client.parameter(1)}`, [payload.no_rontgen, reason]);
        await reportIntegrationFailure(config, {
          event_type: 'simrs_db_order_in_failed',
          target_type: 'simrs_order_in',
          target_id: payload.no_rontgen || payload.no_rm || null,
          direction: 'order_in',
          no_rontgen: payload.no_rontgen || null,
          no_rm: payload.no_rm || null,
          connector: connector.name,
          driver: connector.driver,
          database: side.db.database,
          table: side.table,
          reason,
          payload,
        });
      }
    }
  } finally {
    await client.close();
  }
  runtime.counters.pulledOrderIn += processed;
  return processed;
}

const ORDER_OUT_COLUMNS = [
  'no_rm',
  'no_rontgen',
  'no_register',
  'kode_user_admin',
  'nama_user_admin',
  'admin_datetime_start',
  'admin_datetime_end',
  'kode_radiografer',
  'nama_radiografer',
  'radiografer_datetime_start',
  'radiografer_datetime_end',
  'kode_radiolog',
  'nama_radiolog',
  'radiolog_datetime_start',
  'radiolog_datetime_end',
  'klinis',
  'cito',
  'kritis',
  'expertise_text_finding',
  'expertise_text_conclusion',
  'expertise_html_finding',
  'expertise_html_conclusion',
  'urllink1',
  'urllink2',
  'urllink3',
  'urllink4',
  'urllink5',
  'urllink6',
  'alasan',
  'update_ris',
];

function orderOutValues(row) {
  return ORDER_OUT_COLUMNS.map(column => (column === 'update_ris' ? 'N' : row[column] ?? null));
}

async function upsertExternalOrderOut(client, side, row) {
  const table = client.quote(side.table);
  const q = name => client.quote(side.columnMap[name] || name);
  const key = row.no_rontgen;
  const exists = await client.query(`SELECT ${q('no_rontgen')} FROM ${table} WHERE ${q('no_rontgen')}=${client.parameter(1)}`, [key]);
  const values = orderOutValues(row);
  if (exists.length) {
    const columns = ORDER_OUT_COLUMNS.filter(column => column !== 'no_rontgen');
    const params = columns.map(column => values[ORDER_OUT_COLUMNS.indexOf(column)]);
    params.push(key);
    const assignments = columns.map((column, index) => `${q(column)}=${client.parameter(index + 1)}`).join(', ');
    await client.query(`UPDATE ${table} SET ${assignments}, ${q('sync_status')}='N', ${q('sync_message')}=NULL, ${q('synced_at')}=CURRENT_TIMESTAMP WHERE ${q('no_rontgen')}=${client.parameter(params.length)}`, params);
    return;
  }
  const placeholders = ORDER_OUT_COLUMNS.map((_, index) => client.parameter(index + 1)).join(', ');
  await client.query(`INSERT INTO ${table} (${ORDER_OUT_COLUMNS.map(q).join(', ')}, ${q('sync_status')}, ${q('sync_message')}, ${q('synced_at')}) VALUES (${placeholders}, 'N', NULL, CURRENT_TIMESTAMP)`, values);
}

async function pushOrderOut(config, connector) {
  const side = connector.orderOut;
  if (!side.enabled) return 0;
  const client = await createDatabaseClient(side.db);
  let processed = 0;
  try {
    const updateRisFilter = String(side.updateRisFilter || 'N').trim().toUpperCase() || 'N';
    const result = await apiRequest(config, 'GET', `/simrs/order-out?update_ris=${encodeURIComponent(updateRisFilter)}&page=1&limit=${config.batchSize}`);
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    for (const row of rows) {
      try {
        await upsertExternalOrderOut(client, side, row);
        if (side.ackInternalAfterPush) {
          await apiRequest(config, 'PATCH', `/simrs/order-out/${encodeURIComponent(row.no_rontgen)}/ack`, {
            update_ris: 'Y',
            alasan: 'Pushed to SIMRS DB bridge',
          });
        }
        processed += 1;
      } catch (err) {
        runtime.counters.orderOutErrors += 1;
        const reason = String(err.message || err).slice(0, 500);
        console.error(`[order-out] ${row.no_rontgen}: ${reason}`);
        await reportIntegrationFailure(config, {
          event_type: 'simrs_db_order_out_failed',
          target_type: 'simrs_order_out',
          target_id: row.no_rontgen || row.no_rm || null,
          direction: 'order_out',
          no_rontgen: row.no_rontgen || null,
          no_rm: row.no_rm || null,
          connector: connector.name,
          driver: connector.driver,
          database: side.db.database,
          table: side.table,
          reason,
          payload: row,
        });
      }
    }
  } finally {
    await client.close();
  }
  runtime.counters.pushedOrderOut += processed;
  return processed;
}

async function runOnce() {
  if (runtime.running) return { skipped: true, reason: 'Bridge is already running' };
  runtime.running = true;
  runtime.lastRunAt = new Date().toISOString();
  runtime.lastError = null;
  try {
    const config = loadConfig();
    if (!config.enabled) return { skipped: true, reason: 'simrsDbBridge.enabled is false' };
    if (!config.risApi.apiKey) throw new Error('simrsDbBridge.risApi.apiKey or simrsApi.apiKey is required');

    const mode = String(config.mode || 'api-and-db').trim().toLowerCase();

    if (mode === 'db-only' || mode === 'api-and-db') {
      let pulledOrderIn = 0;
      let pushedOrderOut = 0;
      const connectors = [];
      for (const connector of config.connectors.filter(item => item.enabled)) {
        const pulled = await pullOrderIn(config, connector);
        const pushed = await pushOrderOut(config, connector);
        pulledOrderIn += pulled;
        pushedOrderOut += pushed;
        connectors.push({ id: connector.id, name: connector.name, driver: connector.driver, pulledOrderIn: pulled, pushedOrderOut: pushed });
      }
      runtime.lastSuccessAt = new Date().toISOString();
      return { ok: true, mode, pulledOrderIn, pushedOrderOut, connectors };
    }

    // api-only: bridge runs but skips DB pull/push
    runtime.lastSuccessAt = new Date().toISOString();
    return {
      ok: true,
      mode: 'api-only',
      pulledOrderIn: 0,
      pushedOrderOut: 0,
      info: 'Bridge is in api-only mode. SIMRS integration uses REST API directly.',
    };
  } catch (err) {
    runtime.lastError = err.message || String(err);
    try {
      const config = loadConfig();
      if (config.enabled && config.risApi.apiKey) {
        await reportIntegrationFailure(config, {
          event_type: 'simrs_db_bridge_failed',
          target_type: 'simrs_db_bridge',
          direction: 'bridge',
          reason: runtime.lastError,
        });
      }
    } catch (logErr) {
      console.error(`[bridge-log] ${logErr.message || logErr}`);
    }
    throw err;
  } finally {
    runtime.running = false;
  }
}

let timer = null;
function startLoop() {
  const config = loadConfig();
  if (timer) clearInterval(timer);
  if (!config.enabled) return;
  timer = setInterval(() => {
    runOnce().catch(err => console.error(`[bridge] ${err.message}`));
  }, config.pollIntervalMs);
  runOnce().catch(err => console.error(`[bridge] ${err.message}`));
}

function sanitizedConfig(config) {
  return JSON.parse(JSON.stringify(config, (key, value) => {
    if (['password', 'apiKey', 'connectionString'].includes(key)) return value ? '*** configured ***' : '';
    return value;
  }));
}

app.get('/health', (req, res) => res.json({ ok: true, settingsPath: SETTINGS_PATH }));
app.get('/drivers', (req, res) => res.json({
  drivers: [
    { id: 'postgresql', label: 'PostgreSQL', builtIn: true },
    { id: 'mysql', label: 'MySQL', builtIn: true },
    { id: 'mariadb', label: 'MariaDB', builtIn: true },
    { id: 'sqlserver', label: 'Microsoft SQL Server', builtIn: true },
  ],
}));
app.get('/status', (req, res) => res.json({ ...runtime, config: sanitizedConfig(loadConfig()) }));
app.post('/test-connection', async (req, res) => {
  const config = loadConfig();
  const connector = config.connectors.find(item => item.id === req.body?.connectorId);
  const direction = req.body?.direction === 'orderOut' ? 'orderOut' : 'orderIn';
  if (!connector) return res.status(404).json({ error: 'Connector not found' });
  let client;
  try {
    client = await createDatabaseClient(connector[direction].db);
    await client.query('SELECT 1');
    res.json({ ok: true, connector: connector.name, driver: connector.driver, direction });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || String(err) });
  } finally {
    if (client) await client.close().catch(() => {});
  }
});
app.post('/sync', async (req, res) => {
  try {
    res.json(await runOnce());
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

if (process.argv.includes('--once')) {
  runOnce()
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch(err => {
      console.error(err.message || err);
      process.exit(1);
    });
} else {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`VEXA SIMRS DB Bridge listening on http://0.0.0.0:${PORT}`);
    console.log(`Settings: ${SETTINGS_PATH}`);
    startLoop();
  });
}
