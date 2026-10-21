import { Worker } from "bullmq";
import { spawn } from "node:child_process";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { QUEUE, DATA, TTL_SEC, redis, hms, log } from "./shared.js";

// Opsi baru (env, semuanya opsional)
const DEBUG = process.env.DEBUG_YTDLP === "1";                 // log semua output yt-dlp
const FORCE_KEYFRAMES = process.env.FORCE_KEYFRAMES === "1";   // potong akurat (re-encode, JAUH lebih lambat)
const CLIP_TIMEOUT_SEC = Number(process.env.CLIP_TIMEOUT_SEC || 300); // batas waktu vod/past

// Proses yang sedang berjalan, supaya bisa dimatikan saat worker dihentikan
const active = new Set();

// Matikan proses beserta anak-anaknya (yt-dlp -> ffmpeg).
// Di Windows p.kill() hanya mematikan yt-dlp; ffmpeg tetap hidup dan menahan pipe.
const killTree = (p) => {
  if (!p.pid) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-p.pid, "SIGKILL"); // grup proses (spawn memakai detached)
  } catch {
    try { p.kill("SIGKILL"); } catch {}
  }
};

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    for (const p of active) killTree(p);
    setTimeout(() => process.exit(0), 500);
  });
}

// Jalankan proses; onLine dipanggil untuk tiap baris stdout/stderr (yt-dlp memakai \r untuk progress)
const run = (cmd, args, timeoutMs, onLine) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, detached: process.platform !== "win32" }); // args array, tanpa shell
    active.add(p);
    let tail = "", errLine = "", done = false, t, grace;

    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      clearTimeout(grace);
      active.delete(p);
      fn(v);
    };

    // Timeout: matikan seluruh pohon proses dan LANGSUNG reject.
    // Jangan menunggu event 'close' karena bisa tidak pernah datang bila ffmpeg masih memegang pipe.
    t = setTimeout(() => {
      killTree(p);
      finish(reject, new Error("Proses melebihi batas waktu"));
    }, timeoutMs);

    const feed = (stream, isErr) => {
      let buf = "";
      stream.on("data", (d) => {
        buf += d;
        const lines = buf.split(/[\r\n]+/);
        buf = lines.pop();
        if (isErr) tail = (tail + d).slice(-400);
        for (const l of lines) {
          if (!l.trim()) continue;
          if (/^ERROR/i.test(l)) errLine = l;
          onLine?.(l);
        }
      });
    };
    feed(p.stdout, false);
    feed(p.stderr, true);

    p.on("error", () => finish(reject, new Error(`${cmd} tidak ditemukan di server`)));

    const end = (c) =>
      c === 0 ? finish(resolve) : finish(reject, new Error(errLine || tail.slice(-300) || `${cmd} gagal (${c})`));

    // 'exit' = proses utama selesai. Beri waktu 5 dtk agar 'close' datang; jika pipe ditahan proses anak, tetap selesai.
    p.on("exit", (c) => { grace = setTimeout(() => end(c), 5000); });
    p.on("close", (c) => end(c));
  });

// vod: video biasa/VOD live | past: live berjalan, dari awal live | record: rekam ke depan
function ytArgs(item, format, out) {
  // Peringatan sengaja TIDAK disembunyikan (mis. "No supported JavaScript runtime") agar masalah terlihat di log.
  const a = ["--no-playlist", "--newline", "-o", out];
  const len = Math.ceil(item.end - item.start);
  if (item.mode === "record") {
    a.push("--downloader", "ffmpeg", "--downloader-args", `ffmpeg:-t ${len}`);
  } else {
    if (item.mode === "past") a.push("--live-from-start");
    a.push("--download-sections", `*${hms(item.start)}-${hms(item.end)}`);
    // Re-encode di titik potong sangat lambat dan tanpa progres; aktifkan hanya jika perlu presisi frame.
    if (FORCE_KEYFRAMES) a.push("--force-keyframes-at-cuts");
  }
  // Format HLS (m3u8) didahulukan: lompat ke menit tertentu hanya mengambil segmen yang dibutuhkan
  // (uji manual: klip 61 dtk selesai ~9 dtk). Format https langsung lewat ffmpeg memberi 403/macet pada video uji.
  if (format === "mp3") {
    if (item.mode !== "record") a.push("-f", "ba[protocol^=m3u8]/ba/b");
    a.push("-x", "--audio-format", "mp3");
  } else if (item.mode === "record") a.push("-f", "b[height<=720]/bv*[height<=720]+ba", "--remux-video", "mp4");
  else {
    a.push(
      "-f",
      "bv*[height<=720][protocol^=m3u8][vcodec^=avc1]+ba[protocol^=m3u8]" +
        "/bv*[height<=720][protocol^=m3u8]+ba[protocol^=m3u8]" +
        "/bv*[height<=720][ext=mp4][vcodec^=avc1]+ba[ext=m4a]" +
        "/bv*[height<=720]+ba/b[height<=720]",
      "--merge-output-format", "mp4",
    );
  }
  return a;
}

async function handle(job) {
  const { url, format, items } = job.data;
  const dir = path.join(DATA, String(job.id));
  await mkdir(dir, { recursive: true });
  const save = () => job.updateData({ url, format, items });
  log(`job ${job.id} mulai: ${items.length} clip, format ${format}`);

  for (const [i, item] of items.entries()) {
    const tag = `job ${job.id.slice(0, 8)} clip ${i + 1}/${items.length}`;
    const len = item.end - item.start;
    const started = Date.now();
    let lastSave = 0, lastLogged = -1, ticker = null;
    item.status = "running";
    item.startedAt = started;
    item.progress = { stage: "Menyiapkan", pct: item.mode === "record" ? 0 : null };
    await save();

    const set = (patch) => {
      Object.assign(item.progress, patch);
      const now = Date.now();
      if (now - lastSave > 1000) { lastSave = now; save().catch(() => {}); }
      const pct = Math.floor((item.progress.pct ?? 0) / 25) * 25;
      if (item.progress.pct != null && pct > lastLogged) { lastLogged = pct; log(`${tag}: ${item.progress.stage} ${Math.floor(item.progress.pct)}%`); }
    };

    const onLine = (line) => {
      // Selalu catat peringatan/error; output lain hanya bila DEBUG_YTDLP=1
      if (DEBUG || /^(WARNING|ERROR)/i.test(line)) log(`${tag}> ${line}`);

      const processing = /\[(Merger|VideoRemuxer|ExtractAudio|FixupM3u8|ffmpeg)\]/i.test(line);
      if (item.mode === "record") { if (processing) set({ stage: "Memproses file", pct: 99 }); return; }
      let m;
      if ((m = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/))) {
        set({
          stage: "Mengunduh",
          pct: Math.min(99, Math.max(item.progress.pct ?? 0, Number(m[1]))), // tidak mundur
          speed: line.match(/at\s+(\S+\/s)/)?.[1],
          eta: line.match(/ETA\s+(\S+)/)?.[1],
        });
      } else if ((m = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/))) {
        const sec = +m[1] * 3600 + +m[2] * 60 + +m[3];
        const sp = line.match(/speed=\s*([\d.]+)x/)?.[1];
        set({ stage: "Mengunduh", pct: Math.min(99, Math.max(item.progress.pct ?? 0, (sec / len) * 100)), speed: sp && `${sp}x` });
      } else if (processing) set({ stage: "Memproses file" });
      else if (/\[(youtube|info)\]/i.test(line)) set({ stage: "Mengambil info video" });
    };

    try {
      if (item.mode === "record") {
        ticker = setInterval(() => {
          if (item.progress.stage !== "Memproses file")
            set({ stage: "Merekam live", pct: Math.min(98, ((Date.now() - started) / 1000 / len) * 100) });
        }, 1000);
      }
      const args = [...ytArgs(item, format, path.join(dir, `${i}.%(ext)s`)), url];
      log(`${tag}: mulai mode=${item.mode} ${hms(item.start)}-${hms(item.end)}`);
      log(`${tag}: $ yt-dlp ${args.join(" ")}`);
      await run("yt-dlp", args, (item.mode === "record" ? len + 180 : CLIP_TIMEOUT_SEC) * 1000, onLine);

      const file = (await readdir(dir)).find((f) => f.startsWith(`${i}.`) && !f.endsWith(".part") && !f.endsWith(".ytdl"));
      if (!file) throw new Error("File hasil tidak ditemukan");
      item.file = path.join(dir, file);
      item.downloadName = `${item.name}.${file.split(".").pop()}`;
      item.status = "done";
      item.progress = { stage: "Selesai", pct: 100 };
      const mb = ((await stat(item.file)).size / 1048576).toFixed(1);
      log(`${tag}: selesai ${mb} MB dalam ${Math.round((Date.now() - started) / 1000)} dtk`);
    } catch (e) {
      item.status = "error";
      item.error = e.message;
      log(`${tag}: GAGAL - ${e.message}`);
    } finally {
      clearInterval(ticker);
    }
    await save();
  }

  const ok = items.filter((x) => x.status === "done").length;
  log(`job ${job.id} selesai: ${ok}/${items.length} clip berhasil`);
  if (ok === 0) throw new Error(items[0].error);
  return "done";
}

const worker = new Worker(QUEUE, handle, {
  connection: redis(),
  concurrency: Number(process.env.WORKER_CONCURRENCY || 2),
});
worker.on("failed", (j, e) => log(`job ${j?.id} gagal: ${e.message}`));

// hapus folder hasil yang lebih tua dari TTL
setInterval(async () => {
  try {
    for (const d of await readdir(DATA)) {
      const p = path.join(DATA, d);
      if (Date.now() - (await stat(p)).mtimeMs > TTL_SEC * 1000) {
        await rm(p, { recursive: true, force: true });
        log(`hapus hasil lama: ${d}`);
      }
    }
  } catch {}
}, 60_000);

log(`Worker siap (concurrency ${process.env.WORKER_CONCURRENCY || 2}, timeout ${CLIP_TIMEOUT_SEC}s, keyframes ${FORCE_KEYFRAMES ? "ON" : "off"}, debug ${DEBUG ? "ON" : "off"})`);
