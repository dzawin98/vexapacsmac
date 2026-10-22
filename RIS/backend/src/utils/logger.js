function logRequest(req) {
  console.log(`[dicomweb] ${req.method} ${req.originalUrl}`);
}

function logResponse(req, status, meta) {
  const suffix = meta ? ` ${meta}` : '';
  console.log(`[dicomweb] ${req.method} ${req.originalUrl} ${status}${suffix}`);
}

function logError(req, err) {
  const status = err && err.status ? err.status : 500;
  console.error(`[dicomweb] ${req.method} ${req.originalUrl} ${status} ${err.message || err}`);
}

module.exports = { logRequest, logResponse, logError };
