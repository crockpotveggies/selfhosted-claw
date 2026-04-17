import { describe, expect, it } from 'vitest';

import { IdentityDirectory } from './directory.js';

describe('IdentityDirectory', () => {
  it('resolves the same person across channels to one principal when handles match', () => {
    const directory = new IdentityDirectory();

    const signal = directory.resolveInboundIdentity({
      channelType: 'signal',
      externalId: 'signal:user:+15550001111',
      externalHandle: 'alex@example.com',
      displayName: 'Alex',
      principalType: 'controller',
      verified: true,
    });

    const slack = directory.resolveInboundIdentity({
      channelType: 'slack',
      externalId: 'U12345',
      externalHandle: 'alex@example.com',
      displayName: 'Alex on Slack',
      principalType: 'controller',
      verified: true,
    });

    expect(signal.principal.id).toBe(slack.principal.id);
    expect(signal.principal.trust_tier).toBe('trusted');
    expect(directory.listPrincipals()).toHaveLength(1);
    expect(directory.listIdentities()).toHaveLength(2);
  });
});
