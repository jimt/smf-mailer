// @ts-check
/**
 * Simple file logger
 *
 * Usage:
 *   const log = require("./logger")("info");   // default level
 *   log.setLevel("debug");                     // override later (e.g. from .rc)
 *   log.debug("message");
 *   log.info("message");
 *   log.warn("message");
 *   log.error("message");
 */

const fs = require("fs");
const path = require("path");

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LOGFILE = path.join(__dirname, "smf.log");

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
    fs.appendFileSync(LOGFILE, `[${ts}] [${level.toUpperCase()}] ${msg}\n`);
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

module.exports = createLogger;
