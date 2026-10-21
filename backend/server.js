import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { QUEUE, DATA, MAX_CLIPS, MAX_CLIP_SEC, TTL_SEC, redis, log } from "./shared.js";

const PORT = process.env.PORT || 4000;
const ORIGINS = (process.env.FRONTEND_ORIGIN || "http://localhost:3000").split(",").map((s) => s.trim());
const MAX_WAITING = 50;

const queue = new Queue(QUEUE, {
  connection: redis(),
  defaultJobOptions: { attempts: 1, removeOnComplete: { age: TTL_SEC }, removeOnFail: { age: TTL_SEC } },
});

const app = express();
app.use(cors({ origin: ORIGINS }));
app.use(express.json({ limit: "20kb" }));
app.use((req, res, next) => {
  const t = Date.now();
  res.on("finish", () => { // polling GET yang sukses tidak dicatat agar log tidak penuh
    if (req.method !== "GET" || res.statusCode >= 400) log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - t}ms) dari ${req.ip}`);
  });
  next();
});
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

function videoUrl(input) {
  try {
    const u = new URL(input);
    const host = u.hostname.replace(/^(www|m)\./, "");
    let id = null;
    if (host === "youtu.be") id = u.pathname.slice(1);
    else if (host === "youtube.com")
      id = u.searchParams.get("v") || u.pathname.match(/^\/(?:live|shorts|embed)\/([\w-]{11})/)?.[1];
    return /^[\w-]{11}$/.test(id || "") ? `https://www.youtube.com/watch?v=${id}` : null;
  } catch {
    return null;
  }
}

const statusOf = (state) => (state === "completed" ? "done" : state === "failed" ? "error" : state === "active" ? "running" : "queued");

// Info ringan video lewat yt-dlp: status live yang akurat (is_live / post_live / was_live / not_live / is_upcoming).
// Dipakai frontend untuk memilih mode clip, menggantikan tebakan dari durasi player.
const ytInfo = (url) =>
  new Promise((resolve, reject) => {
    const p = spawn("yt-dlp", ["--no-playlist", "--skip-download", "--no-warnings", "--print", "%(live_status)s|%(duration)s|%(title)s", url], { windowsHide: true });
    let out = "", err = "";
    const t = setTimeout(() => { p.kill(); reject(new Error("Timeout mengambil info video")); }, 90_000);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", () => { clearTimeout(t); reject(new Error("yt-dlp tidak ditemukan di server")); });
    p.on("close", (c) => {
      clearTimeout(t);
      if (c !== 0) return reject(new Error(err.split(/\r?\n/).find((l) => /^ERROR/i.test(l)) || "Gagal mengambil info video"));
      resolve(out.trim());
    });
  });

app.get("/api/info", rateLimit({ windowMs: 60_000, limit: 20 }), wrap(async (req, res) => {
  const clean = videoUrl(String(req.query.url || ""));
  if (!clean) return res.status(400).json({ error: "URL YouTube tidak valid" });
  try {
    const [liveStatus, duration, ...title] = (await ytInfo(clean)).split("|");
    res.json({ liveStatus, duration: Number(duration) || 0, title: title.join("|") });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}));

app.post("/api/jobs", rateLimit({ windowMs: 60_000, limit: 10 }), wrap(async (req, res) => {
  const { url, clips, format = "mp4" } = req.body || {};
  const clean = videoUrl(url);
  if (!clean) return res.status(400).json({ error: "URL YouTube tidak valid" });
  if (!["mp4", "mp3"].includes(format)) return res.status(400).json({ error: "Format tidak didukung" });
  if (!Array.isArray(clips) || clips.length < 1 || clips.length > MAX_CLIPS)
    return res.status(400).json({ error: `Kirim 1-${MAX_CLIPS} clip` });
  if ((await queue.count()) >= MAX_WAITING) return res.status(503).json({ error: "Antrean penuh, coba lagi nanti" });

  const items = [];
  for (const c of clips) {
    const mode = ["vod", "past", "record"].includes(c.mode) ? c.mode : "vod";
    const start = mode === "record" ? 0 : Number(c.start), end = Number(c.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > MAX_CLIP_SEC)
      return res.status(400).json({ error: `Tiap clip harus 1 detik sampai ${MAX_CLIP_SEC / 60} menit` });
    const name = String(c.name || `clip-${items.length + 1}`).replace(/[^\w\- ]/g, "").slice(0, 60) || `clip-${items.length + 1}`;
    items.push({ name, mode, start, end, status: "queued" });
  }

  const job = await queue.add("clip", { url: clean, format, items }, { jobId: randomUUID() });
  log(`job ${job.id} masuk antrean: ${items.length} clip, ${format}`);
  res.status(202).json({ id: job.id });
}));

app.get("/api/jobs/:id", wrap(async (req, res) => {
  const job = await queue.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job tidak ditemukan" });
  const status = statusOf(await job.getState());
  res.json({
    id: job.id,
    status,
    items: job.data.items.map(({ name, status: s, error, progress, startedAt }, i) => ({ name, status: s, error, progress, elapsed: s === "running" && startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0, href: s === "done" ? `/api/jobs/${job.id}/files/${i}` : null })),
  });
}));

app.get("/api/jobs/:id/files/:n", wrap(async (req, res) => {
  const job = await queue.getJob(req.params.id);
  const item = job?.data.items[Number(req.params.n)];
  const file = item?.file && path.resolve(item.file);
  if (!item || item.status !== "done" || !file.startsWith(DATA + path.sep))
    return res.status(404).json({ error: "File tidak tersedia" });
  res.download(file, item.downloadName);
}));

app.use((err, _req, res, _next) => {
  log("ERROR", err);
  res.status(500).json({ error: "Kesalahan server" });
});

app.listen(PORT, () => console.log(`API di http://localhost:${PORT}`));
