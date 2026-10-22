const REQUEST_BEGIN = '-----BEGIN VEXA LICENSE REQUEST-----';
const REQUEST_END = '-----END VEXA LICENSE REQUEST-----';
const LICENSE_BEGIN = '-----BEGIN VEXA LICENSE-----';
const LICENSE_END = '-----END VEXA LICENSE-----';

function chunkText(value, size = 64) {
  const text = String(value || '');
  const chunks = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks.join('\n');
}

function encodeBlock(value, type = 'license') {
  const begin = type === 'request' ? REQUEST_BEGIN : LICENSE_BEGIN;
  const end = type === 'request' ? REQUEST_END : LICENSE_END;
  const json = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const payload = Buffer.from(json, 'utf8').toString('base64');
  return `${begin}\n${chunkText(payload)}\n${end}\n`;
}

function extractBlock(content) {
  const text = String(content || '').trim();
  const blocks = [
    { type: 'request', begin: REQUEST_BEGIN, end: REQUEST_END },
    { type: 'license', begin: LICENSE_BEGIN, end: LICENSE_END },
    { type: 'request', begin: '-----BEGIN LICENSE REQUEST-----', end: '-----END LICENSE REQUEST-----' },
    { type: 'license', begin: '-----BEGIN LICENSE-----', end: '-----END LICENSE-----' },
  ];

  for (const block of blocks) {
    const beginIndex = text.indexOf(block.begin);
    const endIndex = text.indexOf(block.end);
    if (beginIndex >= 0 && endIndex > beginIndex) {
      const start = beginIndex + block.begin.length;
      const encoded = text.slice(start, endIndex).replace(/[^A-Za-z0-9+/=]/g, '');
      return {
        type: block.type,
        json: Buffer.from(encoded, 'base64').toString('utf8'),
      };
    }
  }
  return null;
}

function parseJsonOrBlock(content) {
  const text = String(content || '').trim();
  const block = extractBlock(text);
  if (block) {
    return JSON.parse(block.json);
  }
  return JSON.parse(text);
}

module.exports = {
  LICENSE_BEGIN,
  LICENSE_END,
  REQUEST_BEGIN,
  REQUEST_END,
  encodeBlock,
  extractBlock,
  parseJsonOrBlock,
};
