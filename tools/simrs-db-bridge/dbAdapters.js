function normalizeDriver(value) {
  const driver = String(value || 'postgresql').trim().toLowerCase();
  if (['postgres', 'postgresql', 'pg'].includes(driver)) return 'postgresql';
  if (['mysql', 'mysql2'].includes(driver)) return 'mysql';
  if (['mariadb', 'maria'].includes(driver)) return 'mariadb';
  if (['mssql', 'sqlserver', 'sql-server'].includes(driver)) return 'sqlserver';
  throw new Error(`Unsupported database driver: ${value}`);
}

function dialectFor(config) {
  const driver = normalizeDriver(config.driver);
  return driver === 'mariadb' ? 'mysql' : driver;
}

function defaultPort(driver) {
  if (driver === 'mysql' || driver === 'mariadb') return 3306;
  if (driver === 'sqlserver') return 1433;
  return 5432;
}

function quotePart(value, dialect) {
  const identifier = String(value || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(identifier)) {
    throw new Error(`Invalid SQL identifier: ${value}`);
  }
  if (dialect === 'mysql') return `\`${identifier}\``;
  if (dialect === 'sqlserver') return `[${identifier}]`;
  return `"${identifier}"`;
}

function quoteQualifiedIdentifier(value, dialect) {
  const parts = String(value || '').split('.').filter(Boolean);
  if (!parts.length || parts.length > 3) throw new Error(`Invalid SQL identifier: ${value}`);
  return parts.map(part => quotePart(part, dialect)).join('.');
}

function placeholder(driver, index) {
  if (driver === 'postgresql') return `$${index}`;
  if (driver === 'sqlserver') return `@p${index}`;
  return '?';
}

async function createDatabaseClient(input = {}) {
  const driver = normalizeDriver(input.driver);
  const dialect = dialectFor(input);
  const config = {
    ...input,
    driver,
    port: Number(input.port || defaultPort(driver)),
  };

  if (driver === 'postgresql') {
    const { Pool } = require('pg');
    const pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl || false,
      max: 3,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: Number(config.connectionTimeoutMs || 5000),
    });
    return {
      driver,
      dialect,
      parameter: index => placeholder(driver, index),
      quote: value => quoteQualifiedIdentifier(value, dialect),
      async query(sql, params = []) { return (await pool.query(sql, params)).rows; },
      async close() { await pool.end(); },
    };
  }

  if (driver === 'mysql' || driver === 'mariadb') {
    const mysql = require('mysql2/promise');
    const pool = mysql.createPool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl || undefined,
      waitForConnections: true,
      connectionLimit: 3,
      connectTimeout: Number(config.connectionTimeoutMs || 5000),
    });
    return {
      driver,
      dialect,
      parameter: index => placeholder('mysql', index),
      quote: value => quoteQualifiedIdentifier(value, dialect),
      async query(sql, params = []) { const [rows] = await pool.query(sql, params); return rows; },
      async close() { await pool.end(); },
    };
  }

  if (driver === 'sqlserver') {
    const mssql = require('mssql');
    const pool = await new mssql.ConnectionPool({
      server: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      options: {
        encrypt: config.encrypt === true || config.ssl === true,
        trustServerCertificate: config.trustServerCertificate !== false,
        instanceName: config.instanceName || undefined,
      },
      pool: { max: 3, min: 0, idleTimeoutMillis: 10000 },
      connectionTimeout: Number(config.connectionTimeoutMs || 5000),
      requestTimeout: Number(config.requestTimeoutMs || 15000),
    }).connect();
    return {
      driver,
      dialect,
      parameter: index => placeholder(driver, index),
      quote: value => quoteQualifiedIdentifier(value, dialect),
      async query(sql, params = []) {
        const request = pool.request();
        params.forEach((value, index) => request.input(`p${index + 1}`, value));
        return (await request.query(sql)).recordset || [];
      },
      async close() { await pool.close(); },
    };
  }

  throw new Error(`Unsupported database driver: ${driver}`);
}

module.exports = {
  createDatabaseClient,
  defaultPort,
  normalizeDriver,
};
