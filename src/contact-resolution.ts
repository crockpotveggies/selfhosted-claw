import { resolveSignalTarget } from './outbound-directives.js';

export type OutboundChannel = 'signal' | 'sms' | 'email';

export interface ProviderAvailability {
  onecliConfigured: boolean;
  onecliReachable: boolean;
  googleContactsAvailable: boolean;
  googleContactsSource: 'env' | 'onecli' | 'oauth' | 'none';
  signalOutboundAvailable: boolean;
  smsOutboundAvailable: boolean;
  emailOutboundAvailable: boolean;
  contactResolutionAvailable: boolean;
}

export interface ResolvedContactTarget {
  channel: OutboundChannel;
  query: string;
  resolvedTarget: string;
  displayName: string;
  source: 'literal' | 'signal_history' | 'google_contacts';
  existingConversation: boolean;
}

interface GoogleSearchResult {
  results?: Array<{
    person?: {
      names?: Array<{ displayName?: string }>;
      emailAddresses?: Array<{ value?: string }>;
      phoneNumbers?: Array<{ value?: string; canonicalForm?: string }>;
    };
  }>;
}

export function normalizePhone(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const digits = trimmed.replace(/[^\d+]/g, '');
  if (!digits) return '';
  return digits.startsWith('+') ? digits : `+${digits}`;
}

export function resolveLiteralTarget(
  channel: OutboundChannel,
  query: string,
): ResolvedContactTarget | null {
  const trimmed = query.trim();
  if (!trimmed) return null;

  if (channel === 'email' && trimmed.includes('@')) {
    return {
      channel,
      query,
      resolvedTarget: trimmed,
      displayName: trimmed,
      source: 'literal',
      existingConversation: false,
    };
  }

  if (channel === 'sms') {
    const phone = normalizePhone(trimmed);
    if (!phone || phone.replace(/[^\d]/g, '').length < 7) return null;
    return {
      channel,
      query,
      resolvedTarget: phone,
      displayName: phone,
      source: 'literal',
      existingConversation: false,
    };
  }

  if (
    channel === 'signal' &&
    (trimmed.startsWith('signal:user:') || trimmed.startsWith('+'))
  ) {
    const resolved = resolveSignalTarget(trimmed);
    return {
      channel,
      query,
      resolvedTarget: resolved.jid,
      displayName: trimmed,
      source: 'literal',
      existingConversation: resolved.existingConversation,
    };
  }

  // Bare digits (no + prefix) — normalize and resolve as Signal phone number
  if (channel === 'signal' && /^\d{7,15}$/.test(trimmed)) {
    const phone = `+${trimmed}`;
    const resolved = resolveSignalTarget(phone);
    return {
      channel,
      query,
      resolvedTarget: resolved.jid,
      displayName: phone,
      source: 'literal',
      existingConversation: resolved.existingConversation,
    };
  }

  return null;
}

function pickEmail(
  person: NonNullable<GoogleSearchResult['results']>[number]['person'],
): string {
  return (
    person?.emailAddresses
      ?.find((entry) => entry.value?.trim())
      ?.value?.trim() || ''
  );
}

function pickPhone(
  person: NonNullable<GoogleSearchResult['results']>[number]['person'],
): string {
  const phone = person?.phoneNumbers?.find(
    (entry) => entry.canonicalForm?.trim() || entry.value?.trim(),
  );
  return normalizePhone(phone?.canonicalForm || phone?.value || '');
}

function displayNameForPerson(
  person: NonNullable<GoogleSearchResult['results']>[number]['person'],
  fallback: string,
): string {
  return (
    person?.names
      ?.find((entry) => entry.displayName?.trim())
      ?.displayName?.trim() || fallback
  );
}

export async function searchGoogleContacts(
  accessToken: string,
  channel: OutboundChannel,
  query: string,
): Promise<ResolvedContactTarget | null> {
  const response = await fetch(
    `https://people.googleapis.com/v1/people:searchContacts?query=${encodeURIComponent(
      query,
    )}&pageSize=10&readMask=names,emailAddresses,phoneNumbers`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `Google contact lookup failed (${response.status}): ${text || response.statusText}`,
    );
  }

  const payload = (await response.json()) as GoogleSearchResult;
  const candidates = (payload.results || [])
    .map((entry) => entry.person)
    .filter(Boolean)
    .map((person) => {
      const displayName = displayNameForPerson(person, query);
      const email = pickEmail(person);
      const phone = pickPhone(person);
      return { displayName, email, phone };
    })
    .filter((candidate) => {
      if (channel === 'email') return Boolean(candidate.email);
      return Boolean(candidate.phone);
    });

  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    throw new Error(
      `Multiple Google contacts matched "${query}": ${candidates
        .slice(0, 5)
        .map((candidate) => candidate.displayName)
        .join(', ')}`,
    );
  }

  const candidate = candidates[0];
  if (channel === 'email') {
    return {
      channel,
      query,
      resolvedTarget: candidate.email,
      displayName: candidate.displayName,
      source: 'google_contacts',
      existingConversation: false,
    };
  }

  if (channel === 'sms') {
    return {
      channel,
      query,
      resolvedTarget: candidate.phone,
      displayName: candidate.displayName,
      source: 'google_contacts',
      existingConversation: false,
    };
  }

  const signalTarget = resolveSignalTarget(candidate.phone);
  return {
    channel,
    query,
    resolvedTarget: signalTarget.jid,
    displayName: candidate.displayName,
    source: 'google_contacts',
    existingConversation: signalTarget.existingConversation,
  };
}
