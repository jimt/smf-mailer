// @ts-check
/**
 * Simple file logger
 *
 * Usage:
 *   import createLogger from "./logger.js";  // ESM
 *   const log = createLogger("info");        // default level
 *   log.setLevel("debug");                   // override later (e.g. from .rc)
 *   log.debug("message");
 *   log.info("message");
 *   log.warn("message");
 *   log.error("message");
 */

import { appendFileSync } from "fs";
import { join } from "path";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LOGFILE = join(import.meta.dirname, "smf.log");

/**
 * Create a logger that writes timestamped lines to smf.log.
 * @param {string} [defaultLevel="info"] - minimum level to log
 */
function createLogger(defaultLevel = "info") {
  let threshold = LEVELS[defaultLevel] ?? LEVELS.info;

  /**
   * @param {string} level
   * @param {any[]} args
   */
  function write(level, args) {
    if (LEVELS[level] < threshold) return;
    const ts = new Date().toISOString();
    const msg = args
      .map((a) => (a instanceof Error ? a.stack || a.message : String(a)))
      .join(" ");
    appendFileSync(LOGFILE, `[${ts}] [${level.toUpperCase()}] ${msg}\n`);
  }

  return {
    /** Override the log level (e.g. from config file). */
    setLevel(level) {
      const l = String(level).toLowerCase();
      if (l in LEVELS) {
        threshold = LEVELS[l];
      }
    },
    debug(...args) { write("debug", args); },
    info(...args)  { write("info", args); },
    warn(...args)  { write("warn", args); },
    error(...args) { write("error", args); },
  };
}

export default createLogger;
