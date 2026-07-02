import winston from "winston";

const { combine, timestamp, json, colorize, printf, errors } = winston.format;

const isProduction = process.env.NODE_ENV === "production";

/**
 * Human-readable format used in development.
 * Example:  2024-01-15T12:00:00.000Z [INFO] escrow-backend: Server started { port: 3001 }
 */
const devFormat = combine(
  colorize({ all: true }),
  timestamp(),
  errors({ stack: true }),
  printf(({ timestamp, level, message, service, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
    const stackStr = stack ? `\n${stack}` : "";
    return `${timestamp} [${level}] ${service}: ${message}${metaStr}${stackStr}`;
  })
);

/**
 * Structured JSON format used in production / CI.
 * Each log line is a single JSON object with timestamp, level, message, and
 * arbitrary metadata – easy to ingest into any log aggregator.
 */
const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json()
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (isProduction ? "info" : "debug"),
  format: isProduction ? prodFormat : devFormat,
  defaultMeta: { service: "escrow-backend" },
  transports: [
    new winston.transports.Console(),
  ],
});

export default logger;
