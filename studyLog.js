// Append-only study event logger.
//
// Writes one JSON object per line (JSONL) to study-logs/events.jsonl so that
// per-task measurements (timing, emojis shown vs. chosen, override counts) can
// be analyzed offline. Logging never throws: a logging failure must never
// interrupt a live participant session.
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LOG_DIR = process.env.STUDY_LOG_DIR || path.join(__dirname, "study-logs");
const LOG_FILE = path.join(LOG_DIR, "events.jsonl");

let dirReady = null;
function ensureDir() {
  if (!dirReady) dirReady = fs.mkdir(LOG_DIR, { recursive: true });
  return dirReady;
}

// Append a single event record. `data` is merged into the record alongside an
// ISO timestamp and the event `type`.
export async function logEvent(type, data = {}) {
  try {
    await ensureDir();
    const record = { ts: new Date().toISOString(), type, ...data };
    await fs.appendFile(LOG_FILE, JSON.stringify(record) + "\n", "utf8");
  } catch (err) {
    console.error("[study] Failed to write log event:", err);
  }
}

export { LOG_FILE };
