import { type Config, secretValues } from "@sanctions-desk/shared";
import { type DestinationStream, type Logger, type LoggerOptions, pino } from "pino";

const REDACT_PATHS = [
  "req.headers.authorization",
  'req.headers["x-api-key"]',
  "res.headers['set-cookie']",
  "*.authorization",
  "*.token",
  "*.apiKey",
  "*.runtimeToken",
];

/**
 * Application logger (pino). Known secret values and sensitive fields are masked in every line. Lines go to stdout
 * unless another destination is given (`npm run case` sends them to stderr, so stdout carries only the run).
 */
export function createLogger(cfg: Config, destination?: DestinationStream): Logger {
  const secrets = secretValues(cfg);
  const options: LoggerOptions<never> = {
    level: cfg.logging.stdout ? cfg.logging.level : "silent",
    base: { service: "sanctions-desk-api" },
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    formatters: { level: (label) => ({ level: label }) },
    hooks: {
      // Last line of defence: mask any configured secret that ends up inside a message string.
      logMethod(args, method) {
        const masked = args.map((a) => (typeof a === "string" ? maskSecrets(a, secrets) : a));
        return method.apply(this, masked as Parameters<typeof method>);
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return destination ? pino(options, destination) : pino(options);
}

function maskSecrets(text: string, secrets: readonly string[]): string {
  return secrets.reduce((acc, s) => (s.length >= 6 ? acc.split(s).join("[REDACTED]") : acc), text);
}
