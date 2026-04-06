function normalizePhone(value: string): string {
  return value.replace(/[^\d+]/g, '');
}

function normalizeSignalIdentifier(value: string): string {
  return value.trim().replace(/[^\dA-Za-z:+-]/g, '').toLowerCase();
}

function normalizeSignalUser(value: string): string {
  const normalized = normalizeSignalIdentifier(value);
  const compact = normalized.replace(/-/g, '');
  if (/^[0-9a-f]{32}$/.test(compact)) {
    return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
  }
  return normalized;
}

function isPhoneLike(value: string): boolean {
  return /^\+?[\d\s().-]{6,}$/.test(value.trim());
}

export function canonicalizeIdentity(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';

  if (trimmed.startsWith('email:')) {
    return `email:${trimmed.slice('email:'.length).trim().toLowerCase()}`;
  }
  if (trimmed.startsWith('phone:')) {
    return `phone:${normalizePhone(trimmed.slice('phone:'.length))}`;
  }
  if (trimmed.startsWith('signal-user:')) {
    return `signal-user:${normalizeSignalUser(trimmed.slice('signal-user:'.length))}`;
  }
  if (trimmed.startsWith('signal:user:')) {
    const signalUser = trimmed.slice('signal:user:'.length).trim();
    return isPhoneLike(signalUser)
      ? `phone:${normalizePhone(signalUser)}`
      : `signal-user:${normalizeSignalUser(signalUser)}`;
  }
  if (trimmed.startsWith('signal:group:')) {
    return `group:${trimmed.slice('signal:group:'.length).toLowerCase()}`;
  }
  if (trimmed.includes('@') && !trimmed.startsWith('signal:')) {
    return `email:${trimmed.toLowerCase()}`;
  }
  if (isPhoneLike(trimmed)) {
    return `phone:${normalizePhone(trimmed)}`;
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return `signal-user:${normalizeSignalUser(trimmed)}`;
  }
  if (/^[0-9a-f]{32}$/i.test(trimmed)) {
    return `signal-user:${normalizeSignalUser(trimmed)}`;
  }
  return `id:${trimmed.toLowerCase()}`;
}

export function identitiesMatch(left: string, right: string): boolean {
  return canonicalizeIdentity(left) === canonicalizeIdentity(right);
}

export function displayIdentity(identity: string): string {
  if (identity.startsWith('phone:')) return identity.slice('phone:'.length);
  if (identity.startsWith('email:')) return identity.slice('email:'.length);
  if (identity.startsWith('id:')) return identity.slice('id:'.length);
  if (identity.startsWith('group:')) return identity.slice('group:'.length);
  if (identity.startsWith('signal-user:')) {
    return identity.slice('signal-user:'.length);
  }
  return identity;
}
