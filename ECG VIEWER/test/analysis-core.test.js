const test = require('node:test');
const assert = require('node:assert/strict');
const { buildClinicalImpression, formatFindingCode } = require('../public/analysis-core');

test('builds a reassuring structured impression when screened measurements are in range', () => {
  const result = buildClinicalImpression({
    heartRate: 72,
    regularity: 'regular',
    qrsDuration: 92,
    qtcFridericia: 418,
    axisDeg: 34,
    stFindings: [],
    leadCount: 12,
  });

  assert.equal(result.urgency, 'routine');
  assert.equal(result.verificationStatus, 'unconfirmed');
  assert.equal(result.reportStatus, 'pending_review');
  assert.equal(result.source, 'algorithm');
  assert.equal(result.headline, 'No significant automated finding');
  assert.deepEqual(result.categories.map(item => item.id), ['quality', 'rate-rhythm', 'axis', 'conduction', 'repolarization']);
  assert.deepEqual(result.findings, []);
  assert.equal(result.statusLabel, 'Computer interpretation · Awaiting clinician verification');
  assert.equal(result.disclaimer, undefined);
});

test('prioritizes repolarization findings without declaring a definitive diagnosis', () => {
  const result = buildClinicalImpression({
    heartRate: 108,
    regularity: 'irregular/variable',
    qrsDuration: 126,
    qtcFridericia: 472,
    axisDeg: -48,
    stFindings: [{ label: 'II', status: 'elevation', deviation: 130 }],
    leadCount: 12,
  });

  assert.equal(result.urgency, 'urgent');
  assert.equal(result.headline, 'Automated findings require priority review');
  assert.deepEqual(result.findings.map(item => item.code), ['VEXA-ECG-RATE-002', 'VEXA-ECG-RHYTHM-003', 'VEXA-ECG-AXIS-002', 'VEXA-ECG-COND-001', 'VEXA-ECG-INT-001', 'VEXA-ECG-STT-001']);
  assert.equal(result.findings[0].terminologySystem, 'VEXA_ECG_INTERNAL');
  assert.equal(result.findings[0].verificationStatus, 'unconfirmed');
  assert.doesNotMatch(result.summary, /myocardial infarction|STEMI/i);
});

test('groups the same ST finding across leads into one coded statement', () => {
  const result = buildClinicalImpression({
    heartRate: 72,
    regularity: 'regular',
    stFindings: [
      { label: 'II', status: 'depression', deviation: -80 },
      { label: 'III', status: 'depression', deviation: -95 },
      { label: 'V5', status: 'elevation', deviation: 130 },
    ],
    leadCount: 12,
  });

  assert.deepEqual(result.findings.map(item => item.code), ['VEXA-ECG-STT-002', 'VEXA-ECG-STT-001']);
  assert.deepEqual(result.findings[0].evidence.leads, ['II', 'III']);
});

test('strips the internal VEXA prefix from displayed finding codes', () => {
  assert.equal(formatFindingCode('VEXA-ECG-RATE-002'), 'ECG-RATE-002');
  assert.equal(formatFindingCode('VEXA-ECG-STT-001'), 'ECG-STT-001');
  assert.equal(formatFindingCode('ECG-RATE-002'), 'ECG-RATE-002');
  assert.equal(formatFindingCode(''), '');
});

test('marks limited acquisitions and unavailable measurements clearly', () => {
  const result = buildClinicalImpression({ leadCount: 3 });

  assert.equal(result.urgency, 'routine');
  assert.equal(result.headline, 'Limited automated interpretation');
  assert.equal(result.findings[0].code, 'VEXA-ECG-TECH-001');
  assert.equal(result.categories.find(item => item.id === 'quality').status, 'limited');
});
