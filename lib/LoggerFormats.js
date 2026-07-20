import winston from 'winston';

/**
 * Common log format configuration
 */
export const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

/**
 * Console format for development
 */
const consoleFormatTemplate = ({ level, message, timestamp, category: cat, ...meta }) => {
  const categoryStr = cat ? `[${cat}]` : '';
  const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta, null, 0)}` : '';
  return `${timestamp} ${categoryStr} ${level}: ${message}${metaStr}`;
};

export const consoleFormatter = winston.format.printf(consoleFormatTemplate);
