const path = require('path');

const dicomwebPacsRoot = path.resolve(__dirname, '..', '..', '..', 'PACS');

const config = {
  dicomweb: {
    basePath: process.env.DICOMWEB_BASE_PATH || '/dicom-web',
    corsOrigin: process.env.DICOMWEB_CORS_ORIGIN || '*',
    token: process.env.DICOMWEB_TOKEN || '',
    cacheTtlMs: Number(process.env.DICOMWEB_CACHE_TTL_MS || 30000),
    cacheMaxEntries: Number(process.env.DICOMWEB_CACHE_MAX || 500),
    orthancRoot:
      process.env.ORTHANC_DICOMWEB_ROOT || 'http://127.0.0.1:8042/dicom-web',
    pacsRoot: process.env.DICOMWEB_PACS_ROOT || 'http://127.0.0.1:5001',
    pacsRsRoot:
      process.env.DICOMWEB_PACS_RS_ROOT ||
      `${process.env.DICOMWEB_PACS_ROOT || 'http://127.0.0.1:5001'}/rs`,
    pacsStoragePath:
      process.env.DICOMWEB_PACS_STORAGE_PATH || path.join(dicomwebPacsRoot, 'data'),
    pacsPackageRoot: process.env.DICOMWEB_PACS_PACKAGE_ROOT || dicomwebPacsRoot,
  },
  database: {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASS || 'velo',
    database: process.env.DB_NAME || 'vexaris_db',
    port: Number(process.env.DB_PORT || 5432),
  },
};

module.exports = config;
