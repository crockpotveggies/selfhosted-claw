import { getChannelFactory } from './channels/registry.js';
import type { Channel } from './types.js';
import { logger } from './logger.js';
import type { ChannelOpts } from './integrations/types.js';

let runtimeOpts: ChannelOpts | null = null;
let liveChannels: Channel[] | null = null;

export function initializeChannelRuntime(
  opts: ChannelOpts,
  channels: Channel[],
): void {
  runtimeOpts = opts;
  liveChannels = channels;
}

function requireRuntime(): { opts: ChannelOpts; channels: Channel[] } {
  if (!runtimeOpts || !liveChannels) {
    throw new Error('Channel runtime is not initialized');
  }
  return { opts: runtimeOpts, channels: liveChannels };
}

export async function activateRegisteredChannel(name: string): Promise<void> {
  const { opts, channels } = requireRuntime();
  const existing = channels.find((channel) => channel.name === name);
  if (existing?.isConnected()) return;

  const factory = getChannelFactory(name);
  if (!factory) {
    throw new Error(`No channel factory registered for ${name}`);
  }

  const channel = factory(opts);
  if (!channel) {
    throw new Error(`Channel ${name} is not ready to activate`);
  }

  await channel.connect();

  const existingIndex = channels.findIndex(
    (candidate) => candidate.name === name,
  );
  if (existingIndex >= 0) {
    channels[existingIndex] = channel;
  } else {
    channels.push(channel);
  }

  logger.info({ channel: name }, 'Channel activated at runtime');
}

export async function deactivateRegisteredChannel(name: string): Promise<void> {
  const { channels } = requireRuntime();
  const index = channels.findIndex((channel) => channel.name === name);
  if (index < 0) return;
  await channels[index].disconnect();
  channels.splice(index, 1);
  logger.info({ channel: name }, 'Channel deactivated at runtime');
}

export async function reconnectRegisteredChannel(name: string): Promise<void> {
  const { channels } = requireRuntime();
  const existing = channels.find((channel) => channel.name === name);
  if (!existing) {
    await activateRegisteredChannel(name);
    return;
  }
  await existing.disconnect();
  await activateRegisteredChannel(name);
}
