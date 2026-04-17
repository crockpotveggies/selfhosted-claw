import { randomUUID } from 'crypto';

import type {
  IdentityRecord,
  PrincipalRecord,
  PrincipalType,
  TrustTier,
} from '../state/types.js';

export interface InboundIdentityDescriptor {
  channelType: string;
  externalId: string;
  externalHandle?: string;
  displayName?: string;
  principalType?: PrincipalType;
  verified?: boolean;
}

export interface ResolvedIdentity {
  principal: PrincipalRecord;
  identity: IdentityRecord;
  createdPrincipal: boolean;
  createdIdentity: boolean;
}

function normalizeHandle(value?: string | null): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function defaultTrustTierForPrincipalType(type: PrincipalType): TrustTier {
  return type === 'controller' ? 'trusted' : 'restricted';
}

export class IdentityDirectory {
  private readonly principals = new Map<string, PrincipalRecord>();
  private readonly identitiesByKey = new Map<string, IdentityRecord>();
  private readonly principalIdsByHandle = new Map<string, string>();

  constructor(seed?: {
    principals?: PrincipalRecord[];
    identities?: IdentityRecord[];
  }) {
    for (const principal of seed?.principals ?? []) {
      this.upsertPrincipal(principal);
    }
    for (const identity of seed?.identities ?? []) {
      this.upsertIdentity(identity);
    }
  }

  upsertPrincipal(principal: PrincipalRecord): void {
    this.principals.set(principal.id, principal);
  }

  upsertIdentity(identity: IdentityRecord): void {
    this.identitiesByKey.set(
      this.identityKey(identity.channel_type, identity.external_id),
      identity,
    );
    const handle = normalizeHandle(identity.external_handle);
    if (handle && identity.verified) {
      this.principalIdsByHandle.set(handle, identity.principal_id);
    }
  }

  resolveInboundIdentity(input: InboundIdentityDescriptor): ResolvedIdentity {
    const key = this.identityKey(input.channelType, input.externalId);
    const existingIdentity = this.identitiesByKey.get(key);
    if (existingIdentity) {
      const principal = this.principals.get(existingIdentity.principal_id);
      if (!principal) {
        throw new Error(
          `Identity ${existingIdentity.id} references missing principal ${existingIdentity.principal_id}`,
        );
      }
      return {
        principal,
        identity: existingIdentity,
        createdPrincipal: false,
        createdIdentity: false,
      };
    }

    const principalType = input.principalType ?? 'external';
    const handle = normalizeHandle(input.externalHandle);
    const existingPrincipal = handle
      ? this.findPrincipalByHandle(handle)
      : undefined;
    const createdPrincipal = !existingPrincipal;
    const principal =
      existingPrincipal ??
      this.createPrincipal(
        input.displayName || input.externalHandle || input.externalId,
        principalType,
      );

    const identity: IdentityRecord = {
      id: randomUUID(),
      principal_id: principal.id,
      channel_type: input.channelType,
      external_id: input.externalId,
      external_handle: input.externalHandle ?? null,
      verified: input.verified ?? Boolean(handle),
    };
    this.upsertIdentity(identity);

    return {
      principal,
      identity,
      createdPrincipal,
      createdIdentity: true,
    };
  }

  listPrincipals(): PrincipalRecord[] {
    return [...this.principals.values()];
  }

  listIdentities(): IdentityRecord[] {
    return [...this.identitiesByKey.values()];
  }

  private findPrincipalByHandle(handle: string): PrincipalRecord | undefined {
    const principalId = this.principalIdsByHandle.get(handle);
    return principalId ? this.principals.get(principalId) : undefined;
  }

  private createPrincipal(
    displayName: string,
    type: PrincipalType,
  ): PrincipalRecord {
    const principal: PrincipalRecord = {
      id: randomUUID(),
      type,
      display_name: displayName,
      trust_tier: defaultTrustTierForPrincipalType(type),
      status: 'active',
      created_at: new Date().toISOString(),
    };
    this.upsertPrincipal(principal);
    return principal;
  }

  private identityKey(channelType: string, externalId: string): string {
    return `${channelType}\0${externalId}`;
  }
}
