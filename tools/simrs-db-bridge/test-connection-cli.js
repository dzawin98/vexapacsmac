const { createDatabaseClient } = require('./dbAdapters');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  let client;
  try {
    const config = JSON.parse(input || '{}');
    client = await createDatabaseClient({ ...config, connectionTimeoutMs: 5000, requestTimeoutMs: 5000 });
    await client.query('SELECT 1');
    process.stdout.write(JSON.stringify({ ok: true, driver: client.driver }));
  } catch (error) {
    process.stderr.write(String(error?.message || error));
    process.exitCode = 1;
  } finally {
    if (client) await client.close().catch(() => {});
  }
});
