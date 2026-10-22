const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const readSource = (...segments) => fs.readFileSync(path.join(__dirname, '..', ...segments), 'utf8');
const catalog = JSON.parse(readSource('catalog', 'ecg-interpretation-terms.json'));
const engineSource = readSource('public', 'analysis-core.js');
const codesOf = source => new Set([...source.matchAll(/(VEXA-ECG-[A-Z]+-\d{3})/g)].map(match => match[1]));

test('catalog uses unique internal codes and bilingual terms', () => {
  assert.equal(catalog.catalog_id, 'VEXA_ECG_INTERNAL');
  const codes = catalog.terms.map(term => term.code);
  assert.equal(new Set(codes).size, codes.length);
  catalog.terms.forEach(term => {
    assert.match(term.code, /^VEXA-ECG-[A-Z]+-\d{3}$/);
    assert.ok(term.term);
    assert.ok(term.term_id);
    assert.ok(['primary', 'secondary', 'modifier', 'comparison'].includes(term.statement_type));
  });
});

test('every code emitted by the algorithm exists and is algorithm eligible', () => {
  const emittedCodes = [...engineSource.matchAll(/finding\('(VEXA-ECG-[A-Z]+-\d{3})'/g)].map(match => match[1]);
  const termsByCode = new Map(catalog.terms.map(term => [term.code, term]));
  assert.ok(emittedCodes.length > 0);
  emittedCodes.forEach(code => {
    assert.ok(termsByCode.has(code), `${code} is missing from the catalog`);
    assert.equal(termsByCode.get(code).algorithm_eligible, true, `${code} is not algorithm eligible`);
  });
});

test('no catalog entry claims to be an official external standard code', () => {
  catalog.terms.forEach(term => {
    assert.ok(term.code.startsWith('VEXA-ECG-'));
    assert.doesNotMatch(term.code, /^(SNOMED|LOINC|AHA|DICOM)/i);
  });
});

test('browser fallback emits the same codes as the tested module', () => {
  const fallbackSource = readSource('public', 'ecg-viewer.js');
  const moduleCodes = [...codesOf(engineSource)].sort();
  const fallbackCodes = [...codesOf(fallbackSource)].sort();
  assert.ok(moduleCodes.length > 0);
  assert.deepEqual(fallbackCodes, moduleCodes);
});

test('browser fallback applies the same display-code rule as the module', () => {
  const fallbackSource = readSource('public', 'ecg-viewer.js');
  const rule = /formatFindingCode\(code\)\s*\{\s*return String\(code \|\| ''\)\.replace\(\/\^VEXA-\/, ''\);\s*\}/;
  assert.match(engineSource, rule);
  assert.match(fallbackSource, rule);
});
