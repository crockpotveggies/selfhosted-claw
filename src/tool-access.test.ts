import { describe, expect, it } from 'vitest';

import { hasControllerAccess } from './tool-access.js';

describe('tool access', () => {
  it('grants controller access to main-group sessions', () => {
    expect(
      hasControllerAccess({
        isMain: true,
        controllerTriggered: false,
      }),
    ).toBe(true);
  });

  it('grants controller access to explicitly controller-triggered sessions', () => {
    expect(
      hasControllerAccess({
        isMain: false,
        controllerTriggered: true,
      }),
    ).toBe(true);
  });

  it('denies controller access to non-main sessions without an explicit trigger', () => {
    expect(
      hasControllerAccess({
        isMain: false,
        controllerTriggered: false,
      }),
    ).toBe(false);
  });
});
