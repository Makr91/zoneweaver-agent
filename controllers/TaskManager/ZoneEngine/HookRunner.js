import { executeCommand } from '../../../lib/CommandManager.js';
import config from '../../../config/ConfigLoader.js';
import { shellEnvArgs, runWinScriptViaAnsible, runScriptInGuest } from '../ZoneEngineManager.js';
import { shellQuote } from './ShellPrimitives.js';

const runGuestHook = async (target, resolvedScript, taskId, options) => {
  const { env, timeout, onData, communicator } = options;
  if (communicator === 'winrm') {
    return runWinScriptViaAnsible(target, resolvedScript, taskId, { env, timeout, onData });
  }
  const result = await runScriptInGuest(target, resolvedScript, `/tmp/zoneweaver-hook-${taskId}`, {
    env,
    timeout,
    onData,
  });
  if (!result.success) {
    return {
      success: false,
      error:
        result.output !== undefined
          ? `hook failed (exit ${result.exitCode}):\n${result.output}`
          : `hook ${result.error}`,
    };
  }
  return { success: true, message: 'hook completed in guest' };
};

/**
 * Run one hook on its target (host or guest). Host-target execution is
 * DOUBLE-gated: the pipeline pre-flight refuses unconfirmed/ungated runs,
 * and this re-checks the `provisioning.host_hooks` config (defense in
 * depth, zoneweaver default OFF).
 * @param {Object} params - {hook, ip, port, credentials, env, communicator,
 *   winrm, provisioningBasePath, resolvedScript, taskId, timeout, onData}
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const runHookOnTarget = params => {
  const { hook, resolvedScript, timeout, onData } = params;
  if (hook.target === 'host') {
    const provConfig = config.get('provisioning') || {};
    if (provConfig.host_hooks !== true) {
      return Promise.resolve({
        success: false,
        error:
          'host-target hooks are disabled on this agent (provisioning.host_hooks, zoneweaver default OFF)',
      });
    }
    const envArgs = shellEnvArgs(params.env, onData);
    const command = envArgs
      ? `chmod +x ${shellQuote(resolvedScript)} && env ${envArgs} ${shellQuote(resolvedScript)}`
      : `chmod +x ${shellQuote(resolvedScript)} && ${shellQuote(resolvedScript)}`;
    return executeCommand(command, timeout, onData).then(hostRun =>
      hostRun.success
        ? { success: true, message: 'hook completed on host' }
        : { success: false, error: `host hook failed: ${hostRun.error}` }
    );
  }
  if (!params.ip) {
    return Promise.resolve({ success: false, error: 'ip is required for guest-target hooks' });
  }
  const target = {
    ip: params.ip,
    port: params.port,
    credentials: params.credentials,
    username: params.credentials.username || 'root',
    provisioningBasePath: params.provisioningBasePath,
    winrm: params.winrm,
  };
  return runGuestHook(target, resolvedScript, params.taskId, {
    env: params.env,
    timeout,
    onData,
    communicator: params.communicator,
  });
};
