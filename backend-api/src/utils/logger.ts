type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  meta?: Record<string, any>;
}

const formatTimestamp = (): string => {
  return new Date().toISOString();
};

const formatLog = (level: LogLevel, message: string, meta?: Record<string, any>): LogEntry => {
  return {
    timestamp: formatTimestamp(),
    level,
    message,
    ...(meta && Object.keys(meta).length > 0 && { meta }),
  };
};

const writeLog = (entry: LogEntry): void => {
  const { timestamp, level, message, meta } = entry;
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';

  switch (level) {
    case 'error':
      console.error(`${prefix} ${message}${metaStr}`);
      break;
    case 'warn':
      console.warn(`${prefix} ${message}${metaStr}`);
      break;
    case 'debug':
      if (process.env.NODE_ENV === 'development') {
        console.debug(`${prefix} ${message}${metaStr}`);
      }
      break;
    default:
      console.log(`${prefix} ${message}${metaStr}`);
  }
};

const logger = {
  info(message: string, meta?: Record<string, any>): void {
    writeLog(formatLog('info', message, meta));
  },

  warn(message: string, meta?: Record<string, any>): void {
    writeLog(formatLog('warn', message, meta));
  },

  error(message: string, meta?: Record<string, any>): void {
    writeLog(formatLog('error', message, meta));
  },

  debug(message: string, meta?: Record<string, any>): void {
    writeLog(formatLog('debug', message, meta));
  },

  child(context: Record<string, any>): typeof logger {
    return {
      info: (message: string, meta?: Record<string, any>) =>
        logger.info(message, { ...context, ...meta }),
      warn: (message: string, meta?: Record<string, any>) =>
        logger.warn(message, { ...context, ...meta }),
      error: (message: string, meta?: Record<string, any>) =>
        logger.error(message, { ...context, ...meta }),
      debug: (message: string, meta?: Record<string, any>) =>
        logger.debug(message, { ...context, ...meta }),
      child: (innerContext: Record<string, any>) =>
        logger.child({ ...context, ...innerContext }),
    };
  },
};

export default logger;
