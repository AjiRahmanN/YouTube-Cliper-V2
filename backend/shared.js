import IORedis from "ioredis";
import path from "node:path";

export const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
export const QUEUE = "clips";
export const DATA = path.resolve(process.env.DATA_DIR || "data"); // harus satu volume untuk API dan worker
export const MAX_CLIPS = 10;
export const MAX_CLIP_SEC = 600;
export const TTL_SEC = 3600;

export const redis = () => {
  const c = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  c.on("error", (e) => log(`Redis error: ${e.message}`));
  c.on("ready", () => log("Redis terhubung"));
  return c;
};
export const hms = (s) => {
  s = Math.floor(s);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};

export const log = (...a) => console.log(`[${new Date().toLocaleTimeString("id-ID", { hour12: false })}]`, ...a);
