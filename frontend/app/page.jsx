"use client";
import { useEffect, useRef, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL || (typeof window !== "undefined" ? `${window.location.protocol}//${window.location.hostname}:4000` : "http://localhost:4000");
const uid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const MAX_CLIPS = 10, MAX_SEC = 600;

const fmt = (s) => {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(x)}` : `${m}:${p(x)}`;
};
const parse = (v) => {
  const parts = String(v).trim().split(":").map(Number);
  if (!parts.length || parts.length > 3 || parts.some((n) => !Number.isFinite(n) || n < 0)) return NaN;
  return parts.reduce((a, n) => a * 60 + n, 0);
};
const videoId = (input) => {
  try {
    const u = new URL(input);
    const h = u.hostname.replace(/^(www|m)\./, "");
    const id = h === "youtu.be" ? u.pathname.slice(1) : h === "youtube.com" ? u.searchParams.get("v") || u.pathname.match(/^\/(?:live|shorts|embed)\/([\w-]{11})/)?.[1] : null;
    return /^[\w-]{11}$/.test(id || "") ? id : null;
  } catch { return null; }
};
const whenYT = (cb) => {
  if (window.YT?.Player) return cb();
  window.onYouTubeIframeAPIReady = cb;
  if (!document.getElementById("yt-api")) {
    const s = document.createElement("script");
    s.id = "yt-api"; s.src = "https://www.youtube.com/iframe_api";
    document.body.appendChild(s);
  }
};

function Progress({ it }) {
  if (it.status !== "running") return <span className="meta">Menunggu antrean</span>;
  const p = it.progress || {};
  const pct = typeof p.pct === "number" ? Math.min(100, Math.floor(p.pct)) : null;
  return (
    <span className="prog">
      <span className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
        <i className={pct === null ? "indet" : ""} style={pct === null ? undefined : { width: `${pct}%` }} />
      </span>
      <span className="meta">
        {p.stage || "Menyiapkan"}{pct !== null ? ` ${pct}%` : ""}{p.speed ? ` · ${p.speed}` : ""}{p.eta ? ` · sisa ${p.eta}` : ""} · {fmt(it.elapsed || 0)}
      </span>
    </span>
  );
}

export default function Page() {
  const [url, setUrl] = useState("");
  const [vid, setVid] = useState(null);
  const [duration, setDuration] = useState(0);
  const [start, setStart] = useState("0:00");
  const [end, setEnd] = useState("0:30");
  const [name, setName] = useState("");
  const [clips, setClips] = useState([]);
  const [format, setFormat] = useState("mp4");
  const [job, setJob] = useState(null);
  const [playerLive, setPlayerLive] = useState(false); // tebakan dari player (cadangan)
  const [info, setInfo] = useState(null);              // status live akurat dari server (yt-dlp)
  const [liveMode, setLiveMode] = useState("record");
  const [error, setError] = useState("");
  const box = useRef(null), player = useRef(null), timer = useRef(null), pollTimer = useRef(null);

  // Status live: utamakan hasil server. Tebakan dari durasi player (d === 0) dihapus
  // karena getDuration() bernilai 0 sebelum metadata termuat, sehingga replay salah dianggap live.
  const live = info ? info.liveStatus === "is_live" : playerLive;
  const dur = duration || info?.duration || 0;

  useEffect(() => () => clearTimeout(pollTimer.current), []);

  // Ambil status live dari server begitu video dimuat
  useEffect(() => {
    if (!vid) return;
    let dead = false;
    setInfo(null);
    fetch(`${API}/api/info?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${vid}`)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!dead && d?.liveStatus) setInfo(d); })
      .catch(() => {}); // gagal -> pakai tebakan player
    return () => { dead = true; };
  }, [vid]);

  useEffect(() => {
    if (!vid) return;
    let p, dead = false;
    whenYT(() => {
      if (dead) return;
      const el = document.createElement("div");
      box.current.appendChild(el);
      const sync = () => {
        const d = p.getDuration?.();
        if (d > 0) setDuration(d);
      };
      p = new window.YT.Player(el, {
        videoId: vid, playerVars: { rel: 0 },
        events: {
          onReady: () => { sync(); setPlayerLive(!!p.getVideoData?.().isLive); },
          onStateChange: sync, // metadata biasanya baru tersedia setelah video mulai diputar
        },
      });
      player.current = p;
    });
    return () => { dead = true; clearInterval(timer.current); p?.destroy?.(); if (box.current) box.current.innerHTML = ""; };
  }, [vid]);

  function load() {
    const id = videoId(url);
    if (!id) return setError("URL YouTube tidak valid");
    clearTimeout(pollTimer.current);
    setError(""); setClips([]); setJob(null); setDuration(0); setPlayerLive(false); setInfo(null); setVid(id);
  }

  const fromPlayer = (set) => () => player.current && set(fmt(player.current.getCurrentTime()));

  function preview(c) {
    const p = player.current;
    if (!p) return;
    clearInterval(timer.current);
    p.seekTo(c.start, true); p.playVideo();
    timer.current = setInterval(() => {
      if (p.getCurrentTime() >= c.end) { p.pauseVideo(); clearInterval(timer.current); }
    }, 200);
  }

  function addClip() {
    const record = live && liveMode === "record";
    const s = record ? 0 : parse(start), e = parse(end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) return setError("Format waktu: mm:ss atau jj:mm:ss");
    if (e <= s) return setError("Waktu akhir harus setelah waktu awal");
    if (e - s > MAX_SEC) return setError(`Maksimal ${MAX_SEC / 60} menit per clip`);
    if (clips.length >= MAX_CLIPS) return setError(`Maksimal ${MAX_CLIPS} clip`);
    setError("");
    setClips([...clips, { id: uid(), mode: !live ? "vod" : record ? "record" : "past", start: s, end: e, name: name.trim() || `clip-${clips.length + 1}` }]);
    setName("");
  }

  async function download() {
    setError(""); setJob({ status: "queued", items: [] });
    clearTimeout(pollTimer.current);
    try {
      const r = await fetch(`${API}/api/jobs`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, format, clips: clips.map(({ start, end, name, mode }) => ({ start, end, name, mode })) }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Gagal membuat job");

      // Polling tahan error: gagal sesaat dicoba ulang, gagal berturut-turut dihentikan dengan pesan jelas
      let fails = 0;
      const poll = async () => {
        try {
          const res = await fetch(`${API}/api/jobs/${d.id}`);
          const s = await res.json();
          if (!res.ok) throw new Error(s.error || "Gagal membaca status job");
          fails = 0;
          setJob({ ...s, items: s.items || [] });
          if (s.status === "queued" || s.status === "running") pollTimer.current = setTimeout(poll, 1500);
        } catch (e) {
          if (++fails < 5) pollTimer.current = setTimeout(poll, 3000);
          else { setJob(null); setError(`Koneksi ke server terputus: ${e.message}`); }
        }
      };
      poll();
    } catch (e) { setJob(null); setError(e.message); }
  }

  const busy = job && (job.status === "queued" || job.status === "running");

  return (
    <main>
      <h1>YT Clipper</h1>
      <p className="sub">Tempel link video, tandai bagian yang ingin diambil, lihat preview-nya, lalu unduh semua clip.</p>

      <div className="row">
        <label style={{ flex: "1 1 320px" }}>Link video YouTube
          <input className="url" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && load()} placeholder="https://www.youtube.com/watch?v=..." />
        </label>
        <button onClick={load}>Muat video</button>
      </div>
      {error && <p className="err" role="alert">{error}</p>}

      {vid && (
        <section className="panel">
          <div className="player" ref={box} />
          <div className="timeline" aria-label="Posisi clip pada video">
            {dur > 0 && clips.map((c) => (
              <i key={c.id} style={{ left: `${(c.start / dur) * 100}%`, width: `${Math.max(((c.end - c.start) / dur) * 100, 0.6)}%` }} />
            ))}
          </div>

          {info?.liveStatus === "post_live" && (
            <p className="sub" style={{ marginTop: 12 }}>
              Replay ini baru selesai live dan masih diproses YouTube. Pemotongan bisa lambat atau gagal; jika macet, coba lagi beberapa jam kemudian.
            </p>
          )}
          {info?.liveStatus === "is_upcoming" && (
            <p className="sub" style={{ marginTop: 12 }}>Live ini belum dimulai, jadi belum bisa di-clip.</p>
          )}

          <div className="row" style={{ marginTop: 16 }}>
            {live && (
              <label>Mode live
                <select value={liveMode} onChange={(e) => setLiveMode(e.target.value)}>
                  <option value="record">Rekam ke depan</option>
                  <option value="past">Ambil dari awal live</option>
                </select>
              </label>
            )}
            {live && liveMode === "record" ? (
              <label>Durasi rekam<input className="time" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
            ) : (
              <>
                <label>Mulai<input className="time" value={start} onChange={(e) => setStart(e.target.value)} /></label>
                {!live && <button className="ghost" onClick={fromPlayer(setStart)}>Ambil dari player</button>}
                <label>Selesai<input className="time" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
                {!live && <button className="ghost" onClick={fromPlayer(setEnd)}>Ambil dari player</button>}
              </>
            )}
            <label>Nama clip<input value={name} onChange={(e) => setName(e.target.value)} placeholder={`clip-${clips.length + 1}`} /></label>
            <button onClick={addClip}>Tambah clip</button>
          </div>

          {live && (
            <p className="sub" style={{ marginTop: 12 }}>
              {liveMode === "record"
                ? "Video ini sedang live. Rekaman dimulai saat job dijalankan dan berlangsung selama durasi yang Anda isi."
                : "Isi waktu mulai dan selesai sejak live dimulai. Bagian itu harus masih tersedia di YouTube."}
            </p>
          )}
          {clips.length === 0 ? (
            <p className="sub" style={{ marginTop: 16 }}>Belum ada clip. Atur waktu mulai dan selesai, lalu pilih Tambah clip.</p>
          ) : (
            <>
              <ul className="clips">
                {clips.map((c) => (
                  <li key={c.id}>
                    <span><strong>{c.name}</strong> <span className="meta">{c.mode === "record" ? `rekam ${fmt(c.end)} ke depan` : `${fmt(c.start)} – ${fmt(c.end)} (${fmt(c.end - c.start)})${c.mode === "past" ? " sejak live mulai" : ""}`}</span></span>
                    <span className="row">
                      {c.mode === "vod" && <button className="ghost" onClick={() => preview(c)}>Preview</button>}
                      <button className="ghost" onClick={() => setClips(clips.filter((x) => x.id !== c.id))}>Hapus</button>
                    </span>
                  </li>
                ))}
              </ul>
              <div className="row" style={{ marginTop: 16 }}>
                <label>Format
                  <select value={format} onChange={(e) => setFormat(e.target.value)}>
                    <option value="mp4">MP4 (video, maks 720p)</option>
                    <option value="mp3">MP3 (audio)</option>
                  </select>
                </label>
                <button onClick={download} disabled={busy}>{busy ? "Memproses…" : `Unduh ${clips.length} clip`}</button>
              </div>
            </>
          )}

          {job && job.items?.length > 0 && (
            <ul className="clips">
              {job.items.map((it, i) => (
                <li key={i}>
                  <strong>{it.name}</strong>
                  {it.status === "done" ? <a className="ok" href={`${API}${it.href}`}>Simpan file</a>
                    : it.status === "error" ? <span className="err">Gagal: {it.error}</span>
                    : <Progress it={it} />}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
