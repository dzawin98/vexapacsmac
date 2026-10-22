(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.VexaEcgAnalysis = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SYSTEM = 'VEXA_ECG_INTERNAL';

  function available(value) {
    return Number.isFinite(Number(value));
  }

  function category(id, label, status, detail) {
    return { id, label, status, detail };
  }

  function formatFindingCode(code) {
    return String(code || '').replace(/^VEXA-/, '');
  }

  function finding(code, term, termId, categoryName, urgency, evidence) {
    return {
      terminologySystem: SYSTEM,
      code,
      term,
      termId,
      category: categoryName,
      source: 'algorithm',
      verificationStatus: 'unconfirmed',
      urgency,
      evidence,
    };
  }

  function buildClinicalImpression(input = {}) {
    const leadCount = Number(input.leadCount) || 0;
    const heartRate = available(input.heartRate) ? Number(input.heartRate) : null;
    const qrsDuration = available(input.qrsDuration) ? Number(input.qrsDuration) : null;
    const qtcFridericia = available(input.qtcFridericia) ? Number(input.qtcFridericia) : null;
    const axisDeg = available(input.axisDeg) ? Number(input.axisDeg) : null;
    const regularity = input.regularity || null;
    const stFindings = Array.isArray(input.stFindings) ? input.stFindings : [];
    const limited = leadCount < 12;
    const findings = [];

    if (limited) findings.push(finding('VEXA-ECG-TECH-001', 'Limited ECG acquisition', 'Akuisisi EKG terbatas', 'technical', 'routine', { leadCount }));
    if (heartRate !== null && heartRate < 50) findings.push(finding('VEXA-ECG-RATE-001', 'Bradycardic rate', 'Frekuensi bradikardia', 'rate', 'routine', { heartRateBpm: Math.round(heartRate) }));
    if (heartRate !== null && heartRate > 100) findings.push(finding('VEXA-ECG-RATE-002', 'Tachycardic rate', 'Frekuensi takikardia', 'rate', 'urgent', { heartRateBpm: Math.round(heartRate) }));
    if (regularity && regularity !== 'regular') findings.push(finding('VEXA-ECG-RHYTHM-003', 'Irregular rhythm', 'Irama tidak teratur', 'rhythm', 'urgent', { regularity }));
    if (axisDeg !== null && axisDeg < -30) findings.push(finding('VEXA-ECG-AXIS-002', 'Left axis deviation', 'Deviasi aksis kiri', 'axis', 'routine', { axisDeg: Math.round(axisDeg) }));
    if (axisDeg !== null && axisDeg > 90) findings.push(finding('VEXA-ECG-AXIS-003', 'Right axis deviation', 'Deviasi aksis kanan', 'axis', 'routine', { axisDeg: Math.round(axisDeg) }));
    if (qrsDuration !== null && qrsDuration >= 120) findings.push(finding('VEXA-ECG-COND-001', 'Prolonged QRS duration', 'Durasi QRS memanjang', 'conduction', 'urgent', { qrsDurationMs: Math.round(qrsDuration) }));
    if (qtcFridericia !== null && qtcFridericia >= 450) findings.push(finding('VEXA-ECG-INT-001', 'Prolonged QTc interval', 'Interval QTc memanjang', 'interval', 'urgent', { qtcFridericiaMs: Math.round(qtcFridericia) }));
    ['depression', 'elevation'].forEach(status => {
      const matches = stFindings.filter(item => item.status === status);
      if (!matches.length) return;
      findings.push(finding(
        status === 'elevation' ? 'VEXA-ECG-STT-001' : 'VEXA-ECG-STT-002',
        status === 'elevation' ? 'ST-segment elevation' : 'ST-segment depression',
        status === 'elevation' ? 'Elevasi segmen ST' : 'Depresi segmen ST',
        'st_t',
        'urgent',
        { leads: matches.map(item => item.label), deviationsUv: Object.fromEntries(matches.map(item => [item.label, item.deviation])) }
      ));
    });

    const urgency = findings.some(item => item.urgency === 'critical')
      ? 'critical'
      : findings.some(item => item.urgency === 'urgent')
        ? 'urgent'
        : 'routine';
    const clinicalFindings = findings.filter(item => item.category !== 'technical');
    const headline = limited && !clinicalFindings.length
      ? 'Limited automated interpretation'
      : urgency === 'urgent' || urgency === 'critical'
        ? 'Automated findings require priority review'
        : clinicalFindings.length
          ? 'Automated findings available'
          : 'No significant automated finding';
    const summary = clinicalFindings.length
      ? clinicalFindings.map(item => item.term).join('; ') + '.'
      : limited
        ? 'The available leads are insufficient for a complete automated interpretation.'
        : 'Rate, regularity, axis, QRS/QTc, and ST-segment screening show no significant automated finding.';

    return {
      terminologySystem: SYSTEM,
      source: 'algorithm',
      verificationStatus: 'unconfirmed',
      reportStatus: 'pending_review',
      urgency,
      statusLabel: 'Computer interpretation · Awaiting clinician verification',
      headline,
      summary,
      findings,
      categories: [
        category('quality', 'Acquisition', limited ? 'limited' : 'reviewed', limited ? `${leadCount || 'Unknown'} leads available.` : `${leadCount}-lead acquisition available.`),
        category('rate-rhythm', 'Rate & rhythm', findings.some(item => item.category === 'rate' || item.category === 'rhythm') ? 'attention' : heartRate !== null ? 'within-range' : 'unavailable', heartRate !== null ? `${Math.round(heartRate)} bpm · ${regularity || 'regularity unavailable'}` : 'Not reliably measured'),
        category('axis', 'Axis', findings.some(item => item.category === 'axis') ? 'attention' : axisDeg !== null ? 'within-range' : 'unavailable', axisDeg !== null ? `${Math.round(axisDeg)}°` : 'Unavailable'),
        category('conduction', 'Intervals', findings.some(item => item.category === 'conduction' || item.category === 'interval') ? 'attention' : qrsDuration !== null || qtcFridericia !== null ? 'within-range' : 'unavailable', [qrsDuration !== null ? `QRS ${Math.round(qrsDuration)} ms` : 'QRS –', qtcFridericia !== null ? `QTcF ${Math.round(qtcFridericia)} ms` : 'QTcF –'].join(' · ')),
        category('repolarization', 'ST-T', stFindings.length ? 'attention' : 'within-range', stFindings.length ? stFindings.map(item => `${item.status} ${item.label} ${item.deviation} µV`).join('; ') : 'No significant ST-deviation flag'),
      ],
    };
  }

  return { buildClinicalImpression, formatFindingCode };
}));
