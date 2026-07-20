export const shellQuote = value => `'${String(value).replace(/'/gu, "'\\''")}'`;

export const POSIX_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * Filter an env map to POSIX-legal names with loud narration for the rest.
 * @param {Object} env - Environment map
 * @param {Function|null} onData - Output sink
 * @returns {Array<[string, string]>} Legal entries
 */
export const legalEnvEntries = (env, onData) =>
  Object.entries(env || {}).filter(([key]) => {
    if (POSIX_NAME.test(key)) {
      return true;
    }
    onData?.({
      stream: 'stdout',
      data: `var "${key}" cannot become an environment variable (non-POSIX name) — skipped\n`,
    });
    return false;
  });
