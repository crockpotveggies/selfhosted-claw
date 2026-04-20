import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';

import type { VoiceHandoffRequest } from './protocol.js';

const HANDOFF_ROOT = path.join(DATA_DIR, 'voice-runner', 'handoffs');

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function serialize(handoff: VoiceHandoffRequest): string {
  return JSON.stringify(handoff, null, 2);
}

export class VoiceHandoffStore {
  readonly rootDir: string;
  readonly pendingDir: string;
  readonly deliveredDir: string;

  constructor(rootDir: string = HANDOFF_ROOT) {
    this.rootDir = rootDir;
    this.pendingDir = path.join(rootDir, 'pending');
    this.deliveredDir = path.join(rootDir, 'delivered');
    ensureDir(this.pendingDir);
    ensureDir(this.deliveredDir);
  }

  enqueue(handoff: VoiceHandoffRequest): string {
    const target = path.join(this.pendingDir, `${handoff.id}.json`);
    fs.writeFileSync(target, serialize(handoff));
    return target;
  }

  markDelivered(id: string): void {
    const pending = path.join(this.pendingDir, `${id}.json`);
    if (!fs.existsSync(pending)) return;
    const delivered = path.join(this.deliveredDir, `${id}.json`);
    fs.renameSync(pending, delivered);
  }

  getPendingCount(): number {
    if (!fs.existsSync(this.pendingDir)) return 0;
    return fs
      .readdirSync(this.pendingDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json')).length;
  }
}
