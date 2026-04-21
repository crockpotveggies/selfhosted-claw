import type http from 'http';
import { URL } from 'url';

import { WebSocketServer, WebSocket } from 'ws';

import { logger } from '../logger.js';
import { ADMIN_UI_TOKEN, ADMIN_UI_USERNAME } from '../config.js';
import { getIntegrationSettings } from './settings-store.js';
import {
  resolvePhoneVoiceBrowserSessionChannel,
  type BrowserVoiceSessionEvent,
} from './phone-voice.js';

function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const normalized = remoteAddress.startsWith('::ffff:')
    ? remoteAddress.slice('::ffff:'.length)
    : remoteAddress;
  return normalized === '127.0.0.1' || normalized === '::1';
}

const log = logger.child({ integration: 'phone-voice', scope: 'ws' });

const BROWSER_STREAM_RE =
  /^\/api\/admin\/integrations\/phone-voice\/browser\/([^/]+)\/stream$/;

interface StartMessage {
  type: 'start';
  sampleRateHz?: number;
}

interface ControlMessage {
  type: 'end_of_turn' | 'end';
}

type ClientMessage = StartMessage | ControlMessage;

function isBasicAuthorized(authHeader: string | undefined): boolean {
  if (!ADMIN_UI_TOKEN) return true;
  if (!authHeader?.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(
      authHeader.slice('Basic '.length),
      'base64',
    ).toString('utf-8');
    const separator = decoded.indexOf(':');
    if (separator === -1) return false;
    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    return username === ADMIN_UI_USERNAME && password === ADMIN_UI_TOKEN;
  } catch {
    return false;
  }
}

function isTokenAuthorized(
  tokenHeader: string | string[] | undefined,
  urlTokenParam: string | null,
): boolean {
  if (!ADMIN_UI_TOKEN) return true;
  const headerValue = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
  if (headerValue === ADMIN_UI_TOKEN) return true;
  // Browser WebSocket constructors cannot set custom headers, so the UI passes
  // the admin token as a query string parameter; treat it as equivalent.
  if (urlTokenParam && urlTokenParam === ADMIN_UI_TOKEN) return true;
  return false;
}

export function attachPhoneVoiceBrowserWsServer(
  httpServer: http.Server,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(
      req.url || '/',
      `http://${req.headers.host || 'localhost'}`,
    );
    if (!BROWSER_STREAM_RE.test(url.pathname)) return;

    if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    if (ADMIN_UI_TOKEN) {
      const tokenAuthorized = isTokenAuthorized(
        req.headers['x-admin-token'],
        url.searchParams.get('token'),
      );
      const basicAuthorized = isBasicAuthorized(req.headers.authorization);
      if (!tokenAuthorized && !basicAuthorized) {
        socket.write(
          'HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="NanoClaw Admin"\r\n\r\n',
        );
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, url);
    });
  });

  wss.on(
    'connection',
    (ws: WebSocket, _req: http.IncomingMessage, url: URL) => {
      const match = url.pathname.match(BROWSER_STREAM_RE);
      if (!match) {
        ws.close(1008, 'invalid_path');
        return;
      }
      const sessionId = decodeURIComponent(match[1]);
      log.info({ sessionId }, 'Browser voice WS connection opened');

      let sampleRateHz = 16000;
      let unsubscribe: (() => void) | null = null;
      let started = false;
      let closed = false;
      let audioFrameCount = 0;
      let audioByteCount = 0;

      const sendEvent = (payload: BrowserVoiceSessionEvent): void => {
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.send(JSON.stringify(payload));
        } catch (err) {
          log.warn({ err, sessionId }, 'Failed to send browser voice event');
        }
      };

      const sendError = (message: string): void => {
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.send(JSON.stringify({ type: 'error', message }));
        } catch {
          // socket already going away
        }
      };

      const resolveChannel = () =>
        resolvePhoneVoiceBrowserSessionChannel(
          sessionId,
          getIntegrationSettings('phone-voice'),
        );

      const handleStart = (msg: StartMessage): void => {
        if (started) return;
        started = true;
        if (typeof msg.sampleRateHz === 'number' && msg.sampleRateHz > 0) {
          sampleRateHz = Math.round(msg.sampleRateHz);
        }
        log.info(
          { sessionId, sampleRateHz },
          'Browser voice WS stream started',
        );
        try {
          const channel = resolveChannel();
          unsubscribe = channel.subscribeBrowserVoiceEvents(
            sessionId,
            (event) => {
              sendEvent(event);
            },
          );
          // Flush any events queued before the subscription (e.g. the initial
          // greeting emitted synchronously during session creation via HTTP).
          const pending = channel.getBrowserVoiceEvents(sessionId).events;
          for (const event of pending) sendEvent(event);
        } catch (err) {
          sendError(err instanceof Error ? err.message : 'start_failed');
          ws.close(1011, 'start_failed');
        }
      };

      const handleBinary = async (buffer: Buffer): Promise<void> => {
        if (!started) return;
        audioFrameCount += 1;
        audioByteCount += buffer.length;
        // Log every 50 frames (~1.5 s at 30 ms frames) so we can see flow
        // without spamming.
        if (audioFrameCount % 50 === 1) {
          log.info(
            {
              sessionId,
              audioFrameCount,
              audioByteCount,
              lastFrameBytes: buffer.length,
            },
            'Browser voice WS audio flowing',
          );
        }
        try {
          const channel = resolveChannel();
          await channel.sendBrowserVoiceAudio({
            sessionId,
            dataBase64: buffer.toString('base64'),
            contentType: `audio/l16; rate=${sampleRateHz}`,
            sampleRateHz,
            channels: 1,
            endOfTurn: false,
            awaitIdle: false,
          });
        } catch (err) {
          log.warn({ err, sessionId }, 'sendBrowserVoiceAudio failed');
          sendError(err instanceof Error ? err.message : 'audio_failed');
        }
      };

      const handleEndOfTurn = async (): Promise<void> => {
        if (!started) return;
        log.info(
          { sessionId, audioFrameCount, audioByteCount },
          'Browser voice WS end_of_turn',
        );
        try {
          const channel = resolveChannel();
          await channel.sendBrowserVoiceAudio({
            sessionId,
            dataBase64: '',
            contentType: `audio/l16; rate=${sampleRateHz}`,
            sampleRateHz,
            channels: 1,
            endOfTurn: true,
            awaitIdle: false,
          });
        } catch (err) {
          sendError(err instanceof Error ? err.message : 'end_of_turn_failed');
        }
      };

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        if (unsubscribe) {
          try {
            unsubscribe();
          } catch {
            // ignore
          }
          unsubscribe = null;
        }
      };

      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          const buf = Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.isBuffer(data)
              ? data
              : Buffer.from(data as ArrayBuffer);
          void handleBinary(buf);
          return;
        }
        const text =
          typeof data === 'string'
            ? data
            : Buffer.isBuffer(data)
              ? data.toString('utf-8')
              : Buffer.from(data as ArrayBuffer).toString('utf-8');
        let parsed: ClientMessage | null = null;
        try {
          parsed = JSON.parse(text) as ClientMessage;
        } catch {
          sendError('invalid_json');
          return;
        }
        if (!parsed || typeof parsed.type !== 'string') {
          sendError('invalid_message');
          return;
        }
        if (parsed.type === 'start') {
          handleStart(parsed);
        } else if (parsed.type === 'end_of_turn') {
          void handleEndOfTurn();
        } else if (parsed.type === 'end') {
          cleanup();
          ws.close(1000, 'session_end');
        }
      });

      ws.on('close', () => {
        cleanup();
      });

      ws.on('error', (err) => {
        log.warn({ err, sessionId }, 'Browser voice WS errored');
        cleanup();
      });
    },
  );

  return wss;
}
