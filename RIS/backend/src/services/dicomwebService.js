const dicomwebPacsService = require('./dicomwebPacsService');

module.exports = {
  getStudies: dicomwebPacsService.getStudies,
  getSeries: dicomwebPacsService.getSeries,
  getInstances: dicomwebPacsService.getInstances,
  getFrame: dicomwebPacsService.getFrame,
  clearQidoCache: dicomwebPacsService.clearQidoCache,
  getRuntimeStats: dicomwebPacsService.getRuntimeStats,
};
