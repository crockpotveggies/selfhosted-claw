function normalizePhone(value: string): string {
  return value.replace(/[^\d+]/g, '');
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
  if (trimmed.startsWith('signal:user:')) {
    return `phone:${normalizePhone(trimmed.slice('signal:user:'.length))}`;
  }
  if (trimmed.startsWith('signal:group:')) {
    return `group:${trimmed.slice('signal:group:'.length).toLowerCase()}`;
  }
  if (trimmed.includes('@') && !trimmed.startsWith('signal:')) {
    return `email:${trimmed.toLowerCase()}`;
  }
  if (/^\+?[\d\s().-]{6,}$/.test(trimmed)) {
    return `phone:${normalizePhone(trimmed)}`;
  }
  return `id:${trimmed.toLowerCase()}`;
}

export function displayIdentity(identity: string): string {
  if (identity.startsWith('phone:')) return identity.slice('phone:'.length);
  if (identity.startsWith('email:')) return identity.slice('email:'.length);
  if (identity.startsWith('id:')) return identity.slice('id:'.length);
  if (identity.startsWith('group:')) return identity.slice('group:'.length);
  return identity;
}
