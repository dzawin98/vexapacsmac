const dicomConfig = require('../../config/dicom');

function setDicomwebCors(req, res, next) {
  const origin = dicomConfig.dicomweb.corsOrigin;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  return next();
}

function requireToken(req, res, next) {
  const token = dicomConfig.dicomweb.token;
  if (!token) {
    return next();
  }
  const auth = req.headers.authorization || '';
  const parts = auth.split(' ');
  const provided = parts.length === 2 ? parts[1] : auth;
  if (provided && provided === token) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

module.exports = { setDicomwebCors, requireToken };
