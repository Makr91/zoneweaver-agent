/**
 * ANSI escape sequence regex for terminal color codes and control sequences
 * Strips: colors, cursor movement, formatting, etc.
 * Constructing regex dynamically to avoid control character linting error
 */
export const createAnsiRegex = () => {
  const esc = String.fromCharCode(27);
  const csi = String.fromCharCode(155);
  return new RegExp(
    `[${esc}${csi}][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]`,
    'g'
  );
};
export const ANSI_REGEX = createAnsiRegex();
