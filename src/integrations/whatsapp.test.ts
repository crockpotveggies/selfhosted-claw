import { describe, expect, it } from 'vitest';

import {
  dataUrlToBuffer,
  getReadReceiptKey,
  isWhatsAppJid,
} from './whatsapp.js';

describe('WhatsApp integration JID ownership', () => {
  it('recognizes standard WhatsApp chat JIDs', () => {
    expect(isWhatsAppJid('12345@s.whatsapp.net')).toBe(true);
    expect(isWhatsAppJid('12345@g.us')).toBe(true);
  });

  it('recognizes LID JIDs while phone mapping is still pending', () => {
    expect(isWhatsAppJid('18392019231@lid')).toBe(true);
  });

  it('rejects non-WhatsApp identifiers', () => {
    expect(isWhatsAppJid('signal:user:+15550001111')).toBe(false);
  });

  it('builds a read receipt key for inbound messages', () => {
    expect(
      getReadReceiptKey({
        remoteJid: '12345@s.whatsapp.net',
        id: 'abc123',
      }),
    ).toEqual({
      remoteJid: '12345@s.whatsapp.net',
      id: 'abc123',
      participant: undefined,
    });
  });

  it('does not build a read receipt key for outbound messages', () => {
    expect(
      getReadReceiptKey({
        remoteJid: '12345@s.whatsapp.net',
        id: 'abc123',
        fromMe: true,
      }),
    ).toBeNull();
  });

  it('converts image data URLs into buffers for profile uploads', () => {
    const buffer = dataUrlToBuffer('data:image/png;base64,aGVsbG8=');
    expect(buffer?.toString('utf8')).toBe('hello');
  });

  it('rejects non-image or malformed data URLs for profile uploads', () => {
    expect(dataUrlToBuffer('https://example.com/avatar.png')).toBeNull();
    expect(dataUrlToBuffer('data:image/png;base64,%%%')).toBeNull();
  });
});
