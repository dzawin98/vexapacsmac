if (!window.VexaEcgAnalysis) {
  const SYSTEM = 'VEXA_ECG_INTERNAL';
  const available = value => Number.isFinite(Number(value));
  const finding = (code, term, termId, category, urgency, evidence) => ({ terminologySystem: SYSTEM, code, term, termId, category, source: 'algorithm', verificationStatus: 'unconfirmed', urgency, evidence });
  window.VexaEcgAnalysis = {
    formatFindingCode(code) {
      return String(code || '').replace(/^VEXA-/, '');
    },
    buildClinicalImpression(input = {}) {
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
      const urgency = findings.some(item => item.urgency === 'critical') ? 'critical' : findings.some(item => item.urgency === 'urgent') ? 'urgent' : 'routine';
      const clinicalFindings = findings.filter(item => item.category !== 'technical');
      const headline = limited && !clinicalFindings.length ? 'Limited automated interpretation' : urgency !== 'routine' ? 'Automated findings require priority review' : clinicalFindings.length ? 'Automated findings available' : 'No significant automated finding';
      const summary = clinicalFindings.length ? clinicalFindings.map(item => item.term).join('; ') + '.' : limited ? 'The available leads are insufficient for a complete automated interpretation.' : 'Rate, regularity, axis, QRS/QTc, and ST-segment screening show no significant automated finding.';
      const category = (id, label, status, detail) => ({ id, label, status, detail });
      return {
        terminologySystem: SYSTEM, source: 'algorithm', verificationStatus: 'unconfirmed', reportStatus: 'pending_review', urgency,
        statusLabel: 'Computer interpretation · Awaiting clinician verification', headline, summary, findings,
        categories: [
          category('quality', 'Acquisition', limited ? 'limited' : 'reviewed', limited ? `${leadCount || 'Unknown'} leads available.` : `${leadCount}-lead acquisition available.`),
          category('rate-rhythm', 'Rate & rhythm', findings.some(item => item.category === 'rate' || item.category === 'rhythm') ? 'attention' : heartRate !== null ? 'within-range' : 'unavailable', heartRate !== null ? `${Math.round(heartRate)} bpm · ${regularity || 'regularity unavailable'}` : 'Not reliably measured'),
          category('axis', 'Axis', findings.some(item => item.category === 'axis') ? 'attention' : axisDeg !== null ? 'within-range' : 'unavailable', axisDeg !== null ? `${Math.round(axisDeg)}°` : 'Unavailable'),
          category('conduction', 'Intervals', findings.some(item => item.category === 'conduction' || item.category === 'interval') ? 'attention' : qrsDuration !== null || qtcFridericia !== null ? 'within-range' : 'unavailable', [qrsDuration !== null ? `QRS ${Math.round(qrsDuration)} ms` : 'QRS –', qtcFridericia !== null ? `QTcF ${Math.round(qtcFridericia)} ms` : 'QTcF –'].join(' · ')),
          category('repolarization', 'ST-T', stFindings.length ? 'attention' : 'within-range', stFindings.length ? stFindings.map(item => `${item.status} ${item.label} ${item.deviation} µV`).join('; ') : 'No significant ST-deviation flag'),
        ],
      };
    },
  };
}

(function () {
  function parseStudyUids() {
    const params = new URLSearchParams(window.location.search);
    return [...params.getAll('StudyInstanceUIDs'), ...params.getAll('StudyInstanceUID')].flatMap(value => value.split(',')).map(value => value.trim()).filter(Boolean);
  }

  let studyUids = parseStudyUids();
  let studyUid = studyUids[0] || '';
  let loadedStudyKey = '';
  let loadRequestId = 0;
  const viewportGrid = document.getElementById('viewportGrid');
  let canvas = null;
  let ctx = null;
  const state = { data: null, studies: [], viewports: [], activeViewportIndex: 0, activeStudyIndex: 0, layout: '1x1', leadMode: 'all', leadIndex: 0, speedMmPerSecond: 'auto', gainMmPerMv: 'auto', scale: 1, cursor: null, caliperMode: false, caliperType: null, calipers: [], draftCaliper: null, selectedCaliperIndex: -1, caliperInteraction: null, analysis: null, analysisRunId: 0, cursorFrame: 0 };
  const plot = { left: 58, right: 26, top: 30, bottom: 26 };
  const paper = { pixelsPerMm: 8 };

  const $ = id => document.getElementById(id);
  const layouts = ['1x1', '1x2', '2x1', '1x3', '3x1', '2x2', '2x3', '3x2', '3x3'];

  function showError(message) {
    if (!$('viewerShell')) {
      document.body.innerHTML = '<div class="error"><h2>VEXA ECG Error</h2><p>' + message + '</p></div>';
      return;
    }
    $('studyTitle').textContent = 'VEXA ECG Error';
    $('studySub').textContent = message;
    const output = $('analysisOutput');
    if (output) output.textContent = message;
    state.data = null;
    state.studies = [];
    state.activeStudyIndex = -1;
    state.viewports.forEach(viewport => { viewport.studyIndex = null; viewport.calipers = []; });
    updateEmptyPanels();
    drawAllViewports();
  }

  function fetchJson(url) {
    return fetch(url).then(response => response.text().then(text => {
      if (!response.ok) throw new Error('Waveform data not found');
      try {
        return JSON.parse(text);
      } catch {
        throw new Error('Waveform endpoint returned HTML. Restart dicomweb-pacs to enable ECG multi-study support.');
      }
    }));
  }

  function paperPixelsPerMm() {
    return paper.pixelsPerMm * state.scale;
  }

  function drawGrid() {
    const small = paperPixelsPerMm();
    const large = small * 5;
    ctx.fillStyle = '#fff7f7';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let x = 0; x < canvas.width; x += small) { ctx.strokeStyle = '#fecaca'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke(); }
    for (let y = 0; y < canvas.height; y += small) { ctx.strokeStyle = '#fecaca'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke(); }
    for (let x = 0; x < canvas.width; x += large) { ctx.strokeStyle = '#fca5a5'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke(); }
    for (let y = 0; y < canvas.height; y += large) { ctx.strokeStyle = '#fca5a5'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke(); }
  }

  function drawGridOn(context, targetCanvas) {
    context.fillStyle = '#fff7f7';
    context.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
    for (let x = 0; x < targetCanvas.width; x += 12) { context.strokeStyle = '#fecaca'; context.lineWidth = 1; context.beginPath(); context.moveTo(x, 0); context.lineTo(x, targetCanvas.height); context.stroke(); }
    for (let y = 0; y < targetCanvas.height; y += 12) { context.strokeStyle = '#fecaca'; context.lineWidth = 1; context.beginPath(); context.moveTo(0, y); context.lineTo(targetCanvas.width, y); context.stroke(); }
    for (let x = 0; x < targetCanvas.width; x += 60) { context.strokeStyle = '#fca5a5'; context.lineWidth = 1; context.beginPath(); context.moveTo(x, 0); context.lineTo(x, targetCanvas.height); context.stroke(); }
    for (let y = 0; y < targetCanvas.height; y += 60) { context.strokeStyle = '#fca5a5'; context.lineWidth = 1; context.beginPath(); context.moveTo(0, y); context.lineTo(targetCanvas.width, y); context.stroke(); }
  }

  function selectedChannels() {
    if (!state.data) return [];
    if (state.leadMode === 'single') return [state.data.channels[state.leadIndex]].filter(Boolean);
    return state.data.channels;
  }

  function createViewportModel(index, previous) {
    return {
      element: null,
      label: null,
      canvas: null,
      ctx: null,
      studyIndex: previous ? previous.studyIndex : (index === 0 && state.viewports.length === 0 ? 0 : null),
      leadMode: previous?.leadMode || 'all',
      leadIndex: previous?.leadIndex || 0,
      speedMmPerSecond: previous?.speedMmPerSecond ?? 'auto',
      gainMmPerMv: previous?.gainMmPerMv ?? 'auto',
      scale: previous?.scale || 1,
      caliperMode: previous?.caliperMode || false,
      caliperType: previous?.caliperType || null,
      calipers: previous?.calipers || [],
    };
  }

  function applyViewportState(viewport) {
    state.activeStudyIndex = Number.isInteger(viewport.studyIndex) ? viewport.studyIndex : -1;
    state.data = Number.isInteger(viewport.studyIndex) ? state.studies[viewport.studyIndex] : null;
    state.leadMode = viewport.leadMode || 'all';
    state.leadIndex = viewport.leadIndex || 0;
    state.speedMmPerSecond = viewport.speedMmPerSecond ?? 'auto';
    state.gainMmPerMv = viewport.gainMmPerMv ?? 'auto';
    state.scale = viewport.scale || 1;
    state.caliperMode = viewport.caliperMode || false;
    state.caliperType = viewport.caliperType || null;
    state.calipers = viewport.calipers || [];
  }

  function saveActiveViewportState() {
    const viewport = state.viewports[state.activeViewportIndex];
    if (!viewport) return;
    viewport.studyIndex = state.activeStudyIndex >= 0 ? state.activeStudyIndex : null;
    viewport.leadMode = state.leadMode;
    viewport.leadIndex = state.leadIndex;
    viewport.speedMmPerSecond = state.speedMmPerSecond;
    viewport.gainMmPerMv = state.gainMmPerMv;
    viewport.scale = state.scale;
    viewport.caliperMode = state.caliperMode;
    viewport.caliperType = state.caliperType;
    viewport.calipers = state.calipers;
  }

  function currentDuration(channels = selectedChannels()) {
    if (!state.data) return 1;
    return state.data.durationSeconds || Math.max(...channels.flatMap(ch => ch.points.map(p => p[0])), 1);
  }

  function isFixedSpeed() {
    return state.speedMmPerSecond !== 'auto';
  }

  function isFixedGain() {
    return state.gainMmPerMv !== 'auto';
  }

  function timeToCanvasX(time, duration, plotWidth) {
    if (!isFixedSpeed()) return plot.left + (time / duration) * plotWidth;
    return plot.left + time * Number(state.speedMmPerSecond) * paperPixelsPerMm();
  }

  function canvasXToTime(x, duration, plotWidth) {
    if (!isFixedSpeed()) return ((x - plot.left) / plotWidth) * duration;
    return (x - plot.left) / (Number(state.speedMmPerSecond) * paperPixelsPerMm());
  }

  function valueToCanvasY(value, channel, centerY, amplitude) {
    if (isFixedGain()) return centerY - channelValueToMv(value, channel.unit) * Number(state.gainMmPerMv) * paperPixelsPerMm();
    const range = channel.maximum - channel.minimum || 1;
    const normalized = (value - channel.minimum) / range - 0.5;
    return centerY - normalized * 2 * amplitude * state.scale;
  }

  function canvasYToValue(y, channel, centerY, amplitude) {
    if (isFixedGain()) return mvToChannelValue((centerY - y) / (Number(state.gainMmPerMv) * paperPixelsPerMm()), channel.unit);
    const range = channel.maximum - channel.minimum || 1;
    const normalized = (centerY - y) / (2 * amplitude * state.scale);
    return (normalized + 0.5) * range + channel.minimum;
  }

  function channelValueToMv(value, unit) {
    const normalizedUnit = String(unit || '').toLowerCase();
    if (normalizedUnit.includes('uv') || normalizedUnit.includes('micro')) return value / 1000;
    return value;
  }

  function mvToChannelValue(value, unit) {
    const normalizedUnit = String(unit || '').toLowerCase();
    if (normalizedUnit.includes('uv') || normalizedUnit.includes('micro')) return value * 1000;
    return value;
  }

  function selectedTimeCaliper() {
    if (state.selectedCaliperIndex >= 0 && state.calipers[state.selectedCaliperIndex]?.type === 'time') return state.calipers[state.selectedCaliperIndex];
    return state.calipers.find(caliper => caliper.type === 'time') || null;
  }

  function drawSelectedRange(channels, duration) {
    const caliper = selectedTimeCaliper();
    if (!caliper) return;
    const plotWidth = canvas.width - plot.left - plot.right;
    const startX = timeToCanvasX(Math.min(caliper.start.time, caliper.end.time), duration, plotWidth);
    const endX = timeToCanvasX(Math.max(caliper.start.time, caliper.end.time), duration, plotWidth);
    const x = Math.max(plot.left, Math.min(startX, endX));
    const width = Math.min(canvas.width - plot.right, Math.max(startX, endX)) - x;
    if (width <= 0) return;
    ctx.fillStyle = 'rgba(250, 204, 21, 0.58)';
    ctx.fillRect(x, plot.top, width, canvas.height - plot.top - plot.bottom);
  }

  function fixedGainRowHeight(channels) {
    if (!isFixedGain()) return (720 - plot.top - plot.bottom) / Math.max(1, channels.length);
    const gain = Number(state.gainMmPerMv);
    const maxAbsMv = Math.max(
      0.35,
      ...channels.flatMap(channel => [
        Math.abs(channelValueToMv(channel.minimum, channel.unit)),
        Math.abs(channelValueToMv(channel.maximum, channel.unit)),
      ])
    );
    return Math.max(90, Math.ceil(maxAbsMv * 2 * gain * paperPixelsPerMm() + 80));
  }

  function applyCanvasPaperSize(channels, duration) {
    const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const viewportWidth = Math.max(640, canvas.parentElement?.clientWidth || 0);
    const viewportHeight = Math.max(360, (canvas.parentElement?.clientHeight || 0) - 27);
    const nextWidth = isFixedSpeed()
      ? Math.max(320, Math.ceil(plot.left + plot.right + duration * Number(state.speedMmPerSecond) * paperPixelsPerMm()))
      : Math.ceil(viewportWidth * pixelRatio);
    const rowHeight = fixedGainRowHeight(channels);
    const nextHeight = isFixedGain()
      ? Math.max(180, Math.ceil(plot.top + plot.bottom + rowHeight * Math.max(1, channels.length)))
      : Math.ceil(viewportHeight * pixelRatio);
    if (canvas.width !== nextWidth) canvas.width = nextWidth;
    if (canvas.height !== nextHeight) canvas.height = nextHeight;
    canvas.style.width = isFixedSpeed() ? nextWidth + 'px' : '100%';
    canvas.style.height = isFixedGain() ? nextHeight + 'px' : '100%';
  }

  function drawWaveform() {
    if (!canvas || !ctx) return;
    if (!state.data) {
      drawEmptyViewport();
      return;
    }
    const channels = selectedChannels();
    const left = plot.left, right = plot.right, top = plot.top, bottom = plot.bottom;
    const duration = currentDuration(channels);
    applyCanvasPaperSize(channels, duration);
    drawGrid();
    const plotWidth = canvas.width - left - right;
    const rowHeight = (canvas.height - top - bottom) / Math.max(1, channels.length);
    drawSelectedRange(channels, duration);

    channels.forEach((channel, index) => {
      const centerY = top + rowHeight * index + rowHeight / 2;
      const amplitude = Math.max(18, rowHeight * 0.34);
      ctx.strokeStyle = '#061018';
      ctx.lineWidth = Math.max(1.35, Math.min(2.1, (window.devicePixelRatio || 1) * 1.2));
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      let hasPoint = false;
      channel.points.forEach((point, pointIndex) => {
        const x = timeToCanvasX(point[0], duration, plotWidth);
        const y = valueToCanvasY(point[1], channel, centerY, amplitude);
        if (x < left - 2 || x > canvas.width - right + 2) return;
        if (!hasPoint || pointIndex === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        hasPoint = true;
      });
      ctx.stroke();
      ctx.fillStyle = '#111827';
      ctx.font = '600 15px Consolas, "Cascadia Mono", monospace';
      ctx.fillText(channel.label, 10, centerY - 8);
    });

    if (state.cursor) {
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(state.cursor.x, 0);
      ctx.lineTo(state.cursor.x, canvas.height);
      ctx.stroke();
    }
    state.calipers.forEach((caliper, index) => drawCaliper(caliper, index + 1, index === state.selectedCaliperIndex));
    if (state.draftCaliper) drawCaliper(state.draftCaliper, state.calipers.length + 1, true);
  }

  function drawEmptyViewport() {
    canvas.width = 1600;
    canvas.height = 720;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    ctx.fillStyle = '#17151a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#3a3540';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 20px "Segoe UI Variable Text", "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Select a study from the Study List for this viewport', canvas.width / 2, canvas.height / 2);
    ctx.textAlign = 'left';
  }

  function drawCaliper(caliper, index, selected) {
    const start = waveformPointToCanvas(caliper.start);
    const end = waveformPointToCanvas(caliper.end);
    if (!start || !end) return;
    const geometry = channelGeometry(caliper.lead);
    if (!geometry) return;
    const color = selected ? '#dc2626' : '#2563eb';
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = selected ? 3 : 2;
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    if (caliper.type === 'amplitude') {
      const anchorX = start.x;
      const halfWidth = Math.min(70, Math.max(35, geometry.plotWidth * 0.045));
      ctx.moveTo(anchorX - halfWidth, start.y);
      ctx.lineTo(anchorX + halfWidth, start.y);
      ctx.moveTo(anchorX - halfWidth, end.y);
      ctx.lineTo(anchorX + halfWidth, end.y);
      ctx.moveTo(anchorX, start.y);
      ctx.lineTo(anchorX, end.y);
    } else {
      const guideY = geometry.top + 20;
      ctx.moveTo(start.x, geometry.top + 5);
      ctx.lineTo(start.x, geometry.bottom - 5);
      ctx.moveTo(end.x, geometry.top + 5);
      ctx.lineTo(end.x, geometry.bottom - 5);
      ctx.moveTo(start.x, guideY);
      ctx.lineTo(end.x, guideY);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    const handles = caliper.type === 'amplitude'
      ? [{ x: start.x, y: start.y }, { x: start.x, y: end.y }]
      : [{ x: start.x, y: geometry.top + 20 }, { x: end.x, y: geometry.top + 20 }];
    handles.forEach(point => {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.strokeStyle = color;
    });
    const midX = caliper.type === 'amplitude' ? start.x + 12 : (start.x + end.x) / 2 + 8;
    const midY = caliper.type === 'amplitude' ? (start.y + end.y) / 2 - 8 : geometry.top + 14;
    ctx.font = '600 13px Consolas, "Cascadia Mono", monospace';
    const label = '#' + index + ' ' + formatCaliper(caliper).measurement;
    const labelWidth = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
    ctx.fillRect(midX - 4, midY - 15, labelWidth + 8, 20);
    ctx.fillStyle = '#111827';
    ctx.fillText(label, midX, midY);
  }

  function updatePanels() {
    const data = state.data;
    if (!data) {
      updateEmptyPanels();
      return;
    }
    const patientName = formatPatientName(data.patientName);
    $('studyTitle').textContent = data.studyDescription || 'ECG Waveform';
    $('studySub').textContent = [patientName, data.patientId, formatDate(data.studyDate), formatTime(data.studyTime)].filter(Boolean).join(' · ');
    $('listPatient').textContent = patientName || data.patientId || 'ECG Study';
    $('listPatientMeta').textContent = [data.patientId, state.studies.length + ' ECG studies'].filter(Boolean).join(' - ') || 'Patient metadata unavailable';
    $('sampling').textContent = data.samplingFrequency ? data.samplingFrequency + ' Hz' : '-';
    $('duration').textContent = data.durationSeconds ? data.durationSeconds + ' s' : '-';
    updateSelectionReadout();
    const measurements = $('measurements');
    const annotationSection = $('annotationSection');
    measurements.innerHTML = '<thead><tr><th>Item</th><th>Value</th></tr></thead><tbody></tbody>';
    const measurementBody = measurements.querySelector('tbody');
    (data.annotations || []).forEach(row => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>' + row.tag + '</td><td>' + row.value + '</td>';
      measurementBody.appendChild(tr);
    });
    if (annotationSection) annotationSection.style.display = measurementBody.children.length ? '' : 'none';
    updateMarkers();
    updateChannelTable();
    const leadSelect = $('leadSelect');
    leadSelect.innerHTML = '';
    data.channels.forEach((channel, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = channel.label;
      leadSelect.appendChild(option);
    });
    renderStudyCards();
    renderComparisonGrid();
  }

  function updateEmptyPanels() {
    $('studyTitle').textContent = 'Empty Viewport';
    $('studySub').textContent = 'Select an ECG from the Study List for the active viewport';
    $('sampling').textContent = '-';
    $('duration').textContent = '-';
    $('cursorTime').textContent = '-';
    $('cursorValue').textContent = '-';
    const leadSelect = $('leadSelect');
    leadSelect.innerHTML = '';
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No lead';
    leadSelect.appendChild(option);
    const measurements = $('measurements');
    if (measurements) measurements.innerHTML = '<thead><tr><th>Item</th><th>Value</th></tr></thead><tbody><tr><td colspan="2" class="muted-cell">No study selected.</td></tr></tbody>';
    updateSelectionReadout();
    updateMarkers();
    updateChannelTable();
    renderStudyCards();
  }

  function updateCalibrationControls() {
    const speedSelect = $('speedSelect');
    const gainSelect = $('gainSelect');
    const zoomSlider = $('zoomSlider');
    const zoomReadout = $('zoomReadout');
    if (speedSelect) speedSelect.value = String(state.speedMmPerSecond);
    if (gainSelect) gainSelect.value = String(state.gainMmPerMv);
    if (zoomSlider) zoomSlider.value = String(Math.round(state.scale * 100));
    if (zoomReadout) zoomReadout.textContent = Math.round(state.scale * 100) + '%';
  }

  function updateSelectionReadout() {
    const readout = $('selectionReadout');
    if (!readout) return;
    if (!state.data) {
      readout.innerHTML = '<strong>-</strong>Minimum: -<br />Maximum: -';
      return;
    }
    const channels = selectedChannels();
    const channel = channels[0];
    if (!channel) {
      readout.innerHTML = '<strong>-</strong>Minimum: -<br />Maximum: -';
      return;
    }
    const caliper = selectedTimeCaliper();
    const startTime = caliper ? Math.min(caliper.start.time, caliper.end.time) : 0;
    const endTime = caliper ? Math.max(caliper.start.time, caliper.end.time) : currentDuration(channels);
    const values = channel.points
      .filter(point => point[0] >= startTime && point[0] <= endTime)
      .map(point => Number(point[1]))
      .filter(Number.isFinite);
    const min = values.length ? Math.min(...values) : channel.minimum;
    const max = values.length ? Math.max(...values) : channel.maximum;
    readout.innerHTML = '<strong>' + escapeHtml(channel.label || '-') + '</strong>' +
      'Minimum: ' + formatNumber(min, 3) + ' ' + escapeHtml(channel.unit || 'mV') + '<br />' +
      'Maximum: ' + formatNumber(max, 3) + ' ' + escapeHtml(channel.unit || 'mV');
  }

  function studyDetail(data) {
    return [data.studyTime ? formatTime(data.studyTime) : '', data.channels.length + ' leads', data.durationSeconds ? data.durationSeconds + ' s' : ''].filter(Boolean).join(' - ');
  }

  function renderStudyCards() {
    const container = $('studyCards');
    if (!container) return;
    const query = String($('studySearch')?.value || '').trim().toLowerCase();
    container.innerHTML = '';
    let visibleCount = 0;
    state.studies.forEach((study, index) => {
      const searchable = [study.studyDescription, study.studyDate, formatDate(study.studyDate), study.studyTime].filter(Boolean).join(' ').toLowerCase();
      if (query && !searchable.includes(query)) return;
      visibleCount += 1;
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'study-card' + (index === state.activeStudyIndex ? ' active' : '');
      card.setAttribute('aria-pressed', index === state.activeStudyIndex ? 'true' : 'false');
      card.innerHTML = '<div class="study-card-top"><span class="study-badge">12-LEAD ECG</span><span class="patient-meta">' + escapeHtml(formatDate(study.studyDate)) + '</span></div>' +
        '<div class="study-name">' + escapeHtml(study.studyDescription || 'ECG Waveform') + '</div>' +
        '<div class="study-detail">' + escapeHtml(studyDetail(study)) + '</div><div class="study-wave"></div>';
      card.addEventListener('click', () => assignStudyToActiveViewport(index));
      container.appendChild(card);
    });
    if ($('studyCount')) $('studyCount').textContent = String(visibleCount);
    if (!visibleCount) container.innerHTML = '<div class="muted-cell" style="padding:12px 8px">No matching studies.</div>';
  }

  function renderComparisonGrid() {
    const container = $('comparisonGrid');
    if (!container) return;
    container.innerHTML = '';
    return;
    state.studies.forEach((study, index) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'compare-card' + (index === state.activeStudyIndex ? ' active' : '');
      card.innerHTML = '<div class="compare-title"><span>' + formatDate(study.studyDate) + ' ' + formatTime(study.studyTime) + '</span><span>' + (study.durationSeconds || '-') + ' s</span></div>';
      const mini = document.createElement('canvas');
      mini.className = 'compare-canvas';
      mini.width = 720;
      mini.height = 220;
      card.appendChild(mini);
      card.addEventListener('click', () => setActiveStudy(index));
      container.appendChild(card);
      drawStudyPreview(mini, study);
    });
  }

  function drawStudyPreview(targetCanvas, data) {
    const context = targetCanvas.getContext('2d');
    const channels = data.channels.slice(0, 3);
    drawGridOn(context, targetCanvas);
    const left = 42, right = 14, top = 20, bottom = 18;
    const width = targetCanvas.width - left - right;
    const rowHeight = (targetCanvas.height - top - bottom) / Math.max(1, channels.length);
    const duration = data.durationSeconds || Math.max(...channels.flatMap(ch => ch.points.map(p => p[0])), 1);
    channels.forEach((channel, index) => {
      const centerY = top + rowHeight * index + rowHeight / 2;
      const range = channel.maximum - channel.minimum || 1;
      const amplitude = Math.max(16, rowHeight * 0.32);
      context.strokeStyle = '#020617';
      context.lineWidth = 2;
      context.beginPath();
      channel.points.forEach((point, pointIndex) => {
        const x = left + (point[0] / duration) * width;
        const y = centerY - (((point[1] - channel.minimum) / range) - 0.5) * 2 * amplitude;
        if (pointIndex === 0) context.moveTo(x, y); else context.lineTo(x, y);
      });
      context.stroke();
      context.fillStyle = '#111827';
      context.font = '600 11px Consolas, "Cascadia Mono", monospace';
      context.fillText(channel.label, 8, centerY - 4);
    });
  }

  function setActiveStudy(index) {
    const next = state.studies[index];
    if (!next) return;
    state.activeStudyIndex = index;
    state.data = next;
    state.leadMode = 'all';
    state.leadIndex = 0;
    state.cursor = null;
    state.calipers = [];
    state.draftCaliper = null;
    state.selectedCaliperIndex = -1;
    state.caliperInteraction = null;
    state.analysisRunId += 1;
    state.analysis = null;
    $('analysisResult').hidden = true;
    $('analysisProgress').hidden = true;
    $('analysisOutput').textContent = 'Select Analyze ECG to generate computer interpretation and coded findings.';
    const analyzeButton = $('analyzePanelBtn');
    analyzeButton.disabled = false;
    analyzeButton.querySelector('span').textContent = 'Analyze ECG';
    updatePanels();
    drawWaveform();
  }

  function assignStudyToActiveViewport(index) {
    const viewport = state.viewports[state.activeViewportIndex];
    if (viewport) {
      viewport.studyIndex = index;
      viewport.leadMode = 'all';
      viewport.leadIndex = 0;
      viewport.calipers = [];
      state.calipers = viewport.calipers;
    }
    setActiveStudy(index);
    saveActiveViewportState();
    renderViewportShell();
    drawAllViewports();
  }

  function layoutCount(layout) {
    const [rows, columns] = layout.split('x').map(Number);
    return rows * columns;
  }

  function layoutIcon(layout, size = 24) {
    const [rows, columns] = layout.split('x').map(Number);
    const margin = size === 24 ? 4 : 2;
    const gap = size === 24 ? 2 : 1.5;
    const width = (size - margin * 2 - gap * (columns - 1)) / columns;
    const height = (size - margin * 2 - gap * (rows - 1)) / rows;
    let icon = '';
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const x = margin + column * (width + gap);
        const y = margin + row * (height + gap);
        icon += '<rect x="' + x + '" y="' + y + '" width="' + width + '" height="' + height + '" rx="1" />';
      }
    }
    return icon;
  }

  function updateLayoutButton() {
    const button = $('viewportLayoutBtn');
    const label = 'Viewport Layout: ' + state.layout;
    button.setAttribute('aria-label', label);
    button.dataset.tooltip = state.layout;
    button.querySelector('svg').innerHTML = layoutIcon(state.layout);
    document.querySelectorAll('.layout-option').forEach(option => option.classList.toggle('active', option.dataset.layout === state.layout));
  }

  function renderLayoutMenu() {
    const menu = $('layoutMenu');
    menu.innerHTML = '';
    layouts.forEach(layout => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'layout-option';
      option.dataset.layout = layout;
      option.setAttribute('role', 'menuitem');
      option.setAttribute('aria-label', 'Viewport ' + layout);
      option.innerHTML = '<svg viewBox="0 0 32 32" aria-hidden="true">' + layoutIcon(layout, 32) + '</svg><span>' + layout.replace('x', ' x ') + '</span>';
      option.addEventListener('click', () => {
        saveActiveViewportState();
        state.layout = layout;
        state.selectedCaliperIndex = -1;
        state.caliperInteraction = null;
        createViewports();
        updateLayoutButton();
        menu.hidden = true;
        drawAllViewports();
      });
      menu.appendChild(option);
    });
  }

  function updateLeadModeButton() {
    const button = $('leadModeBtn');
    const single = state.leadMode === 'single';
    const label = single ? 'Single Lead' : 'All Leads';
    button.setAttribute('aria-label', label);
    button.dataset.tooltip = label;
    button.classList.toggle('active', single);
    button.querySelector('svg').innerHTML = single
      ? '<path d="M4 12h4l2-5 4 10 2-5h4" />'
      : '<path d="M4 7h16M4 12h16M4 17h16" />';
    $('leadSelect').style.display = single ? '' : 'none';
  }

  function updatePanelButtons() {
    const shell = $('viewerShell');
    const studyVisible = !shell.classList.contains('study-panel-hidden');
    const rightVisible = !shell.classList.contains('right-panel-hidden');
    const studyButton = $('toggleStudyPanelBtn');
    const rightButton = $('toggleRightPanelBtn');
    const studyLabel = studyVisible ? 'Collapse Study List' : 'Expand Study List';
    const rightLabel = rightVisible ? 'Collapse Analysis Panel' : 'Expand Analysis Panel';
    studyButton.setAttribute('aria-label', studyLabel);
    studyButton.title = studyLabel;
    rightButton.setAttribute('aria-label', rightLabel);
    rightButton.title = rightLabel;
    studyButton.querySelector('svg').innerHTML = studyVisible ? '<path d="m14 7-5 5 5 5" />' : '<path d="m10 7 5 5-5 5" />';
    rightButton.querySelector('svg').innerHTML = rightVisible ? '<path d="m10 7 5 5-5 5" />' : '<path d="m14 7-5 5 5 5" />';
  }

  function togglePanel(panel) {
    $('viewerShell').classList.toggle(panel === 'study' ? 'study-panel-hidden' : 'right-panel-hidden');
    updatePanelButtons();
  }

  function setupPanelResizer(resizerId, cssVariable, direction, minWidth, maxWidth) {
    const resizer = $(resizerId);
    resizer.addEventListener('pointerdown', event => {
      event.preventDefault();
      const shell = $('viewerShell');
      const startX = event.clientX;
      const startWidth = Number.parseFloat(getComputedStyle(shell).getPropertyValue(cssVariable)) || minWidth;
      resizer.classList.add('dragging');
      const onMove = moveEvent => {
        const width = Math.max(minWidth, Math.min(maxWidth, startWidth + (moveEvent.clientX - startX) * direction));
        shell.style.setProperty(cssVariable, width + 'px');
      };
      const onEnd = () => {
        resizer.classList.remove('dragging');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onEnd);
        window.removeEventListener('pointercancel', onEnd);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onEnd);
      window.addEventListener('pointercancel', onEnd);
    });
  }

  function activateViewport(index) {
    const viewport = state.viewports[index];
    if (!viewport) return;
    const changed = index !== state.activeViewportIndex || canvas !== viewport.canvas;
    state.activeViewportIndex = index;
    canvas = viewport.canvas;
    ctx = viewport.ctx;
    applyViewportState(viewport);
    renderViewportShell();
    if (changed) {
      updateLeadModeButton();
      updateCalibrationControls();
      updateCaliperToolButtons();
      updatePanels();
    }
  }

  function renderViewportShell() {
    state.viewports.forEach((viewport, index) => {
      viewport.element.classList.toggle('active', index === state.activeViewportIndex);
      const study = state.studies[viewport.studyIndex];
      viewport.label.textContent = 'Viewport ' + (index + 1) + (study ? ' - ' + formatDate(study.studyDate) + ' ' + formatTime(study.studyTime) : ' - Empty');
    });
  }

  function updateChannelTable() {
    const channels = $('channels');
    if (!channels) return;
    channels.innerHTML = '<thead><tr><th>View</th><th>Lead</th><th>Range</th><th>Unit</th></tr></thead><tbody></tbody>';
    const body = channels.querySelector('tbody');
    const viewports = state.viewports.length ? state.viewports : [{ studyIndex: state.activeStudyIndex }];
    let rowCount = 0;
    viewports.forEach((viewport, viewportIndex) => {
      const study = Number.isInteger(viewport.studyIndex) ? state.studies[viewport.studyIndex] : null;
      if (!study) return;
      study.channels.forEach(channel => {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td>V' + (viewportIndex + 1) + '</td><td>' + channel.label + '</td><td>' + channel.minimum + ' to ' + channel.maximum + '</td><td>' + channel.unit + '</td>';
        body.appendChild(tr);
        rowCount += 1;
      });
    });
    if (!rowCount) body.innerHTML = '<tr><td colspan="4" class="muted-cell">No channel data.</td></tr>';
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  function preferredAnalysisChannel(data) {
    if (!data?.channels?.length) return null;
    return data.channels.find(ch => /^(ii|lead ii)$/i.test(String(ch.label || '').trim())) || data.channels[0];
  }

  function estimateHeartRate(channel) {
    if (!channel?.points?.length) return null;
    const points = channel.points;
    const values = points.map(point => Number(point[1])).filter(Number.isFinite);
    if (values.length < 10) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const threshold = min + (max - min) * 0.72;
    const refractorySeconds = 0.28;
    const peaks = [];
    for (let i = 1; i < points.length - 1; i += 1) {
      const prev = Number(points[i - 1][1]);
      const value = Number(points[i][1]);
      const next = Number(points[i + 1][1]);
      const time = Number(points[i][0]);
      if (!Number.isFinite(value) || !Number.isFinite(time)) continue;
      if (value >= threshold && value >= prev && value > next) {
        if (!peaks.length || time - peaks[peaks.length - 1].time >= refractorySeconds) {
          peaks.push({ time, value });
        } else if (value > peaks[peaks.length - 1].value) {
          peaks[peaks.length - 1] = { time, value };
        }
      }
    }
    if (peaks.length < 2) return null;
    const rr = [];
    for (let i = 1; i < peaks.length; i += 1) rr.push(peaks[i].time - peaks[i - 1].time);
    const avg = rr.reduce((sum, value) => sum + value, 0) / rr.length;
    if (!avg) return null;
    const variance = rr.reduce((sum, value) => sum + Math.pow(value - avg, 2), 0) / rr.length;
    const sd = Math.sqrt(variance);
    return {
      bpm: Math.round(60 / avg),
      rrCount: rr.length,
      rrAverageMs: Math.round(avg * 1000),
      regularity: sd / avg < 0.12 ? 'regular' : 'irregular/variable',
    };
  }

  // === Automated ECG Measurement Functions ===

  /** Find a channel whose label matches the given regex pattern. */
  function findChannelByLabel(data, pattern) {
    if (!data?.channels?.length) return null;
    return data.channels.find(ch => pattern.test(String(ch.label || '').trim())) || null;
  }

  /** Detect R-peak positions using amplitude threshold + local maximum. */
  function detectRPeaks(channel) {
    if (!channel?.points?.length) return [];
    const points = channel.points;
    const values = points.map(p => Number(p[1])).filter(Number.isFinite);
    if (values.length < 10) return [];
    const min = Math.min(...values);
    const max = Math.max(...values);
    const threshold = min + (max - min) * 0.72;
    const refractorySeconds = 0.28;
    const peaks = [];
    for (let i = 1; i < points.length - 1; i++) {
      const prev = Number(points[i - 1][1]);
      const value = Number(points[i][1]);
      const next = Number(points[i + 1][1]);
      const time = Number(points[i][0]);
      if (!Number.isFinite(value) || !Number.isFinite(time)) continue;
      if (value >= threshold && value >= prev && value > next) {
        if (!peaks.length || time - peaks[peaks.length - 1].time >= refractorySeconds) {
          peaks.push({ time, value });
        } else if (value > peaks[peaks.length - 1].value) {
          peaks[peaks.length - 1] = { time, value };
        }
      }
    }
    return peaks;
  }

  /** Estimate sampling interval in ms from consecutive points. */
  function getSamplingIntervalMs(channel) {
    if (!channel?.points?.length || channel.points.length < 2) return 2;
    return (channel.points[1][0] - channel.points[0][0]) * 1000;
  }

  /**
   * Estimate QRS axis from Lead I (horizontal) and Lead aVF (vertical).
   * Formula: axis = atan2(net_aVF, net_I) * 180/pi with quadrant correction.
   * Uses net QRS area (sum of values) in a +/-60ms window around each R-peak.
   * Returns { axisDeg, category } or null if leads unavailable.
   */
  function estimateQrsAxis(data) {
    const leadI = findChannelByLabel(data, /^(i|lead i)$/i);
    const leadF = findChannelByLabel(data, /^(avf|lead avf)$/i);
    if (!leadI || !leadF) return null;
    const prefCh = preferredAnalysisChannel(data);
    const rPeaks = detectRPeaks(prefCh || leadI);
    if (!rPeaks.length) return null;
    const halfWindow = 0.06;
    let sumH = 0, sumV = 0, count = 0;
    for (const peak of rPeaks) {
      const t0 = peak.time - halfWindow, t1 = peak.time + halfWindow;
      let netH = 0, netV = 0, pth = 0, ptv = 0;
      for (const p of leadI.points) { if (p[0] >= t0 && p[0] <= t1) { netH += Number(p[1]); pth++; } }
      for (const p of leadF.points) { if (p[0] >= t0 && p[0] <= t1) { netV += Number(p[1]); ptv++; } }
      if (pth >= 3 && ptv >= 3) { sumH += netH; sumV += netV; count++; }
    }
    if (count < 2) return null;
    const avgH = sumH / count;
    const avgV = sumV / count;
    let axisDeg;
    if (Math.abs(avgH) < 1) {
      axisDeg = avgV >= 0 ? 90 : -90;
    } else {
      axisDeg = Math.atan2(avgV, avgH) * (180 / Math.PI);
    }
    let category;
    if (axisDeg >= -30 && axisDeg <= 90) category = 'within normal range';
    else if (axisDeg >= -90 && axisDeg < -30) category = 'left axis deviation';
    else if (axisDeg > 90 && axisDeg <= 180) category = 'right axis deviation';
    else category = 'extreme axis deviation';
    return { axisDeg: Math.round(axisDeg), category };
  }

  /**
   * Estimate QRS duration from the analysis channel.
   * Detects QRS onset (where slope drops below 8% of max) and QRS offset (J-point).
   * Averages across all beats.
   */
  function estimateQrsDuration(data) {
    const ch = preferredAnalysisChannel(data);
    if (!ch) return null;
    const rPeaks = detectRPeaks(ch);
    if (!rPeaks.length) return null;
    const sms = getSamplingIntervalMs(ch);
    const durations = [];
    for (const peak of rPeaks) {
      const pts = ch.points;
      let peakIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < pts.length; i++) { const d = Math.abs(pts[i][0] - peak.time); if (d < bestDist) { bestDist = d; peakIdx = i; } }
      if (peakIdx < 3 || peakIdx >= pts.length - 3) continue;
      let maxSlope = 0;
      for (let i = Math.max(1, peakIdx - 15); i <= Math.min(pts.length - 1, peakIdx + 15); i++) {
        maxSlope = Math.max(maxSlope, Math.abs(pts[i][1] - pts[i-1][1]));
      }
      const thr = maxSlope * 0.08;
      let onsetIdx = peakIdx;
      for (let i = peakIdx - 1; i >= 1; i--) { if (Math.abs(pts[i][1] - pts[i-1][1]) < thr) { onsetIdx = i; break; } }
      let offsetIdx = peakIdx;
      for (let i = peakIdx + 1; i < pts.length - 1; i++) { if (Math.abs(pts[i+1][1] - pts[i][1]) < thr) { offsetIdx = i; break; } }
      if (offsetIdx > onsetIdx + 5) durations.push((offsetIdx - onsetIdx) * sms);
    }
    if (!durations.length) return null;
    return Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
  }

  /**
   * Estimate QT and QTc (Bazett + Fridericia) from the analysis channel.
   * QT = QRS onset to T-wave end.
   * T-wave end: find T-peak in [200ms, 500ms] region after R-peak,
   * then scan forward for where slope flattens (< 0.3 uV/point).
   */
  function estimateQtInterval(data, rrAverageMs) {
    const ch = preferredAnalysisChannel(data);
    if (!ch || !rrAverageMs) return null;
    const rPeaks = detectRPeaks(ch);
    if (!rPeaks.length) return null;
    const sms = getSamplingIntervalMs(ch);
    const pts = ch.points;
    const qts = [];
    for (const peak of rPeaks) {
      let peakIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < pts.length; i++) { const d = Math.abs(pts[i][0] - peak.time); if (d < bestDist) { bestDist = d; peakIdx = i; } }
      if (peakIdx < 3 || peakIdx >= pts.length - 5) continue;
      let maxSlope = 0;
      for (let i = Math.max(1, peakIdx - 15); i <= Math.min(pts.length - 1, peakIdx + 15); i++) {
        maxSlope = Math.max(maxSlope, Math.abs(pts[i][1] - pts[i-1][1]));
      }
      const thr = maxSlope * 0.08;
      let onsetIdx = peakIdx;
      for (let i = peakIdx - 1; i >= 1; i--) { if (Math.abs(pts[i][1] - pts[i-1][1]) < thr) { onsetIdx = i; break; } }
      const tStart = Math.min(pts.length - 1, peakIdx + Math.round(200 / sms));
      const tEnd = Math.min(pts.length - 1, peakIdx + Math.round(500 / sms));
      if (tStart >= tEnd) continue;
      let tPeakIdx = tStart;
      let tPeakAbs = Math.abs(pts[tStart][1]);
      for (let i = tStart + 1; i <= tEnd; i++) { const a = Math.abs(pts[i][1]); if (a > tPeakAbs) { tPeakAbs = a; tPeakIdx = i; } }
      if (tPeakAbs < Math.abs(pts[peakIdx][1]) * 0.08 || tPeakAbs < 5) continue;
      let tEndIdx = tPeakIdx;
      for (let i = tPeakIdx + 1; i < pts.length - 1; i++) { if (Math.abs(pts[i+1][1] - pts[i][1]) < 0.3) { tEndIdx = i; break; } }
      if (tEndIdx > onsetIdx) {
        const qt = (tEndIdx - onsetIdx) * sms;
        if (qt > 200 && qt < 600) qts.push(qt);
      }
    }
    if (!qts.length) return null;
    const avgQt = qts.reduce((a, b) => a + b, 0) / qts.length;
    const rrSec = rrAverageMs / 1000;
    return {
      qt: Math.round(avgQt),
      qtcBazett: Math.round(avgQt / Math.sqrt(rrSec)),
      qtcFridericia: Math.round(avgQt / Math.cbrt(rrSec)),
    };
  }

  /**
   * Attempt automated PR interval measurement via P-wave detection.
   * P-waves are small (~0.1-0.2mV) making this inherently unreliable.
   * Falls back to null = 'requires physician review'.
   */
  function estimatePrInterval(data) {
    const ch = preferredAnalysisChannel(data);
    if (!ch) return null;
    const rPeaks = detectRPeaks(ch);
    if (!rPeaks.length) return null;
    const sms = getSamplingIntervalMs(ch);
    const pts = ch.points;
    for (const peak of rPeaks) {
      let peakIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < pts.length; i++) { const d = Math.abs(pts[i][0] - peak.time); if (d < bestDist) { bestDist = d; peakIdx = i; } }
      if (peakIdx < 10) continue;
      let maxSlope = 0;
      for (let i = Math.max(1, peakIdx - 15); i <= Math.min(pts.length - 1, peakIdx + 15); i++) {
        maxSlope = Math.max(maxSlope, Math.abs(pts[i][1] - pts[i-1][1]));
      }
      const thr = maxSlope * 0.08;
      let onsetIdx = peakIdx;
      for (let i = peakIdx - 1; i >= 1; i--) { if (Math.abs(pts[i][1] - pts[i-1][1]) < thr) { onsetIdx = i; break; } }
      const searchStart = Math.max(0, onsetIdx - Math.round(200 / sms));
      const searchEnd = Math.max(0, onsetIdx - Math.round(80 / sms));
      if (searchStart >= searchEnd) continue;
      let pMax = -Infinity, pMin = Infinity;
      for (let i = searchStart; i < searchEnd; i++) {
        pMax = Math.max(pMax, pts[i][1]);
        pMin = Math.min(pMin, pts[i][1]);
      }
      const pAmp = pMax - pMin;
      const rAmp = Math.abs(pts[peakIdx][1]);
      if (pAmp > rAmp * 0.04 && pAmp > 3 && pAmp < rAmp * 0.5) {
        const pPeakVal = pMax > Math.abs(pMin) ? pMax : pMin;
        let pPeakIdx = searchStart;
        for (let i = searchStart; i < searchEnd; i++) { if (pts[i][1] === pPeakVal) { pPeakIdx = i; break; } }
        let pOnset = pPeakIdx;
        for (let i = pPeakIdx - 1; i >= searchStart && i > 0; i--) {
          if (Math.abs(pts[i][1] - pts[i-1][1]) < 0.2) { pOnset = i; break; }
        }
        const pr = (onsetIdx - pOnset) * sms;
        if (pr > 80 && pr < 300) return Math.round(pr);
      }
    }
    return null; // P-wave not reliably detected
  }

  /**
   * Screen ST-T segments across all leads.
   * Measures ST deviation at J-point + 60ms relative to PR segment baseline.
   * Thresholds: >100 uV elevation (limb) / >200 uV (precordial), >50 uV depression.
   */
  function estimateStAssessment(data) {
    if (!data?.channels?.length) return null;
    const prefCh = preferredAnalysisChannel(data);
    if (!prefCh) return null;
    const rPeaks = detectRPeaks(prefCh);
    if (!rPeaks.length) return null;
    const sms = getSamplingIntervalMs(prefCh);
    const findings = [];
    for (const ch of data.channels) {
      const label = String(ch.label || '');
      const isPrecordial = /^v[1-6]/i.test(label.replace(/^lead\s+/i, ''));
      const elevThr = isPrecordial ? 200 : 100;
      let totalDev = 0, beats = 0;
      const pts = ch.points;
      for (const peak of rPeaks) {
        let peakIdx = 0;
        let bestDist = Infinity;
        for (let i = 0; i < pts.length; i++) { const d = Math.abs(pts[i][0] - peak.time); if (d < bestDist) { bestDist = d; peakIdx = i; } }
        if (peakIdx < 3) continue;
        let maxSlope = 0;
        for (let i = Math.max(1, peakIdx - 15); i <= Math.min(pts.length - 1, peakIdx + 15); i++) {
          maxSlope = Math.max(maxSlope, Math.abs(pts[i][1] - pts[i-1][1]));
        }
        const thr = maxSlope * 0.08;
        let onsetIdx = peakIdx;
        for (let i = peakIdx - 1; i >= 1; i--) { if (Math.abs(pts[i][1] - pts[i-1][1]) < thr) { onsetIdx = i; break; } }
        const prStart = Math.max(0, onsetIdx - Math.round(20 / sms));
        let baseline = 0, blCount = 0;
        for (let i = prStart; i < onsetIdx && i < pts.length; i++) { baseline += pts[i][1]; blCount++; }
        if (blCount < 2) continue;
        baseline /= blCount;
        let offsetIdx = peakIdx;
        for (let i = peakIdx + 1; i < pts.length - 1; i++) { if (Math.abs(pts[i+1][1] - pts[i][1]) < thr) { offsetIdx = i; break; } }
        const stIdx = Math.min(pts.length - 1, offsetIdx + Math.round(60 / sms));
        totalDev += pts[stIdx][1] - baseline;
        beats++;
      }
      if (beats < 2) continue;
      const avgDev = totalDev / beats;
      const status = avgDev > elevThr ? 'elevation' : avgDev < -50 ? 'depression' : 'normal';
      if (status !== 'normal') findings.push({ label, deviation: Math.round(avgDev * 10) / 10, status });
    }
    return findings.length ? findings : null;
  }

  // === End of ECG Measurement Functions ===

  function safeMeasurement(measurement, fallback = null) {
    try { return measurement(); } catch { return fallback; }
  }

  function buildAnalysis() {
    const data = state.data;
    if (!data) return null;
    const channel = preferredAnalysisChannel(data);
    const hr = estimateHeartRate(channel);
    const pr = safeMeasurement(() => estimatePrInterval(data));
    const qrsDuration = safeMeasurement(() => estimateQrsDuration(data));
    const qt = safeMeasurement(() => estimateQtInterval(data, hr?.rrAverageMs));
    const axis = safeMeasurement(() => estimateQrsAxis(data));
    const stFindings = safeMeasurement(() => estimateStAssessment(data), []) || [];
    const impression = window.VexaEcgAnalysis.buildClinicalImpression({
      heartRate: hr?.bpm,
      regularity: hr?.regularity,
      qrsDuration,
      qtcFridericia: qt?.qtcFridericia,
      axisDeg: axis?.axisDeg,
      stFindings,
      leadCount: data.channels?.length || 0,
    });
    const caliperLines = state.calipers.map((caliper, index) => {
      const formatted = formatCaliper(caliper);
      return formatted.type + ' caliper #' + (index + 1) + ' (' + caliper.lead + '): ' + formatted.measurement;
    });
    const lines = [
      'COMPUTER INTERPRETATION',
      impression.statusLabel,
      'Urgency: ' + impression.urgency,
      impression.headline,
      impression.summary,
      '',
      'CODED FINDINGS',
      ...(impression.findings.length
        ? impression.findings.map(item => window.VexaEcgAnalysis.formatFindingCode(item.code) + ' | ' + item.term + ' | ' + item.termId)
        : ['No coded finding']),
      '',
      'MEASUREMENTS',
      'Sampling: ' + (data.samplingFrequency ? data.samplingFrequency + ' Hz' : 'not available'),
      'Duration: ' + (data.durationSeconds ? data.durationSeconds + ' s' : 'not available'),
      'PR: ' + (pr ? pr + ' ms' : 'not measured'),
      'QRS: ' + (qrsDuration ? qrsDuration + ' ms' : 'not measured'),
      'QT/QTc: ' + (qt ? qt.qt + ' ms / QTcF ' + qt.qtcFridericia + ' ms / QTcB ' + qt.qtcBazett + ' ms' : 'not measured'),
      'QRS axis: ' + (axis ? axis.axisDeg + '\u00b0' : 'not available'),
      ...(caliperLines.length ? ['Manual calipers:', ...caliperLines] : []),
    ];
    return {
      studyInstanceUid: data.studyInstanceUid || studyUid,
      patientId: data.patientId || '',
      patientName: data.patientName || '',
      text: lines.join('\n'),
      impression,
      measurements: { heartRate: hr, pr, qrsDuration, qt, axis, stFindings, calipers: state.calipers.map(formatCaliper) },
    };
  }

  function delay(milliseconds) {
    return new Promise(resolve => window.setTimeout(resolve, milliseconds));
  }

  function setAnalysisProgress(label, percent) {
    $('analysisProgressLabel').textContent = label;
    $('analysisProgressPercent').textContent = percent + '%';
    $('analysisProgressFill').style.width = percent + '%';
  }

  function renderImpression(analysis) {
    const result = $('analysisResult');
    const impression = analysis.impression;
    $('impressionCard').dataset.severity = impression.urgency;
    $('impressionHeadline').textContent = impression.headline;
    $('impressionSummary').textContent = impression.summary;
    $('analysisDisclaimer').textContent = impression.statusLabel;
    const findings = impression.findings.length
      ? impression.findings
      : [{ code: '—', term: 'No coded finding', termId: 'Tidak ada temuan berkode', urgency: 'routine' }];
    $('findingList').innerHTML = findings.map(item =>
      '<div class="finding-row" data-status="' + escapeHtml(item.urgency) + '"><span class="finding-dot"></span><span class="finding-label">' + escapeHtml(window.VexaEcgAnalysis.formatFindingCode(item.code)) + '</span><span class="finding-detail"><strong>' + escapeHtml(item.term) + '</strong><br>' + escapeHtml(item.termId) + '</span></div>'
    ).join('');
    result.hidden = false;
  }

  async function typeAnalysisText(text, runId) {
    const output = $('analysisOutput');
    output.textContent = '';
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) {
      output.textContent = text;
      return;
    }
    const chunkSize = Math.max(4, Math.ceil(text.length / 100));
    for (let index = 0; index < text.length; index += chunkSize) {
      if (runId !== state.analysisRunId) return;
      output.textContent = text.slice(0, index + chunkSize);
      await delay(12);
    }
    output.textContent = text;
  }

  async function runAnalysis() {
    if (!state.data) return;
    const runId = ++state.analysisRunId;
    const button = $('analyzePanelBtn');
    const progress = $('analysisProgress');
    button.disabled = true;
    button.querySelector('span').textContent = 'Analyzing…';
    $('analysisResult').hidden = true;
    $('analysisOutput').textContent = 'Preparing waveform quality checks…';
    progress.hidden = false;
    const stages = [
      ['Checking waveform quality', 12],
      ['Detecting rate and rhythm', 32],
      ['Measuring intervals and axis', 58],
      ['Screening ST-T morphology', 78],
      ['Composing preliminary impression', 94],
    ];
    for (const [label, percent] of stages) {
      if (runId !== state.analysisRunId) return;
      setAnalysisProgress(label, percent);
      await delay(180);
    }
    const analysis = buildAnalysis();
    if (runId !== state.analysisRunId) return;
    state.analysis = analysis;
    if (!analysis) {
      $('analysisOutput').textContent = 'Unable to analyze this ECG waveform.';
    } else {
      setAnalysisProgress('Analysis complete', 100);
      renderImpression(analysis);
      $('analysisDetails').open = false;
      await typeAnalysisText(analysis.text, runId);
    }
    await delay(180);
    if (runId !== state.analysisRunId) return;
    progress.hidden = true;
    button.disabled = false;
    button.querySelector('span').textContent = 'Analyze again';
  }

  async function copyAnalysisToClipboard() {
    if (!state.analysis) await runAnalysis();
    if (!state.analysis) return;
    const text = state.analysis.text;
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(() => {
          const output = $('analysisOutput');
          if (output) output.textContent = text + '\n\nCopied. Paste manually into the report field.';
        }).catch(error => {
          fallbackCopy(text);
          const output = $('analysisOutput');
          if (output) output.textContent = text + '\n\nCopied with fallback. Paste manually into the report field.';
        });
        return;
      }
      fallbackCopy(text);
      const output = $('analysisOutput');
      if (output) output.textContent = text + '\n\nCopied. Paste manually into the report field.';
    } catch (error) {
      const output = $('analysisOutput');
      if (output) output.textContent = text + '\n\nUnable to copy: ' + (error.message || String(error));
    }
  }

  function fallbackCopy(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }

  function createViewports() {
    const count = layoutCount(state.layout);
    const previousViewports = state.viewports;
    viewportGrid.className = 'viewport-grid layout-' + state.layout;
    viewportGrid.innerHTML = '';
    state.viewports = Array.from({ length: count }, (_, index) => {
      const viewport = createViewportModel(index, previousViewports[index]);
      const element = document.createElement('div');
      element.className = 'viewport';
      const label = document.createElement('div');
      label.className = 'viewport-label';
      const viewCanvas = document.createElement('canvas');
      viewCanvas.width = 1600;
      viewCanvas.height = 720;
      element.appendChild(label);
      element.appendChild(viewCanvas);
      viewportGrid.appendChild(element);
      viewport.element = element;
      viewport.label = label;
      viewport.canvas = viewCanvas;
      viewport.ctx = viewCanvas.getContext('2d');
      element.addEventListener('click', () => activateViewport(index));
      viewCanvas.addEventListener('mousemove', event => { if (index === state.activeViewportIndex) updateCursor(event); });
      viewCanvas.addEventListener('pointerdown', event => { activateViewport(index); startCaliper(event); });
      viewCanvas.addEventListener('pointermove', event => { if (index === state.activeViewportIndex) moveCaliper(event); });
      viewCanvas.addEventListener('pointerup', event => { if (index === state.activeViewportIndex) finishCaliper(event); });
      viewCanvas.addEventListener('wheel', event => {
        event.preventDefault();
        if (index !== state.activeViewportIndex) return;
        state.scale = Math.max(0.5, Math.min(2.5, state.scale + (event.deltaY < 0 ? 0.1 : -0.1)));
        saveActiveViewportState();
        updateCalibrationControls();
        drawWaveform();
      }, { passive: false });
      return viewport;
    });
    activateViewport(Math.min(state.activeViewportIndex, count - 1));
    renderViewportShell();
    updateChannelTable();
  }

  function drawAllViewports() {
    const activeSnapshot = {
      canvas,
      ctx,
      data: state.data,
      activeStudyIndex: state.activeStudyIndex,
      leadMode: state.leadMode,
      leadIndex: state.leadIndex,
      speedMmPerSecond: state.speedMmPerSecond,
      gainMmPerMv: state.gainMmPerMv,
      scale: state.scale,
      calipers: state.calipers,
    };
    state.viewports.forEach(viewport => {
      canvas = viewport.canvas;
      ctx = viewport.ctx;
      applyViewportState(viewport);
      drawWaveform();
    });
    canvas = activeSnapshot.canvas;
    ctx = activeSnapshot.ctx;
    state.data = activeSnapshot.data;
    state.activeStudyIndex = activeSnapshot.activeStudyIndex;
    state.leadMode = activeSnapshot.leadMode;
    state.leadIndex = activeSnapshot.leadIndex;
    state.speedMmPerSecond = activeSnapshot.speedMmPerSecond;
    state.gainMmPerMv = activeSnapshot.gainMmPerMv;
    state.scale = activeSnapshot.scale;
    state.calipers = activeSnapshot.calipers;
  }

  function updateMarkers() {
    const markers = $('markers');
    if (!markers) return;
    markers.innerHTML = '<thead><tr><th>Lead</th><th>Tag</th><th>Value</th></tr></thead><tbody></tbody>';
    const body = markers.querySelector('tbody');
    if (!state.calipers.length) {
      body.innerHTML = '<tr><td colspan="3" class="muted-cell">No measurements yet.</td></tr>';
      updateSelectionReadout();
      return;
    }
    state.calipers.forEach((caliper, index) => {
      const result = formatCaliper(caliper);
      [
        ['Start Time', result.startTime],
        ['Start Value', result.startValue],
        ['Stop Time', result.stopTime],
        ['Stop Value', result.stopValue],
        ['Duration', result.duration],
        ['Difference', result.difference],
        ['Amplitude', result.amplitude],
      ].forEach((row, rowIndex) => {
        const tr = document.createElement('tr');
        tr.title = result.type + ' caliper #' + (index + 1);
        tr.innerHTML = '<td>' + (rowIndex === 0 ? escapeHtml(caliper.lead) : '') + '</td><td>' + row[0] + '</td><td>' + row[1] + '</td>';
        body.appendChild(tr);
      });
    });
    updateSelectionReadout();
  }

  function formatCaliper(caliper) {
    const signalStats = caliperSignalStats(caliper);
    const startValue = signalStats?.startValue ?? caliper.start.value;
    const stopValue = signalStats?.stopValue ?? caliper.end.value;
    const amplitudeValue = signalStats?.amplitude ?? Math.abs(caliper.end.value - caliper.start.value);
    const dt = Math.abs(caliper.end.time - caliper.start.time);
    const dv = stopValue - startValue;
    const unit = caliper.unit || 'mV';
    const type = caliper.type === 'amplitude' ? 'Amplitude' : 'Time';
    const duration = (dt * 1000).toFixed(1) + ' ms';
    const amplitude = amplitudeValue.toFixed(4) + ' ' + unit;
    return {
      type,
      measurement: caliper.type === 'amplitude' ? amplitude : duration,
      duration,
      amplitude,
      difference: dv.toFixed(4) + ' ' + unit,
      startTime: caliper.start.time.toFixed(3) + ' s',
      stopTime: caliper.end.time.toFixed(3) + ' s',
      startValue: startValue.toFixed(4) + ' ' + unit,
      stopValue: stopValue.toFixed(4) + ' ' + unit,
      start: caliper.type === 'amplitude' ? caliper.start.value.toFixed(4) + ' ' + unit : caliper.start.time.toFixed(3) + ' s',
      end: caliper.type === 'amplitude' ? caliper.end.value.toFixed(4) + ' ' + unit : caliper.end.time.toFixed(3) + ' s',
    };
  }

  function caliperSignalStats(caliper) {
    if (caliper.type !== 'time' || !state.data?.channels?.length) return null;
    const channel = state.data.channels.find(item => item.label === caliper.lead);
    if (!channel?.points?.length) return null;
    const startTime = Math.min(caliper.start.time, caliper.end.time);
    const stopTime = Math.max(caliper.start.time, caliper.end.time);
    const samples = channel.points.filter(point => point[0] >= startTime && point[0] <= stopTime);
    const startSample = nearestSample(channel, caliper.start.time);
    const stopSample = nearestSample(channel, caliper.end.time);
    const values = (samples.length ? samples : [startSample, stopSample]).map(point => Number(point?.[1])).filter(Number.isFinite);
    if (!startSample || !stopSample || !values.length) return null;
    return {
      startValue: Number(startSample[1]),
      stopValue: Number(stopSample[1]),
      minimum: Math.min(...values),
      maximum: Math.max(...values),
      amplitude: Math.max(...values) - Math.min(...values),
    };
  }

  function nearestSample(channel, time) {
    let nearest = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const point of channel.points) {
      const distance = Math.abs(Number(point[0]) - time);
      if (distance < nearestDistance) {
        nearest = point;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  function pointToWaveform(point, lockedLead) {
    const channels = selectedChannels();
    if (!channels.length) return null;
    const duration = currentDuration(channels);
    const plotWidth = canvas.width - plot.left - plot.right;
    const rowHeight = (canvas.height - plot.top - plot.bottom) / Math.max(1, channels.length);
    const lockedChannelIndex = lockedLead ? channels.findIndex(channel => channel.label === lockedLead) : -1;
    const channelIndex = lockedChannelIndex >= 0
      ? lockedChannelIndex
      : Math.max(0, Math.min(channels.length - 1, Math.floor((point.y - plot.top) / rowHeight)));
    const channel = channels[channelIndex];
    const centerY = plot.top + rowHeight * channelIndex + rowHeight / 2;
    const amplitude = Math.max(18, rowHeight * 0.34);
    const time = Math.max(0, Math.min(duration, canvasXToTime(point.x, duration, plotWidth)));
    const value = canvasYToValue(point.y, channel, centerY, amplitude);
    return { time, value, lead: channel.label, unit: channel.unit };
  }

  function waveformPointToCanvas(point) {
    const channels = selectedChannels();
    const channelIndex = channels.findIndex(channel => channel.label === point.lead);
    if (channelIndex < 0) return null;
    const duration = currentDuration(channels);
    const plotWidth = canvas.width - plot.left - plot.right;
    const rowHeight = (canvas.height - plot.top - plot.bottom) / Math.max(1, channels.length);
    const channel = channels[channelIndex];
    const centerY = plot.top + rowHeight * channelIndex + rowHeight / 2;
    const amplitude = Math.max(18, rowHeight * 0.34);
    return {
      x: timeToCanvasX(point.time, duration, plotWidth),
      y: valueToCanvasY(point.value, channel, centerY, amplitude),
    };
  }

  function channelGeometry(lead) {
    const channels = selectedChannels();
    const channelIndex = channels.findIndex(channel => channel.label === lead);
    if (channelIndex < 0) return null;
    const rowHeight = (canvas.height - plot.top - plot.bottom) / Math.max(1, channels.length);
    return {
      top: plot.top + rowHeight * channelIndex,
      bottom: plot.top + rowHeight * (channelIndex + 1),
      plotWidth: canvas.width - plot.left - plot.right,
    };
  }

  function caliperHitTest(point) {
    const threshold = 16;
    for (let index = state.calipers.length - 1; index >= 0; index -= 1) {
      const caliper = state.calipers[index];
      const start = waveformPointToCanvas(caliper.start);
      const end = waveformPointToCanvas(caliper.end);
      const geometry = channelGeometry(caliper.lead);
      if (!start || !end || !geometry) continue;
      if (caliper.type === 'amplitude') {
        const halfWidth = Math.min(70, Math.max(35, geometry.plotWidth * 0.045));
        if (Math.abs(point.y - start.y) <= threshold && Math.abs(point.x - start.x) <= halfWidth + threshold) return { index, action: 'resize-start' };
        if (Math.abs(point.y - end.y) <= threshold && Math.abs(point.x - start.x) <= halfWidth + threshold) return { index, action: 'resize-end' };
        if (Math.abs(point.x - start.x) <= threshold && point.y >= Math.min(start.y, end.y) - threshold && point.y <= Math.max(start.y, end.y) + threshold) return { index, action: 'move' };
      } else {
        if (Math.abs(point.x - start.x) <= threshold && point.y >= geometry.top && point.y <= geometry.bottom) return { index, action: 'resize-start' };
        if (Math.abs(point.x - end.x) <= threshold && point.y >= geometry.top && point.y <= geometry.bottom) return { index, action: 'resize-end' };
        const guideY = geometry.top + 20;
        if (Math.abs(point.y - guideY) <= threshold && point.x >= Math.min(start.x, end.x) - threshold && point.x <= Math.max(start.x, end.x) + threshold) return { index, action: 'move' };
      }
    }
    return null;
  }

  function setCaliperTool(type) {
    state.caliperType = type && state.caliperType !== type ? type : null;
    state.caliperMode = Boolean(state.caliperType);
    state.draftCaliper = null;
    state.caliperInteraction = null;
    saveActiveViewportState();
    updateCaliperToolButtons();
  }

  function updateCaliperToolButtons() {
    $('timeCaliperBtn').classList.toggle('active', state.caliperType === 'time');
    $('amplitudeCaliperBtn').classList.toggle('active', state.caliperType === 'amplitude');
    state.viewports.forEach((viewport, index) => {
      viewport.canvas.style.cursor = index === state.activeViewportIndex && state.caliperMode ? 'crosshair' : 'default';
    });
  }

  function cloneCaliper(caliper) {
    return { ...caliper, start: { ...caliper.start }, end: { ...caliper.end } };
  }

  function formatNumber(value, decimals) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(decimals) : '-';
  }

  function formatPatientName(value) {
    const components = String(value || '').split('^').map(item => item.trim()).filter(Boolean);
    if (!components.length) return '';
    return [components.slice(1).join(' '), components[0]].filter(Boolean).join(' ');
  }

  function formatDate(value) {
    if (!value || value.length !== 8) return value || '-';
    return value.slice(0, 4) + '-' + value.slice(4, 6) + '-' + value.slice(6, 8);
  }

  function formatTime(value) {
    if (!value || value.length < 6) return value || '';
    return value.slice(0, 2) + ':' + value.slice(2, 4) + ':' + value.slice(4, 6);
  }

  function updateCursor(event) {
    if (!state.data) return;
    if (state.draftCaliper || state.caliperInteraction) return;
    const point = canvasPoint(event);
    if (!state.caliperMode) {
      const hit = caliperHitTest(point);
      canvas.style.cursor = hit?.action === 'move' ? 'move' : hit ? (state.calipers[hit.index].type === 'amplitude' ? 'ns-resize' : 'ew-resize') : 'default';
    }
    const wavePoint = pointToWaveform(point);
    if (!wavePoint) return;
    state.cursor = { x: point.x };
    $('cursorTime').textContent = wavePoint.time.toFixed(3) + ' s';
    $('cursorValue').textContent = wavePoint.value.toFixed(4) + ' ' + wavePoint.unit;
    if (!state.cursorFrame) {
      state.cursorFrame = window.requestAnimationFrame(() => {
        state.cursorFrame = 0;
        drawWaveform();
      });
    }
  }

  function startCaliper(event) {
    if (!state.data) return;
    const point = canvasPoint(event);
    const hit = caliperHitTest(point);
    if (hit) {
      state.selectedCaliperIndex = hit.index;
      state.caliperInteraction = {
        action: hit.action,
        index: hit.index,
        origin: pointToWaveform(point, state.calipers[hit.index].lead),
        original: cloneCaliper(state.calipers[hit.index]),
      };
      canvas.setPointerCapture?.(event.pointerId);
      updateSelectionReadout();
      drawWaveform();
      return;
    }
    state.selectedCaliperIndex = -1;
    if (!state.caliperMode) {
      updateSelectionReadout();
      drawWaveform();
      return;
    }
    const start = pointToWaveform(point);
    if (!start) return;
    state.draftCaliper = { type: state.caliperType, start, end: { ...start }, lead: start.lead, unit: start.unit };
    canvas.setPointerCapture?.(event.pointerId);
    drawWaveform();
  }

  function moveCaliper(event) {
    if (state.caliperInteraction) {
      const interaction = state.caliperInteraction;
      const caliper = state.calipers[interaction.index];
      const next = pointToWaveform(canvasPoint(event), caliper.lead);
      if (!next || !interaction.origin) return;
      if (interaction.action === 'resize-start') {
        if (caliper.type === 'amplitude') caliper.start.value = next.value;
        else caliper.start.time = next.time;
      } else if (interaction.action === 'resize-end') {
        if (caliper.type === 'amplitude') caliper.end.value = next.value;
        else caliper.end.time = next.time;
      } else {
        const duration = state.data.durationSeconds || 0;
        const timeDelta = next.time - interaction.origin.time;
        const valueDelta = next.value - interaction.origin.value;
        let boundedTimeDelta = timeDelta;
        const earliest = Math.min(interaction.original.start.time, interaction.original.end.time);
        const latest = Math.max(interaction.original.start.time, interaction.original.end.time);
        if (duration) boundedTimeDelta = Math.max(-earliest, Math.min(duration - latest, timeDelta));
        caliper.start.time = interaction.original.start.time + boundedTimeDelta;
        caliper.end.time = interaction.original.end.time + boundedTimeDelta;
        if (caliper.type === 'amplitude') {
          caliper.start.value = interaction.original.start.value + valueDelta;
          caliper.end.value = interaction.original.end.value + valueDelta;
        }
      }
      drawWaveform();
      return;
    }
    if (!state.draftCaliper) return;
    const next = pointToWaveform(canvasPoint(event), state.draftCaliper.lead);
    if (!next) return;
    if (state.draftCaliper.type === 'amplitude') next.time = state.draftCaliper.start.time;
    else next.value = state.draftCaliper.start.value;
    state.draftCaliper.end = next;
    drawWaveform();
  }

  function finishCaliper(event) {
    if (state.caliperInteraction) {
      state.caliperInteraction = null;
      saveActiveViewportState();
      updateMarkers();
      drawWaveform();
      return;
    }
    if (!state.draftCaliper) return;
    const next = pointToWaveform(canvasPoint(event), state.draftCaliper.lead);
    if (next) {
      if (state.draftCaliper.type === 'amplitude') next.time = state.draftCaliper.start.time;
      else next.value = state.draftCaliper.start.value;
      state.draftCaliper.end = next;
    }
    const start = waveformPointToCanvas(state.draftCaliper.start);
    const end = waveformPointToCanvas(state.draftCaliper.end);
    const distance = state.draftCaliper.type === 'amplitude'
      ? Math.abs(end?.y - start?.y)
      : Math.abs(end?.x - start?.x);
    if (start && end && distance > 4) {
      state.calipers.push(state.draftCaliper);
      state.selectedCaliperIndex = state.calipers.length - 1;
    }
    state.draftCaliper = null;
    setCaliperTool(null);
    saveActiveViewportState();
    updateMarkers();
    drawWaveform();
  }

  $('viewportLayoutBtn').addEventListener('click', event => {
    event.stopPropagation();
    $('layoutMenu').hidden = !$('layoutMenu').hidden;
  });
  $('layoutMenu').addEventListener('click', event => event.stopPropagation());
  document.addEventListener('click', () => { $('layoutMenu').hidden = true; });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') $('layoutMenu').hidden = true; });
  $('leadModeBtn').addEventListener('click', () => {
    state.leadMode = state.leadMode === 'all' ? 'single' : 'all';
    state.selectedCaliperIndex = -1;
    saveActiveViewportState();
    updateLeadModeButton();
    drawWaveform();
  });
  $('leadSelect').addEventListener('change', event => { state.leadIndex = Number(event.target.value) || 0; state.selectedCaliperIndex = -1; saveActiveViewportState(); updateSelectionReadout(); drawWaveform(); });
  $('studySearch')?.addEventListener('input', renderStudyCards);
  $('speedSelect')?.addEventListener('change', event => { state.speedMmPerSecond = event.target.value === 'auto' ? 'auto' : Number(event.target.value); saveActiveViewportState(); updateCalibrationControls(); drawWaveform(); });
  $('gainSelect')?.addEventListener('change', event => { state.gainMmPerMv = event.target.value === 'auto' ? 'auto' : Number(event.target.value); saveActiveViewportState(); updateCalibrationControls(); drawWaveform(); });
  $('zoomSlider')?.addEventListener('input', event => { state.scale = Math.max(0.5, Math.min(2.5, Number(event.target.value) / 100 || 1)); saveActiveViewportState(); updateCalibrationControls(); drawWaveform(); });
  $('toggleStudyPanelBtn').addEventListener('click', () => togglePanel('study'));
  $('toggleRightPanelBtn').addEventListener('click', () => togglePanel('right'));
  $('timeCaliperBtn').addEventListener('click', () => setCaliperTool('time'));
  $('amplitudeCaliperBtn').addEventListener('click', () => setCaliperTool('amplitude'));
  $('clearCalipersBtn').addEventListener('click', () => { const viewport = state.viewports[state.activeViewportIndex]; if (viewport) viewport.calipers = []; state.calipers = viewport ? viewport.calipers : []; state.draftCaliper = null; state.selectedCaliperIndex = -1; state.caliperInteraction = null; saveActiveViewportState(); updateMarkers(); drawWaveform(); });
  $('analyzePanelBtn')?.addEventListener('click', runAnalysis);
  $('copyAnalysisPanelBtn')?.addEventListener('click', copyAnalysisToClipboard);
  $('fitBtn').addEventListener('click', () => { state.speedMmPerSecond = 'auto'; state.gainMmPerMv = 'auto'; state.scale = 1; saveActiveViewportState(); updateCalibrationControls(); drawWaveform(); });

  function resetViewerForNewStudy() {
    state.analysisRunId += 1;
    state.data = null;
    state.studies = [];
    state.activeViewportIndex = 0;
    state.activeStudyIndex = -1;
    state.leadMode = 'all';
    state.leadIndex = 0;
    state.speedMmPerSecond = 'auto';
    state.gainMmPerMv = 'auto';
    state.scale = 1;
    state.cursor = null;
    state.caliperMode = false;
    state.caliperType = null;
    state.calipers = [];
    state.draftCaliper = null;
    state.selectedCaliperIndex = -1;
    state.caliperInteraction = null;
    state.analysis = null;
    state.viewports = [];
    viewportGrid.innerHTML = '';
    updateLeadModeButton();
    updateCalibrationControls();
    updateCaliperToolButtons();
  }

  function loadStudiesFromUrl(force = false) {
    const nextUids = parseStudyUids();
    const nextKey = nextUids.join('|');
    if (!force && nextKey === loadedStudyKey) return;
    studyUids = nextUids;
    studyUid = studyUids[0] || '';
    loadedStudyKey = nextKey;
    const requestId = ++loadRequestId;
    resetViewerForNewStudy();
    if (!studyUid) {
      showError('StudyInstanceUIDs is required.');
      return;
    }
    $('studyTitle').textContent = 'Loading ECG...';
    $('studySub').textContent = 'Preparing DICOM waveform';
    const loadWaveforms = studyUids.length > 1
      ? Promise.all(studyUids.map(uid => fetchJson('rs/studies/' + encodeURIComponent(uid) + '/waveform').catch(() => null))).then(items => items.filter(Boolean))
      : fetchJson('rs/studies/' + encodeURIComponent(studyUid) + '/waveforms').catch(() => fetchJson('rs/studies/' + encodeURIComponent(studyUid) + '/waveform').then(item => [item]));
    loadWaveforms
      .then(items => {
        if (requestId !== loadRequestId) return;
        state.studies = Array.isArray(items) ? items : [items];
        state.data = state.studies[0];
        if (!state.data) throw new Error('Waveform data not found');
        createViewports();
        updatePanels();
        drawAllViewports();
      })
      .catch(error => {
        if (requestId !== loadRequestId) return;
        showError(error.message || String(error));
      });
  }

  renderLayoutMenu();
  updateLayoutButton();
  updateLeadModeButton();
  updatePanelButtons();
  updateCalibrationControls();
  updateCaliperToolButtons();
  setupPanelResizer('studyPanelResizer', '--study-panel-width', 1, 150, 420);
  setupPanelResizer('rightPanelResizer', '--right-panel-width', -1, 280, 620);
  let resizeFrame = 0;
  const resizeObserver = new ResizeObserver(() => {
    if (resizeFrame) return;
    resizeFrame = window.requestAnimationFrame(() => {
      resizeFrame = 0;
      if (state.viewports.length) drawAllViewports();
    });
  });
  resizeObserver.observe(viewportGrid);
  window.addEventListener('popstate', () => loadStudiesFromUrl());
  window.addEventListener('focus', () => loadStudiesFromUrl());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadStudiesFromUrl(); });
  loadStudiesFromUrl(true);
}());
