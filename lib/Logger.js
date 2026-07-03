/**
 * @fileoverview Centralized Logging System for Zoneweaver Agent
 * @description Winston-based logging with daily rotation, compression, and Morgan access logging
 * @author Mark Gilbert
 * @license: https://zoneweaver-agent.startcloud.com/license/
 */

import winston from 'winston';
import morgan from 'morgan';
import fs from 'fs';
import { join, dirname, basename } from 'path';
import zlib from 'zlib';
import config from '../config/ConfigLoader.js';

const loggingConfig = config.get('logging') || {
  level: 'info',
  console_enabled: true,
  log_directory: '/var/log/zoneweaver-agent',
  enable_compression: true,
  compression_age_days: 7,
  max_files: 30,
  performance_threshold_ms: 1000,
  categories: {},
};

const logDir = loggingConfig.log_directory || '/var/log/zoneweaver-agent';
const enableCompression = loggingConfig.enable_compression !== false;
const compressionAgeDays = loggingConfig.compression_age_days || 7;
const maxFiles = loggingConfig.max_files || 30;

const ensureLogDirectory = dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  }
};

ensureLogDirectory(logDir);

/**
 * Compress a file with gzip and remove the original
 * @param {string} filePath - Path to compress
 */
const compressFile = async filePath => {
  try {
    const compressedPath = `${filePath}.gz`;

    if (fs.existsSync(compressedPath)) {
      return;
    }

    const readStream = fs.createReadStream(filePath);
    const writeStream = fs.createWriteStream(compressedPath);
    const gzip = zlib.createGzip();

    await new Promise((resolve, reject) => {
      readStream.pipe(gzip).pipe(writeStream).on('finish', resolve).on('error', reject);
    });

    await fs.promises.unlink(filePath);
  } catch {
    void 0;
  }
};

/**
 * Rotate a log file to archive/ with date-based naming, compress aged files, prune excess
 * @param {string} filePath - Path to the current log file
 * @param {number} maxArchiveFiles - Maximum archive files to keep per category
 */
const rotateLogFile = async (filePath, maxArchiveFiles) => {
  try {
    const archiveDir = join(dirname(filePath), 'archive');

    try {
      await fs.promises.mkdir(archiveDir, { recursive: true });
    } catch {
      return;
    }

    const baseName = basename(filePath);
    const [today] = new Date().toISOString().split('T');
    const archiveName = `${baseName}.${today}`;

    if (fs.existsSync(filePath)) {
      await fs.promises.rename(filePath, join(archiveDir, archiveName));
    }

    if (enableCompression) {
      const compressionThreshold = new Date();
      compressionThreshold.setDate(compressionThreshold.getDate() - compressionAgeDays);

      const archiveFiles = await fs.promises.readdir(archiveDir);
      const uncompressedArchives = archiveFiles
        .filter(file => file.startsWith(baseName) && !file.endsWith('.gz'))
        .filter(file => {
          const dateMatch = file.match(/\.(?<date>\d{4}-\d{2}-\d{2})(?:\.(?<counter>\d+))?$/);
          if (dateMatch) {
            const fileDate = new Date(dateMatch.groups.date);
            return fileDate < compressionThreshold;
          }
          return false;
        });

      await Promise.all(uncompressedArchives.map(file => compressFile(join(archiveDir, file))));
    }

    const archiveFiles = await fs.promises.readdir(archiveDir);
    const logArchives = archiveFiles
      .filter(file => file.startsWith(baseName))
      .sort()
      .reverse();

    if (logArchives.length > maxArchiveFiles) {
      const filesToDelete = logArchives.slice(maxArchiveFiles);
      await Promise.all(filesToDelete.map(file => fs.promises.unlink(join(archiveDir, file))));
    }
  } catch {
    void 0;
  }
};

/**
 * Custom daily rotating file transport that checks date on every write
 * and rotates the log file when the date changes
 */
class DailyRotatingFileTransport extends winston.transports.File {
  constructor(options) {
    super(options);
    this.maxFiles = options.maxFiles || maxFiles;
    this.lastRotateDate = null;
  }

  async write(info, callback) {
    try {
      const [currentDate] = new Date().toISOString().split('T');

      if (this.lastRotateDate !== currentDate && fs.existsSync(this.filename)) {
        await rotateLogFile(this.filename, this.maxFiles);
        this.lastRotateDate = currentDate;
      }
    } catch {
      void 0;
    }

    super.write(info, callback);
  }
}

/**
 * Move existing log files to archive on startup
 */
const initializeLogDirectory = () => {
  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const logFileNames = [
      'application.log',
      'errors.log',
      'access.log',
      'monitoring.log',
      'database.log',
      'api-requests.log',
      'filesystem.log',
      'tasks.log',
      'auth.log',
      'websocket.log',
      'performance.log',
      'artifact.log',
    ];

    for (const logFile of logFileNames) {
      const logPath = join(logDir, logFile);
      if (fs.existsSync(logPath)) {
        try {
          const archiveDir = join(logDir, 'archive');
          if (!fs.existsSync(archiveDir)) {
            fs.mkdirSync(archiveDir, { recursive: true });
          }

          const [today] = new Date().toISOString().split('T');
          let archiveName = `${logFile}.${today}`;
          let archivePath = join(archiveDir, archiveName);

          let counter = 1;
          while (fs.existsSync(archivePath) && counter < 1000) {
            archiveName = `${logFile}.${today}.${counter}`;
            archivePath = join(archiveDir, archiveName);
            counter++;
          }

          fs.renameSync(logPath, archivePath);
        } catch {
          void 0;
        }
      }
    }
  } catch {
    void 0;
  }
};

initializeLogDirectory();

/**
 * Common log format configuration
 */
const logFormat = winston.format.combine(
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

const consoleFormatter = winston.format.printf(consoleFormatTemplate);

/**
 * Create a logger for a specific category with daily rotation
 * @param {string} category - Log category name
 * @param {string} filename - Log filename (without extension)
 * @returns {winston.Logger} Configured winston logger
 */
const createCategoryLogger = (category, filename) => {
  const categoryLevel = loggingConfig.categories[category] || loggingConfig.level;
  const categoryTransports = [];

  categoryTransports.push(
    new DailyRotatingFileTransport({
      filename: join(logDir, `${filename}.log`),
      level: categoryLevel,
      format: winston.format.json(),
      maxFiles,
    })
  );

  if (loggingConfig.console_enabled && process.env.NODE_ENV !== 'production') {
    categoryTransports.push(
      new winston.transports.Console({
        level: categoryLevel,
        format: winston.format.combine(
          winston.format.timestamp({ format: 'HH:mm:ss' }),
          winston.format.colorize({ all: true }),
          consoleFormatter
        ),
      })
    );
  }

  return winston.createLogger({
    level: categoryLevel,
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    defaultMeta: { category, service: 'zoneweaver-agent' },
    transports: categoryTransports,
    exitOnError: false,
    silent: loggingConfig.level === 'silent',
  });
};

/**
 * Category-specific loggers
 */
const monitoringLogger = createCategoryLogger('monitoring', 'monitoring');
const databaseLogger = createCategoryLogger('database', 'database');
const apiRequestLogger = createCategoryLogger('api-request', 'api-requests');
const filesystemLogger = createCategoryLogger('filesystem', 'filesystem');
const taskLogger = createCategoryLogger('task', 'tasks');
const authLogger = createCategoryLogger('auth', 'auth');
const websocketLogger = createCategoryLogger('websocket', 'websocket');
const performanceLogger = createCategoryLogger('performance', 'performance');
const artifactLogger = createCategoryLogger('artifact', 'artifact');

/**
 * General application logger
 */
const appTransports = [
  new DailyRotatingFileTransport({
    filename: join(logDir, 'application.log'),
    format: winston.format.json(),
    maxFiles,
  }),
  new DailyRotatingFileTransport({
    filename: join(logDir, 'errors.log'),
    format: winston.format.json(),
    level: 'error',
    maxFiles,
  }),
];

if (loggingConfig.console_enabled && process.env.NODE_ENV !== 'production') {
  appTransports.push(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        winston.format.colorize({ all: true }),
        consoleFormatter
      ),
    })
  );
}

const appLogger = winston.createLogger({
  level: process.env.LOG_LEVEL || loggingConfig.level,
  format: logFormat,
  transports: appTransports,
  defaultMeta: { category: 'app', service: 'zoneweaver-agent' },
  exitOnError: false,
});

/**
 * Access logger for Morgan HTTP request logging
 */
const accessLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new DailyRotatingFileTransport({
      filename: join(logDir, 'access.log'),
      format: winston.format.json(),
      level: 'info',
      maxFiles,
    }),
  ],
});

/**
 * Morgan stream and middleware for HTTP access logging
 */
const morganStream = {
  write: message => accessLogger.info(message.trim()),
};

const morganMiddleware = morgan('combined', {
  stream: morganStream,
});

/**
 * Helper function to safely log with fallback to stderr
 * @param {winston.Logger} logger - Winston logger instance
 * @param {string} level - Log level
 * @param {string} message - Log message
 * @param {Object} meta - Additional metadata
 */
const safeLog = (logger, level, message, meta = {}) => {
  let logMeta = meta;
  try {
    if (typeof logMeta !== 'object' && logMeta !== null) {
      logMeta = { data: logMeta };
    }
    logger[level](message, logMeta);
  } catch (error) {
    const timestamp = new Date().toISOString();
    const metaStr = logMeta && Object.keys(logMeta).length > 0 ? ` ${JSON.stringify(logMeta)}` : '';
    process.stderr.write(
      `${timestamp} [${level.toUpperCase()}] ${message}${metaStr} (Winston error: ${error.message})\n`
    );
  }
};

/**
 * Convenience logging functions for each category
 */
export const log = {
  monitoring: {
    info: (msg, meta) => safeLog(monitoringLogger, 'info', msg, meta),
    warn: (msg, meta) => safeLog(monitoringLogger, 'warn', msg, meta),
    error: (msg, meta) => safeLog(monitoringLogger, 'error', msg, meta),
    debug: (msg, meta) => safeLog(monitoringLogger, 'debug', msg, meta),
  },

  database: {
    info: (msg, meta) => safeLog(databaseLogger, 'info', msg, meta),
    warn: (msg, meta) => safeLog(databaseLogger, 'warn', msg, meta),
    error: (msg, meta) => safeLog(databaseLogger, 'error', msg, meta),
    debug: (msg, meta) => safeLog(databaseLogger, 'debug', msg, meta),
  },

  api: {
    info: (msg, meta) => safeLog(apiRequestLogger, 'info', msg, meta),
    warn: (msg, meta) => safeLog(apiRequestLogger, 'warn', msg, meta),
    error: (msg, meta) => safeLog(apiRequestLogger, 'error', msg, meta),
    debug: (msg, meta) => safeLog(apiRequestLogger, 'debug', msg, meta),
  },

  filesystem: {
    info: (msg, meta) => safeLog(filesystemLogger, 'info', msg, meta),
    warn: (msg, meta) => safeLog(filesystemLogger, 'warn', msg, meta),
    error: (msg, meta) => safeLog(filesystemLogger, 'error', msg, meta),
    debug: (msg, meta) => safeLog(filesystemLogger, 'debug', msg, meta),
  },

  task: {
    info: (msg, meta) => safeLog(taskLogger, 'info', msg, meta),
    warn: (msg, meta) => safeLog(taskLogger, 'warn', msg, meta),
    error: (msg, meta) => safeLog(taskLogger, 'error', msg, meta),
    debug: (msg, meta) => safeLog(taskLogger, 'debug', msg, meta),
  },

  auth: {
    info: (msg, meta) => safeLog(authLogger, 'info', msg, meta),
    warn: (msg, meta) => safeLog(authLogger, 'warn', msg, meta),
    error: (msg, meta) => safeLog(authLogger, 'error', msg, meta),
    debug: (msg, meta) => safeLog(authLogger, 'debug', msg, meta),
  },

  websocket: {
    info: (msg, meta) => safeLog(websocketLogger, 'info', msg, meta),
    warn: (msg, meta) => safeLog(websocketLogger, 'warn', msg, meta),
    error: (msg, meta) => safeLog(websocketLogger, 'error', msg, meta),
    debug: (msg, meta) => safeLog(websocketLogger, 'debug', msg, meta),
  },

  performance: {
    info: (msg, meta) => safeLog(performanceLogger, 'info', msg, meta),
    warn: (msg, meta) => safeLog(performanceLogger, 'warn', msg, meta),
    error: (msg, meta) => safeLog(performanceLogger, 'error', msg, meta),
    debug: (msg, meta) => safeLog(performanceLogger, 'debug', msg, meta),
  },

  app: {
    info: (msg, meta) => safeLog(appLogger, 'info', msg, meta),
    warn: (msg, meta) => safeLog(appLogger, 'warn', msg, meta),
    error: (msg, meta) => safeLog(appLogger, 'error', msg, meta),
    debug: (msg, meta) => safeLog(appLogger, 'debug', msg, meta),
  },

  artifact: {
    info: (msg, meta) => safeLog(artifactLogger, 'info', msg, meta),
    warn: (msg, meta) => safeLog(artifactLogger, 'warn', msg, meta),
    error: (msg, meta) => safeLog(artifactLogger, 'error', msg, meta),
    debug: (msg, meta) => safeLog(artifactLogger, 'debug', msg, meta),
  },
};

/**
 * Performance timing helper
 * @param {string} operation - Operation name
 * @returns {Object} Timer object with end() function
 */
export const createTimer = operation => {
  const start = process.hrtime.bigint();
  return {
    end: (meta = {}) => {
      const end = process.hrtime.bigint();
      const duration = Number(end - start) / 1000000;

      const thresholdMs = loggingConfig.performance_threshold_ms || 1000;
      if (duration >= thresholdMs) {
        log.performance.warn(`Slow operation detected: ${operation}`, {
          operation,
          duration_ms: Math.round(duration * 100) / 100,
          threshold_ms: thresholdMs,
          ...meta,
        });
      }

      return Math.round(duration * 100) / 100;
    },
  };
};

/**
 * Request logging middleware helper
 * @param {string} requestId - Unique request identifier
 * @param {Object} req - Express request object
 * @returns {Object} Request logger with timing
 */
export const createRequestLogger = (requestId, req) => {
  const start = Date.now();

  const logData = {
    requestId,
    method: req.method,
    path: req.path,
    user: req.entity?.name,
    ip: req.ip || req.connection?.remoteAddress,
    userAgent: req.get('User-Agent'),
  };

  log.api.info('Request started', logData);

  return {
    success: (statusCode, meta = {}) => {
      const duration = Date.now() - start;
      log.api.info('Request completed', {
        ...logData,
        status: statusCode,
        duration_ms: duration,
        success: true,
        ...meta,
      });
    },

    error: (statusCode, error, meta = {}) => {
      const duration = Date.now() - start;
      log.api.error('Request failed', {
        ...logData,
        status: statusCode,
        duration_ms: duration,
        success: false,
        error,
        ...meta,
      });
    },
  };
};

appLogger.info('Application logger initialized');
accessLogger.info('Access logger initialized');
databaseLogger.info('Database logger initialized');
authLogger.info('Auth logger initialized');
artifactLogger.info('Artifact logger initialized');

export { morganMiddleware };

export default {
  log,
  createTimer,
  createRequestLogger,
};
