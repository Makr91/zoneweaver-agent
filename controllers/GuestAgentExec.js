import { runGuestCommand } from '../lib/QemuGuestAgent.js';

export const decodeExecStatus = reply => {
  const status = { exited: Boolean(reply?.exited) };
  if (typeof reply?.exitcode === 'number') {
    status.exitcode = reply.exitcode;
  }
  if (typeof reply?.signal === 'number') {
    status.signal = reply.signal;
  }
  if (reply?.['out-data']) {
    status.stdout = Buffer.from(reply['out-data'], 'base64').toString('utf8');
  }
  if (reply?.['err-data']) {
    status.stderr = Buffer.from(reply['err-data'], 'base64').toString('utf8');
  }
  return status;
};

export const pollExecUntilExit = (channel, pid, timeoutSeconds, res) => {
  const deadline = Date.now() + timeoutSeconds * 1000;

  const poll = async () => {
    let outcome;
    try {
      outcome = await runGuestCommand(channel.socketPath, 'guest-exec-status', { pid }, 5000);
    } catch (error) {
      return res
        .status(502)
        .json({ error: `Guest agent stopped answering while waiting: ${error.message}` });
    }
    const status = decodeExecStatus(outcome.reply);
    if (status.exited) {
      return res.json({
        success: true,
        machine_name: channel.zoneName,
        pid,
        ...status,
      });
    }
    if (Date.now() > deadline) {
      return res.json({
        success: true,
        machine_name: channel.zoneName,
        pid,
        exited: false,
        message: `Still running after ${timeoutSeconds}s — poll GET /machines/{name}/guest/exec/${pid}`,
      });
    }
    await new Promise(resolve => {
      setTimeout(resolve, 1000);
    });
    return poll();
  };

  return poll();
};
