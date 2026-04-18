import { describe, expect, it } from 'vitest';

import {
  assertCalendarMutationAllowed,
  assertCalendarReadDetailAllowed,
  sanitizeCalendarListResult,
} from './calendar-runtime.js';

describe('calendar runtime security', () => {
  it('redacts event details for limited contexts', () => {
    const result = sanitizeCalendarListResult(
      {
        items: [
          {
            start: { dateTime: '2026-04-18T09:00:00-07:00' },
            end: { dateTime: '2026-04-18T10:00:00-07:00' },
            summary: 'Private meeting',
            status: 'confirmed',
          },
        ],
      },
      { calendarAccess: false },
    );

    expect(result.items).toEqual([
      {
        start: { dateTime: '2026-04-18T09:00:00-07:00' },
        end: { dateTime: '2026-04-18T10:00:00-07:00' },
        status: 'confirmed',
        summary: '(busy)',
      },
    ]);
  });

  it('allows full event details for controller contexts', () => {
    const result = sanitizeCalendarListResult(
      {
        items: [
          {
            start: { dateTime: '2026-04-18T09:00:00-07:00' },
            end: { dateTime: '2026-04-18T10:00:00-07:00' },
            summary: 'Private meeting',
            status: 'confirmed',
          },
        ],
      },
      { calendarAccess: true },
    );

    expect(result.items?.[0]?.summary).toBe('Private meeting');
  });

  it('blocks event detail reads outside the control chat', () => {
    expect(() =>
      assertCalendarReadDetailAllowed({ calendarAccess: false }),
    ).toThrow(/control chat/i);
  });

  it('blocks calendar mutations outside the control chat', () => {
    expect(() =>
      assertCalendarMutationAllowed({ calendarAccess: false }),
    ).toThrow(/modified from the control chat/i);
  });
});
