function pad(value, length) {
  const text = String(value);
  if (text.length >= length) {
    return text;
  }
  return text.padStart(length, '0');
}

function formatDate(value) {
  if (!value) {
    return '';
  }
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = pad(value.getMonth() + 1, 2);
    const day = pad(value.getDate(), 2);
    return `${year}${month}${day}`;
  }
  const text = String(value).replace(/-/g, '');
  return text;
}

function formatTime(value) {
  if (!value) {
    return '';
  }
  if (value instanceof Date) {
    const hours = pad(value.getHours(), 2);
    const minutes = pad(value.getMinutes(), 2);
    const seconds = pad(value.getSeconds(), 2);
    return `${hours}${minutes}${seconds}`;
  }
  return String(value).replace(/:/g, '').replace(/\./g, '');
}

function toMultiValue(value) {
  if (value === null || value === undefined || value === '') {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  const text = String(value);
  if (text.includes('\\')) {
    return text.split('\\').filter(Boolean);
  }
  if (text.includes(',')) {
    return text.split(',').map(item => item.trim()).filter(Boolean);
  }
  return [text];
}

module.exports = { formatDate, formatTime, toMultiValue };
