const CONTROL_CHAR_REGEX = /[\u0000-\u001F\u007F]/;

function canonicalize(value) {
  if (typeof value !== 'string') return '';
  let normalized = value;
  if (typeof normalized.normalize === 'function') {
    normalized = normalized.normalize('NFKC');
  }
  normalized = normalized.trim();
  return normalized.toLowerCase();
}

function normalizeInput(value) {
  if (typeof value !== 'string') {
    return { original: '', normalized: '', canonical: '' };
  }
  let normalized = value;
  if (typeof normalized.normalize === 'function') {
    normalized = normalized.normalize('NFKC');
  }
  normalized = normalized.trim();
  return {
    original: value,
    normalized,
    canonical: normalized.toLowerCase()
  };
}

function hasControlChars(value) {
  return CONTROL_CHAR_REGEX.test(value);
}

function validateItemBaseName(name) {
  const { normalized, canonical } = normalizeInput(name);
  if (!normalized) {
    return { ok: false, error: 'empty' };
  }
  if (normalized.length > 24) {
    return { ok: false, error: 'too-long', value: normalized, canonical };
  }
  if (hasControlChars(normalized)) {
    return { ok: false, error: 'invalid-chars', value: normalized, canonical };
  }
  return { ok: true, value: normalized, canonical };
}

module.exports = {
  canonicalize,
  normalizeInput,
  validateItemBaseName,
  hasControlChars
};
