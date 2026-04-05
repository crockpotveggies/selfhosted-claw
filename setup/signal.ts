import { readEnvFile } from '../src/env.js';
import { logger } from '../src/logger.js';
import { commandExists } from './platform.js';
import { emitStatus } from './status.js';

export async function run(_args: string[]): Promise<void> {
  const envVars = readEnvFile(['SIGNAL_ACCOUNT', 'SIGNAL_RPC_URL']);
  const account = process.env.SIGNAL_ACCOUNT || envVars.SIGNAL_ACCOUNT || '';
  const rpcUrl =
    process.env.SIGNAL_RPC_URL || envVars.SIGNAL_RPC_URL || 'http://127.0.0.1:8080';

  const signalCliInstalled = commandExists('signal-cli');
  let rpcReachable = false;
  let selfChatReady = false;

  if (account && rpcUrl) {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `setup-${Date.now()}`,
          method: 'listGroups',
          params: {
            account,
          },
        }),
      });
      rpcReachable = response.ok;
      selfChatReady = response.ok;
    } catch (err) {
      logger.warn({ err: String(err), rpcUrl }, 'Signal RPC health check failed');
    }
  }

  emitStatus('SIGNAL', {
    SIGNAL_CLI: signalCliInstalled,
    SIGNAL_ACCOUNT: account || 'missing',
    SIGNAL_RPC_URL: rpcUrl,
    RPC_REACHABLE: rpcReachable,
    SELF_CHAT_READY: selfChatReady,
    STATUS:
      signalCliInstalled && account && rpcReachable ? 'success' : 'failed',
    LOG: 'logs/setup.log',
  });

  if (!(signalCliInstalled && account && rpcReachable)) {
    process.exit(1);
  }
}
