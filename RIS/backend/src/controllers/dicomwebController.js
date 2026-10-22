const dicomwebService = require('../services/dicomwebService');
const { logRequest, logResponse, logError } = require('../utils/logger');

async function getStudies(req, res) {
  logRequest(req);
  try {
    const result = await dicomwebService.getStudies(req.query);
    res.set('Content-Type', 'application/dicom+json');
    res.status(200).json(result.data);
    logResponse(req, 200, result.cached ? 'cache' : '');
  } catch (err) {
    logError(req, err);
    res.status(err.status || 500).json({ error: err.message || 'Internal Error' });
  }
}

async function getSeries(req, res) {
  logRequest(req);
  try {
    const result = await dicomwebService.getSeries(req.params.studyUid, req.query);
    res.set('Content-Type', 'application/dicom+json');
    res.status(200).json(result.data);
    logResponse(req, 200, result.cached ? 'cache' : '');
  } catch (err) {
    logError(req, err);
    res.status(err.status || 500).json({ error: err.message || 'Internal Error' });
  }
}

async function getInstances(req, res) {
  logRequest(req);
  try {
    const result = await dicomwebService.getInstances(
      req.params.studyUid,
      req.params.seriesUid,
      req.query
    );
    res.set('Content-Type', 'application/dicom+json');
    res.status(200).json(result.data);
    logResponse(req, 200, result.cached ? 'cache' : '');
  } catch (err) {
    logError(req, err);
    res.status(err.status || 500).json({ error: err.message || 'Internal Error' });
  }
}

async function getFrame(req, res) {
  logRequest(req);
  try {
    const frameBuffer = await dicomwebService.getFrame(
      req.params.studyUid,
      req.params.seriesUid,
      req.params.instanceUid,
      req.params.frame
    );
    const boundary = `frame_${Date.now()}`;
    res.status(200);
    res.set('Content-Type', `multipart/related; type="application/octet-stream"; boundary=${boundary}`);
    const header = Buffer.from(
      `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    res.send(Buffer.concat([header, frameBuffer, footer]));
    logResponse(req, 200);
  } catch (err) {
    logError(req, err);
    res.status(err.status || 500).json({ error: err.message || 'Internal Error' });
  }
}

module.exports = { getStudies, getSeries, getInstances, getFrame };
