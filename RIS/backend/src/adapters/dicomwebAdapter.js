const { formatDate, formatTime, toMultiValue } = require('../utils/dicomFormat');

function tag(vr, value) {
  if (value === null || value === undefined || value === '') {
    return { vr };
  }
  if (Array.isArray(value)) {
    return value.length ? { vr, Value: value } : { vr };
  }
  return { vr, Value: [value] };
}

function tagPN(value) {
  if (!value) {
    return { vr: 'PN' };
  }
  return { vr: 'PN', Value: [{ Alphabetic: String(value) }] };
}

function buildStudyResponse(row) {
  return {
    '0020000D': tag('UI', row.StudyInstanceUID),
    '00080020': tag('DA', formatDate(row.StudyDate)),
    '00080030': tag('TM', formatTime(row.StudyTime)),
    '00080050': tag('SH', row.AccessionNumber),
    '00081030': tag('LO', row.StudyDescription),
    '00080061': tag('CS', toMultiValue(row.StudyModality)),
    '00100010': tagPN(row.PatientName),
    '00100020': tag('LO', row.PatientID),
    '00100030': tag('DA', formatDate(row.PatientBirthDate)),
    '00100040': tag('CS', row.PatientSex),
    '00200010': tag('SH', row.StudyID),
  };
}

function buildSeriesResponse(row) {
  return {
    '0020000E': tag('UI', row.SeriesInstanceUID),
    '00200011': tag('IS', row.SeriesNumber),
    '00080021': tag('DA', formatDate(row.SeriesDate)),
    '00080031': tag('TM', formatTime(row.SeriesTime)),
    '0008103E': tag('LO', row.SeriesDescription),
    '00080060': tag('CS', row.Modality),
    '00180015': tag('CS', row.BodyPartExamined),
    '00181030': tag('LO', row.ProtocolName),
    '00081010': tag('SH', row.StationName),
    '00080070': tag('LO', row.Manufacturer),
    '00081090': tag('LO', row.ModelName),
    '00200052': tag('UI', row.FrameOfReferenceUID),
    '0020000D': tag('UI', row.StudyInstanceUID),
    '00201209': tag('IS', row.NumberOfSeriesRelatedInstances),
  };
}

function buildInstanceResponse(row) {
  const bitsStored = row.BitsStored ? Number(row.BitsStored) : null;
  return {
    '00080018': tag('UI', row.SOPInstanceUID),
    '00080016': tag('UI', row.SOPClassUID),
    '00200013': tag('IS', row.ImageNumber),
    '00080023': tag('DA', formatDate(row.ImageDate)),
    '00080033': tag('TM', formatTime(row.ImageTime)),
    '00280008': tag('IS', row.NumberOfFrames),
    '00280010': tag('US', row.QRows),
    '00280011': tag('US', row.QColumns),
    '00280002': tag('US', row.SamplesPerPixel),
    '00280004': tag('CS', row.PhotoMetricInterpretation),
    '00280101': tag('US', bitsStored),
    '00280100': tag('US', bitsStored),
    '0020000E': tag('UI', row.SeriesInstanceUID),
    '0020000D': tag('UI', row.StudyInstanceUID),
  };
}

module.exports = { buildStudyResponse, buildSeriesResponse, buildInstanceResponse };
