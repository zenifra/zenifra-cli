import { atomicPrivateWrite } from './profile-store.mjs';

const MASKED_SECRET_PATTERN = /\*{4,}|\[redacted\]|<redacted>/i;

function normalizeDomain(value) {
  return String(value || '').trim().replace(/\.+$/, '').toLowerCase();
}

export function normalizeCustomDomains(domains, { primaryDomain } = {}) {
  if (!Array.isArray(domains)) return [];
  const normalized = domains.map(normalizeDomain).filter(Boolean);
  const seen = new Set();
  for (const domain of normalized) {
    if (seen.has(domain)) throw new Error(`Duplicate custom domain: ${domain}`);
    seen.add(domain);
  }
  const primary = normalizeDomain(primaryDomain);
  if (primary && seen.has(primary)) {
    throw new Error(`Custom domain conflicts with the primary domain: ${primary}`);
  }
  return normalized;
}

export function validateValkeyConnection(value) {
  const connection = String(value ?? '');
  if (!connection || connection.trim() === '' || MASKED_SECRET_PATTERN.test(connection)) {
    throw new Error('The Valkey connection is masked. Rotate credentials and save the one-time connection securely.');
  }
  return connection;
}

export async function writeValkeyConnectionFile(path, value) {
  const connection = validateValkeyConnection(value);
  await atomicPrivateWrite(path, connection);
  return connection;
}

export function isMaskedSecret(value) {
  return MASKED_SECRET_PATTERN.test(String(value || ''));
}
