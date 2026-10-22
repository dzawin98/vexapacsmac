const postgres = require('./postgresCompat');
const dicomConfig = require('../../config/dicom');

const pool = postgres.createPool({
  host: dicomConfig.database.host,
  user: dicomConfig.database.user,
  password: dicomConfig.database.password,
  database: dicomConfig.database.database,
  port: dicomConfig.database.port,
  connectionLimit: 10,
});

module.exports = pool;
