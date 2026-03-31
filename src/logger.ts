/**
 * logger.ts
 *
 * Structured logging with rotating file output for the tennis court scraper.
 *
 * Features:
 *   - Log levels: DEBUG, INFO, WARN, ERROR
 *   - Timestamped entries with ISO 8601 format (Korea timezone)
 *   - Daily rotating log files (scraper-YYYY-MM-DD.log)
 *   - Automatic cleanup of old log files (configurable retention)
 *   - Dual output: console (for cron capture) + file (for direct access)
 *   - Drop-in replacement for console.log/warn/error
 *   - Max file size rotation within a single day
 */

import fs from "node:fs";
import path from "node:path";

// ─── Types ──────────────────────────────────────────────────────────────────

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const LOG_LEVEL_LABELS: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "DEBUG",
  [LogLevel.INFO]: "INFO",
  [LogLevel.WARN]: "WARN",
  [LogLevel.ERROR]: "ERROR",
};

export interface LoggerConfig {
  /** Directory for log files (default: <project>/logs) */
  logDir: string;
  /** Minimum log level to output (default: INFO, or DEBUG if LOG_LEVEL=debug) */
  minLevel: LogLevel;
  /** Log file prefix (default: "scraper") */
  filePrefix: string;
  /** Maximum log file size in bytes before rotating (default: 10MB) */
  maxFileSize: number;
  /** Number of days to retain log files (default: 7) */
  retentionDays: number;
  /** Whether to also write to console (default: true) */
  consoleOutput: boolean;
  /** Whether to write to file (default: true) */
  fileOutput: boolean;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(process.cwd());

/**
 * Resolve log level from LOG_LEVEL env var.
 * Accepts: "debug", "info", "warn", "error" (case-insensitive).
 */
function resolveLogLevel(): LogLevel {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase();
  switch (envLevel) {
    case "debug": return LogLevel.DEBUG;
    case "info": return LogLevel.INFO;
    case "warn": return LogLevel.WARN;
    case "error": return LogLevel.ERROR;
    default: return LogLevel.INFO;
  }
}

const DEFAULT_CONFIG: LoggerConfig = {
  logDir: path.join(PROJECT_ROOT, "logs"),
  minLevel: resolveLogLevel(),
  filePrefix: "scraper",
  maxFileSize: 10 * 1024 * 1024, // 10 MB
  retentionDays: 7,
  consoleOutput: true,
  fileOutput: true,
};

// ─── Logger Class ───────────────────────────────────────────────────────────

class Logger {
  private config: LoggerConfig;
  private currentLogDate: string = "";
  private currentLogPath: string = "";
  private rotationIndex: number = 0;

  constructor(config?: Partial<LoggerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.ensureLogDir();
  }

  // ── Public logging methods ────────────────────────────────────────────

  debug(message: string, ...args: unknown[]): void {
    this.log(LogLevel.DEBUG, message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.log(LogLevel.INFO, message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.log(LogLevel.WARN, message, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    this.log(LogLevel.ERROR, message, ...args);
  }

  // ── Core log method ───────────────────────────────────────────────────

  private log(level: LogLevel, message: string, ...args: unknown[]): void {
    if (level < this.config.minLevel) return;

    const timestamp = this.getKoreaTimestamp();
    const levelLabel = LOG_LEVEL_LABELS[level];
    const formattedArgs = args.length > 0
      ? " " + args.map((a) => this.formatArg(a)).join(" ")
      : "";
    const logLine = `[${timestamp}] [${levelLabel}] ${message}${formattedArgs}`;

    // Console output (captured by run.sh into cron.log)
    if (this.config.consoleOutput) {
      switch (level) {
        case LogLevel.ERROR:
          console.error(logLine);
          break;
        case LogLevel.WARN:
          console.warn(logLine);
          break;
        case LogLevel.DEBUG:
          console.debug(logLine);
          break;
        default:
          console.log(logLine);
      }
    }

    // File output (direct rotating log file)
    if (this.config.fileOutput) {
      this.writeToFile(logLine);
    }
  }

  // ── File writing with rotation ────────────────────────────────────────

  private writeToFile(line: string): void {
    try {
      const today = this.getKoreaDateString();

      // Rotate to new file on date change
      if (today !== this.currentLogDate) {
        this.currentLogDate = today;
        this.rotationIndex = 0;
        this.currentLogPath = this.buildLogPath(today, 0);

        // Run old log cleanup asynchronously (don't block logging)
        this.cleanupOldLogs().catch(() => {});
      }

      // Check file size for within-day rotation
      this.checkSizeRotation();

      // Synchronous append — reliable for short-lived cron processes
      fs.appendFileSync(this.currentLogPath, line + "\n", "utf-8");
    } catch (err) {
      // If file logging fails, at least stderr will have the message
      // (from console output above). Don't recurse.
      if (this.config.consoleOutput) {
        console.error(`[Logger] File write failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  private checkSizeRotation(): void {
    if (!this.currentLogPath) return;

    try {
      if (!fs.existsSync(this.currentLogPath)) return;
      const stat = fs.statSync(this.currentLogPath);
      if (stat.size >= this.config.maxFileSize) {
        this.rotationIndex++;
        this.currentLogPath = this.buildLogPath(this.currentLogDate, this.rotationIndex);
      }
    } catch {
      // File may not exist yet, that's fine
    }
  }

  private buildLogPath(dateStr: string, index: number): string {
    const suffix = index > 0 ? `.${index}` : "";
    return path.join(
      this.config.logDir,
      `${this.config.filePrefix}-${dateStr}${suffix}.log`
    );
  }

  // ── Log cleanup ───────────────────────────────────────────────────────

  /**
   * Delete log files older than retentionDays.
   */
  async cleanupOldLogs(): Promise<number> {
    let deletedCount = 0;
    try {
      const files = fs.readdirSync(this.config.logDir);
      const cutoffMs = Date.now() - this.config.retentionDays * 24 * 60 * 60 * 1000;

      for (const file of files) {
        if (!file.endsWith(".log")) continue;

        const filePath = path.join(this.config.logDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs < cutoffMs) {
            fs.unlinkSync(filePath);
            deletedCount++;
          }
        } catch {
          // Skip files we can't stat/delete
        }
      }

      if (deletedCount > 0) {
        this.info(`Cleaned up ${deletedCount} old log file(s)`);
      }
    } catch {
      // Log dir may not exist yet
    }
    return deletedCount;
  }

  // ── Utility ───────────────────────────────────────────────────────────

  private ensureLogDir(): void {
    try {
      fs.mkdirSync(this.config.logDir, { recursive: true });
    } catch {
      // Ignore — will fail on first write attempt instead
    }
  }

  private getKoreaTimestamp(): string {
    return new Date().toLocaleString("sv-SE", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).replace(",", "");
  }

  private getKoreaDateString(): string {
    return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
  }

  private formatArg(arg: unknown): string {
    if (arg instanceof Error) {
      return `${arg.message}${arg.stack ? "\n" + arg.stack : ""}`;
    }
    if (typeof arg === "object" && arg !== null) {
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    }
    return String(arg);
  }

  /**
   * No-op for synchronous writes. Kept for API compatibility.
   */
  shutdown(): void {
    // Synchronous writes don't need flushing
  }

  /**
   * Get the current log file path (useful for diagnostics).
   */
  get logFilePath(): string {
    return this.currentLogPath;
  }

  /**
   * Update configuration at runtime.
   */
  configure(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config };
    if (config.logDir) {
      this.ensureLogDir();
    }
  }

  /**
   * Log a cron run summary — useful for monitoring and debugging cron execution.
   * Includes process info, memory usage, and run duration.
   */
  logRunStart(): { startTime: number } {
    const startTime = Date.now();
    const memUsage = process.memoryUsage();
    this.info(
      `[Run] ════════════════════════════════════════════════════════`
    );
    this.info(
      `[Run] Starting scraper run | PID: ${process.pid} | Node: ${process.version}`
    );
    this.info(
      `[Run] Memory: RSS=${(memUsage.rss / 1024 / 1024).toFixed(1)}MB, ` +
        `Heap=${(memUsage.heapUsed / 1024 / 1024).toFixed(1)}/${(memUsage.heapTotal / 1024 / 1024).toFixed(1)}MB`
    );
    this.info(
      `[Run] Log file: ${this.currentLogPath || "(not yet initialized)"}`
    );
    return { startTime };
  }

  /**
   * Log a cron run completion with duration and outcome.
   */
  logRunEnd(startTime: number, outcome: { success: boolean; slotsFound?: number; error?: string }): void {
    const durationMs = Date.now() - startTime;
    const durationSec = (durationMs / 1000).toFixed(1);
    const memUsage = process.memoryUsage();

    if (outcome.success) {
      this.info(
        `[Run] Completed successfully in ${durationSec}s | ` +
          `Slots found: ${outcome.slotsFound ?? 0} | ` +
          `Memory: RSS=${(memUsage.rss / 1024 / 1024).toFixed(1)}MB`
      );
    } else {
      this.error(
        `[Run] Failed after ${durationSec}s | Error: ${outcome.error ?? "unknown"}`
      );
    }
    this.info(
      `[Run] ════════════════════════════════════════════════════════`
    );
  }
}

// ─── Singleton Instance ─────────────────────────────────────────────────────

/**
 * Global logger instance — import and use directly.
 *
 * Automatically applies LOG_CONFIG from config.ts (logDir, retentionDays,
 * maxFileSize) so all modules share consistent file-based logging.
 *
 * Configuration priority:
 *   1. LOG_CONFIG values from config.ts (loaded from .env via dotenv)
 *   2. LOG_LEVEL env var for minimum log level
 *   3. Built-in defaults
 */
function createConfiguredLogger(): Logger {
  // The logger uses DEFAULT_CONFIG which already reads from process.cwd()/logs.
  // LOG_CONFIG in config.ts mirrors these values. To avoid circular dependency
  // (config.ts may import logger), we resolve config values directly here.
  const logDir = process.env.LOG_DIR
    ? path.resolve(process.env.LOG_DIR)
    : path.join(PROJECT_ROOT, "logs");
  const retentionDays = parseInt(process.env.LOG_RETENTION_DAYS ?? "7", 10);
  const maxFileSize = parseInt(
    process.env.LOG_MAX_FILE_SIZE ?? String(10 * 1024 * 1024),
    10
  );

  return new Logger({ logDir, retentionDays, maxFileSize });
}

export const logger = createConfiguredLogger();

// Ensure clean shutdown on process exit
process.on("exit", () => logger.shutdown());
process.on("SIGINT", () => {
  logger.shutdown();
  process.exit(0);
});
process.on("SIGTERM", () => {
  logger.shutdown();
  process.exit(0);
});

export default logger;
