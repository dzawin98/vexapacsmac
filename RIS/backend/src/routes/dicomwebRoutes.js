const express = require('express');
const dicomwebController = require('../controllers/dicomwebController');
const { setDicomwebCors, requireToken } = require('../utils/middleware');

const router = express.Router();

router.use(setDicomwebCors);
router.use(requireToken);

router.get('/studies', dicomwebController.getStudies);
router.get('/studies/:studyUid/series', dicomwebController.getSeries);
router.get('/studies/:studyUid/series/:seriesUid/instances', dicomwebController.getInstances);
router.get(
  '/studies/:studyUid/series/:seriesUid/instances/:instanceUid/frames/:frame',
  dicomwebController.getFrame
);

module.exports = router;
