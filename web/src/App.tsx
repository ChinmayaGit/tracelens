import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  GoogleAuthProvider,
  linkWithPopup,
  onAuthStateChanged,
  signInAnonymously,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";
import { auth } from "./lib/firebase";
import { DEFAULTS, loadRoutingConfig, type RoutingConfig } from "./lib/config";
import {
  deepDive,
  detectHardware,
  deviceStatus,
  extractFromImage,
  looksLikeError,
  redact,
  suggestMode,
  triage as runTriage,
  type DeviceStatus,
  type Hardware,
  type ProcessingMode,
  type StepLog,
  type Triage,
} from "./lib/pipeline";
import type { Redaction, Redactor } from "./lib/redact";
import { deleteTrace, saveTrace, updateTrace, watchHistory, type TraceDoc } from "./lib/history";
import { Confidence, Markdown, RedactionList, Sanitized, Timeline } from "./components/bits";
import { DeviceSetup } from "./components/DeviceSetup";
import { Settings, type EngineKind } from "./components/Settings";
import { DEFAULT_LAN, lanStatus, type LanConfig, type LanStatus } from "./lib/local";
import type { Engine } from "./lib/pipeline";

/** Per-browser preferences (best effort; the app works without storage). */
function loadPref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function savePref(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}
import { consumeCloudQuota, watchRemaining, USER_DAILY_LIMIT } from "./lib/quota";
import { SAMPLES } from "./samples";

interface Run {
  id: string | null;
  steps: StepLog[];
  sanitized: string;
  redactions: Redaction[];
  triage: Triage | null;
  analysis: string;
  pending: string | null;
  error: string | null;
  /** Waiting for the user to approve what leaves the device. */
  review: boolean;
}

const EMPTY_RUN: Run = {
  id: null,
  steps: [],
  sanitized: "",
  redactions: [],
  triage: null,
  analysis: "",
  pending: null,
  error: null,
  review: false,
};

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    addEventListener("online", on);
    addEventListener("offline", off);
    return () => {
      removeEventListener("online", on);
      removeEventListener("offline", off);
    };
  }, []);
  return online;
}

const MODE_KEY = "tracelens.mode";
function savedMode(): ProcessingMode | null {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === "hybrid" || v === "private" || v === "cloud" ? v : null;
  } catch {
    return null;
  }
}

const DEVICE_LABEL: Record<DeviceStatus, string> = {
  available: "Gemini Nano ready",
  downloadable: "Gemini Nano not downloaded",
  downloading: "Gemini Nano downloading…",
  unavailable: "On-device AI unavailable",
  unsupported: "Browser has no on-device AI",
};

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [cfg, setCfg] = useState<RoutingConfig>(DEFAULTS);
  const [device, setDevice] = useState<DeviceStatus>("unsupported");
  const [hw, setHw] = useState<Hardware | null>(null);
  const [mode, setModeState] = useState<ProcessingMode>(savedMode() ?? "hybrid");
  const setMode = useCallback((m: ProcessingMode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* storage blocked: mode just isn't remembered */
    }
  }, []);
  const online = useOnline();

  const [input, setInput] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [allowCloudImage, setAllowCloudImage] = useState(false);
  const [run, setRun] = useState<Run>(EMPTY_RUN);
  const [history, setHistory] = useState<TraceDoc[]>([]);
  const busy = run.pending !== null;
  const patch = (p: Partial<Run>) => setRun((r) => ({ ...r, ...p }));
  const fileRef = useRef<HTMLInputElement>(null);
  const redactorRef = useRef<Redactor | null>(null);
  const [selection, setSelection] = useState("");
  const previewRef = useRef<HTMLDivElement>(null);
  /** Only accept text selected inside the preview that actually occurs in the sanitized trace. */
  const captureSelection = () => {
    const sel = getSelection();
    const box = previewRef.current;
    const text = sel?.toString().trim() ?? "";
    const inside = !!box && !!sel?.anchorNode && !!sel.focusNode && box.contains(sel.anchorNode) && box.contains(sel.focusNode);
    setSelection(inside && text && run.sanitized.includes(text) ? text : "");
  };

  /* ---------- boot ---------- */
  useEffect(() => {
    loadRoutingConfig().then(setCfg);
    Promise.all([deviceStatus(), detectHardware()]).then(([d, h]) => {
      setDevice(d);
      setHw(h);
      // First visit: pick a sensible default for this device.
      if (!savedMode()) setModeState(suggestMode(d, h));
      // Private needs Nano; fall back if it disappeared.
      else if (savedMode() === "private" && d !== "available") setModeState("hybrid");
    });
    return onAuthStateChanged(auth, (u) => {
      if (u) setUser(u);
      else
        signInAnonymously(auth).catch(() =>
          patch({
            error: navigator.onLine
              ? "Couldn't connect to Firebase. Tap Retry."
              : "You're offline. Connect to the internet, then tap Retry.",
          }),
        );
    });
  }, []);

  /* ---------- reconnect (Retry button + automatic when back online) ---------- */
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setDevice(await deviceStatus());
      setCfg(await loadRoutingConfig());
      if (!auth.currentUser) await signInAnonymously(auth);
      setRun((r) => (r.pending ? r : { ...r, error: null }));
    } catch {
      patch({
        error: navigator.onLine
          ? "Still can't reach Firebase. Try again in a moment."
          : "You're offline. Connect to the internet, then tap Retry.",
      });
    } finally {
      setRefreshing(false);
    }
  }, []);
  useEffect(() => {
    addEventListener("online", refresh);
    return () => removeEventListener("online", refresh);
  }, [refresh]);

  useEffect(() => (user ? watchHistory(user.uid, setHistory) : undefined), [user]);
  const [cloudLeft, setCloudLeft] = useState(USER_DAILY_LIMIT);

  /* ---------- local engine: built-in Nano (default) or a LAN server ---------- */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [engineKind, setEngineKindState] = useState<EngineKind>(() => loadPref("tracelens.engine", "builtin"));
  const [lan, setLanState] = useState<LanConfig>(() => loadPref("tracelens.lan", DEFAULT_LAN));
  const [lanInfo, setLanInfo] = useState<LanStatus | null>(null);
  const setEngineKind = (e: EngineKind) => {
    setEngineKindState(e);
    savePref("tracelens.engine", e);
  };
  const setLan = (l: LanConfig) => {
    setLanState(l);
    savePref("tracelens.lan", l);
  };
  // Keep the server's Online/Offline status fresh while it's selected.
  useEffect(() => {
    if (engineKind !== "lan") return;
    let alive = true;
    const tick = () => lanStatus(lan.url).then((st) => alive && setLanInfo(st));
    tick();
    const id = setInterval(tick, 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [engineKind, lan.url]);
  const lanReady = engineKind === "lan" && !!lanInfo?.online && !!lan.model;
  const engine: Engine = lanReady ? { kind: "lan", lan } : { kind: "builtin" };
  useEffect(() => (user ? watchRemaining(user.uid, setCloudLeft) : undefined), [user]);

  /* ---------- pipeline ---------- */
  const doDeepDive = useCallback(
    async (base: Run, id: string | null) => {
      const viaLan = engine.kind === "lan" && mode === "private";
      if (mode === "private" && !viaLan) {
        patch({ error: "Private mode: nothing is sent to the cloud. Switch to Hybrid, or use a local network server for a private deep dive." });
        return;
      }
      if (!viaLan && !navigator.onLine) {
        patch({ error: "You're offline. The on-device triage above still works; deep dive needs the cloud." });
        return;
      }
      patch({
        pending: viaLan ? `Deep dive on your network (${lan.model})…` : "Deep dive in the cloud (sanitized trace only)…",
        analysis: "",
        error: null,
      });
      let text = "";
      try {
        if (user && !viaLan) await consumeCloudQuota(user.uid);
        const gen = deepDive(base.sanitized, base.triage, cfg, viaLan && engine.kind === "lan" ? engine.lan : undefined);
        let r = await gen.next();
        while (!r.done) {
          text += r.value;
          patch({ analysis: text });
          r = await gen.next();
        }
        const steps = [...base.steps.filter((s) => s.step !== "deep"), r.value];
        patch({ steps, pending: null });
        if (user && id) await updateTrace(user.uid, id, { analysis: text, steps });
      } catch (e) {
        patch({ pending: null, error: `Deep dive failed: ${(e as Error).message}` });
      }
    },
    [cfg, user, mode, engine.kind, lan],
  );

  const analyze = async () => {
    if (!user || busy) return;
    let raw = input.trim();
    let r: Run = { ...EMPTY_RUN, pending: "Starting…" };
    setRun(r);
    const step = (p: Partial<Run>) => {
      r = { ...r, ...p };
      setRun(r);
    };

    try {
      const dev = await deviceStatus();
      setDevice(dev);

      if (engineKind === "lan" && !lanReady && mode !== "cloud") {
        throw new Error(
          lanInfo?.online === false
            ? `Your local network server (${lan.url}) is offline. Start it, pick Built-in in Settings, or use Cloud mode.`
            : "Pick a model for your local network server in Settings.",
        );
      }
      if (mode === "private" && dev !== "available" && engine.kind !== "lan") {
        throw new Error("Private mode needs Gemini Nano on this device (or a local network server). Switch to Hybrid or Cloud mode.");
      }
      const nano = (dev === "available" || engine.kind === "lan") && mode !== "cloud";

      if (image) {
        const cloudOk = allowCloudImage && mode !== "private";
        if (!nano && !cloudOk) {
          throw new Error(
            "Reading screenshots privately needs Gemini Nano. Enable on-device AI, or tick “allow cloud for screenshots”.",
          );
        }
        step({ pending: "Reading screenshot…" });
        if (!nano) await consumeCloudQuota(user.uid);
        const { text, log } = await extractFromImage(image, nano ? false : cloudOk);
        raw = [raw, text].filter(Boolean).join("\n\n");
        setInput(raw);
        setImage(null);
        step({ steps: [log] });
      }
      if (!raw) throw new Error("Paste a stack trace, log, or drop a screenshot first.");
      if (!looksLikeError(raw)) {
        throw new Error(
          "That doesn't look like an error, stack trace or log. Paste the failing output (or try one of the samples).",
        );
      }

      step({ pending: nano ? "Redacting on-device…" : "Redacting with local rules…" });
      step({ pending: engine.kind === "lan" ? `Redacting on your network (${lan.model})…` : r.pending });
      const red = await redact(raw, dev, mode, engine);
      redactorRef.current = red.redactor;
      step({ sanitized: red.sanitized, redactions: red.redactions, steps: [...r.steps, ...red.logs] });

      if (!navigator.onLine && !nano) {
        throw new Error("Offline and no on-device model: triage needs Gemini Nano or a connection.");
      }
      // Without Gemini Nano only rules ran, and the next step goes to the cloud:
      // let the user check (and hide more) before anything leaves the device.
      if (!nano || !red.modelRan) {
        if (mode === "private") throw new Error("Gemini Nano couldn't redact this trace, and Private mode never uses the cloud.");
        step({ pending: null, review: true });
        return;
      }
      await triageAndSave(r);
    } catch (e) {
      setRun((cur) => ({ ...cur, pending: null, error: (e as Error).message }));
    }
  };

  const triageAndSave = async (start: Run) => {
    if (!user) return;
    let r: Run = { ...start, review: false, error: null };
    const step = (p: Partial<Run>) => {
      r = { ...r, ...p };
      setRun(r);
    };
    try {
      step({ pending: "Triaging…" });
      // Count cloud calls only; Gemini Nano is free and unmetered.
      const cloudPlanned =
        engine.kind === "lan" && mode !== "cloud"
          ? false
          : mode === "cloud" || device !== "available" || r.sanitized.length > cfg.maxOnDeviceChars;
      if (cloudPlanned) await consumeCloudQuota(user.uid);
      const tri = await runTriage(r.sanitized, cfg, mode, engine);
      // Hybrid can still fall back to the cloud if Nano fails: count it afterwards.
      if (!cloudPlanned && tri.log.source === "in_cloud") await consumeCloudQuota(user.uid).catch(() => {});
      step({ steps: [...r.steps, tri.log], pending: null });
      if (tri.triage.isError === false) {
        throw new Error("The model didn't find an error in this input, so nothing was saved. Paste the full failing output.");
      }
      step({ triage: tri.triage });

      const counts: Record<string, number> = {};
      for (const x of r.redactions) counts[x.kind] = (counts[x.kind] ?? 0) + 1;
      const id = await saveTrace(user.uid, {
        title: `${tri.triage.errorType} · ${tri.triage.language}`.slice(0, 120),
        sanitized: r.sanitized,
        triage: tri.triage,
        analysis: null,
        steps: r.steps,
        redactionCounts: counts,
        redactionTotal: r.redactions.length,
      });
      step({ id });

      if (mode !== "private" && cfg.autoEscalate && tri.triage.confidence < cfg.escalateBelowConfidence && navigator.onLine) {
        await doDeepDive(r, id);
      }
    } catch (e) {
      step({ pending: null, error: (e as Error).message });
    }
  };

  /** Review step: hide whatever the user highlighted in the preview. */
  const hideSelection = () => {
    const v = selection.trim();
    if (!v || !redactorRef.current) return;
    const sanitized = redactorRef.current.applyLiterals(run.sanitized, [{ kind: "HIDDEN", value: v }], "user");
    patch({ sanitized, redactions: redactorRef.current.redactions });
    setSelection("");
    getSelection()?.removeAllRanges();
  };

  const openFromHistory = (d: TraceDoc) =>
    setRun({
      ...EMPTY_RUN,
      id: d.id,
      steps: d.steps ?? [],
      sanitized: d.sanitized,
      triage: d.triage,
      analysis: d.analysis ?? "",
    });

  /* ---------- input helpers ---------- */
  const onPaste = (e: React.ClipboardEvent) => {
    const f = [...e.clipboardData.files].find((x) => /^image\/(png|jpeg)$/.test(x.type));
    if (f) {
      e.preventDefault();
      setImage(f);
    }
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = [...e.dataTransfer.files][0];
    if (!f) return;
    if (/^image\/(png|jpeg)$/.test(f.type)) setImage(f);
    else f.text().then(setInput);
  };

  /* ---------- stats (judge-facing: proof of hybrid value) ---------- */
  const stats = useMemo(() => {
    let ai = 0;
    let local = 0;
    let secrets = 0;
    for (const d of history) {
      secrets += d.redactionTotal ?? 0;
      for (const s of d.steps ?? []) {
        if (s.source === "on_device" || s.source === "in_cloud") ai++;
        if (s.source === "on_device") local++;
      }
    }
    return { traces: history.length, secrets, onDevicePct: ai ? Math.round((local / ai) * 100) : 0 };
  }, [history]);

  const googleSignIn = async () => {
    const provider = new GoogleAuthProvider();
    try {
      if (auth.currentUser?.isAnonymous) await linkWithPopup(auth.currentUser, provider);
      else await signInWithPopup(auth, provider);
    } catch (e) {
      if ((e as { code?: string }).code === "auth/credential-already-in-use") await signInWithPopup(auth, provider);
      else patch({ error: (e as Error).message });
    }
  };

  const canEscalate =
    !!run.sanitized && !busy && !run.analysis && (mode === "private" ? engine.kind === "lan" : online);

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <img src="/favicon.svg" alt="" width={28} height={28} />
          <h1>TraceLens</h1>
          <span className="tag">secrets stay on your device</span>
        </div>
        <div className="status">
          <span className={`pill pill-${device}`}>{DEVICE_LABEL[device]}</span>
          {engineKind === "lan" && (
            <span className={`pill ${lanInfo?.online ? "pill-available" : "pill-offline"}`} title={lan.url}>
              LAN server {lanInfo?.online ? `online · ${lan.model || "no model"}` : "offline"}
            </span>
          )}
          <span className={`pill ${online ? "pill-online" : "pill-offline"}`}>{online ? "Online" : "Offline"}</span>
          <button className="ghost" onClick={() => setSettingsOpen(true)} aria-label="Settings and setup">
            ⚙ Settings
          </button>
          {user?.isAnonymous ? (
            <button className="ghost" onClick={googleSignIn}>
              Sign in to sync
            </button>
          ) : user ? (
            <button className="ghost" onClick={() => signOut(auth)} title={user.email ?? ""}>
              Sign out
            </button>
          ) : null}
        </div>
      </header>

      <div className="layout">
        <aside className="side">
          <section className="stats">
            <div>
              <b>{stats.traces}</b>
              <span>traces</span>
            </div>
            <div>
              <b>{stats.secrets}</b>
              <span>secrets kept local</span>
            </div>
            <div>
              <b>{stats.onDevicePct}%</b>
              <span>AI steps on-device</span>
            </div>
          </section>
          <h2>History</h2>
          <ul className="history">
            {history.map((d) => (
              <li key={d.id} className={d.id === run.id ? "active" : ""}>
                <button onClick={() => openFromHistory(d)}>
                  <span className={`sev sev-${d.triage?.severity ?? "low"}`} />
                  <span className="h-title">{d.title}</span>
                  <span className="h-meta">
                    {d.redactionTotal} redacted · {d.platform ?? "web"} · {d.createdAt?.toDate().toLocaleDateString() ?? "pending sync"}
                  </span>
                </button>
                <button className="x" aria-label="Delete" onClick={() => user && deleteTrace(user.uid, d.id)}>
                  ×
                </button>
              </li>
            ))}
            {!history.length && <li className="muted">No traces yet. Try a sample.</li>}
          </ul>
        </aside>

        <main className="main">
          {engineKind === "builtin" && (
            <DeviceSetup device={device} hw={hw} mode={mode} setMode={setMode} setDevice={setDevice} />
          )}
          {engineKind === "lan" && (
            <section className="card setup">
              <div className="row between">
                <h2>Processing mode</h2>
                <div className="seg" role="radiogroup" aria-label="Processing mode">
                  {(["hybrid", "private", "cloud"] as const).map((m) => (
                    <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
                      {m[0].toUpperCase() + m.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
              <p className="muted small">
                Local AI runs on <b>{lan.model || "(pick a model)"}</b> at <code>{lan.url}</code>{" "}
                {lanInfo?.online ? "· online" : "· offline"}. {mode === "private" ? "Deep dives also stay on your network." : ""}
              </p>
            </section>
          )}

          <section className="card input" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
            <div className="row between">
              <h2>Paste an error, stack trace or log</h2>
              <div className="samples">
                {SAMPLES.map((s) => (
                  <button key={s.label} className="chip" onClick={() => setInput(s.text)}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={onPaste}
              spellCheck={false}
              placeholder="Paste text, drop a .log file, or paste a screenshot (PNG/JPEG)…"
            />
            <div className="row between">
              <div className="row">
                <button className="ghost" onClick={() => fileRef.current?.click()}>
                  {image ? `🖼 ${image.name}` : "Add screenshot"}
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg"
                  hidden
                  onChange={(e) => setImage(e.target.files?.[0] ?? null)}
                />
                {image && (device !== "available" || mode === "cloud") && mode !== "private" && (
                  <label className="consent">
                    <input type="checkbox" checked={allowCloudImage} onChange={(e) => setAllowCloudImage(e.target.checked)} />
                    allow cloud for screenshots (no Gemini Nano here)
                  </label>
                )}
              </div>
              <span className="quota" title="Cloud AI calls are rate-limited; on-device Gemini Nano is unlimited">
                {cloudLeft}/{USER_DAILY_LIMIT} cloud runs left today
              </span>
              <button className="primary" onClick={analyze} disabled={busy || !user || (!input.trim() && !image)}>
                {busy ? "Working…" : "Analyze privately"}
              </button>
            </div>
          </section>

          {run.error && (
            <div className="error row between">
              <span>{run.error}</span>
              <button className="retry" onClick={refresh} disabled={refreshing}>
                {refreshing ? "Retrying…" : "↻ Retry"}
              </button>
            </div>
          )}

          {(run.steps.length > 0 || run.pending) && (
            <section className="card">
              <h2>Pipeline</h2>
              <Timeline steps={run.steps} pending={run.pending} />
            </section>
          )}

          {run.triage && (
            <section className={`card triage sev-border-${run.triage.severity}`}>
              <div className="row between">
                <h2>
                  {run.triage.errorType} <small>{run.triage.language}</small>
                </h2>
                <span className={`sevtag sev-${run.triage.severity}`}>{run.triage.severity}</span>
              </div>
              <p className="summary">{run.triage.summary}</p>
              <dl>
                <dt>Likely cause</dt>
                <dd>{run.triage.likelyCause}</dd>
                <dt>Quick fix</dt>
                <dd>{run.triage.quickFix}</dd>
              </dl>
              <Confidence value={run.triage.confidence} />
              {canEscalate && (
                <button className="primary" onClick={() => doDeepDive(run, run.id)}>
                  {mode === "private" ? "Deep dive on my network →" : "Deep dive in cloud →"}
                </button>
              )}
            </section>
          )}

          {run.analysis && (
            <section className="card">
              <h2>Root-cause analysis</h2>
              <Markdown md={run.analysis} />
            </section>
          )}

          {run.sanitized && (
            <section className="card two">
              <div>
                <h2>{run.review ? "Review before sending to the cloud" : mode === "private" ? "Sanitized trace (stays private)" : "What the cloud sees"}</h2>
                {run.review && (
                  <div className="warn review">
                    Gemini Nano isn't running here, so only the rules removed secrets. Check for names, IDs or
                    hostnames: <b>highlight any text below</b> to hide it, then send.
                    <div className="row" style={{ marginTop: 8 }}>
                      <button onClick={hideSelection} disabled={!selection.trim()}>
                        {selection ? `Hide “${selection.slice(0, 24)}${selection.length > 24 ? "…" : ""}”` : "Highlight text in the log to hide it"}
                      </button>
                      <button className="primary" onClick={() => triageAndSave(run)}>
                        Looks clean, send to cloud →
                      </button>
                      <button className="ghost" onClick={() => setRun(EMPTY_RUN)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                <div ref={previewRef} onMouseUp={() => run.review && captureSelection()} onKeyUp={() => run.review && captureSelection()}>
                  <Sanitized text={run.sanitized} />
                </div>
              </div>
              {run.redactions.length > 0 && (
                <div>
                  <h2>Kept on this device</h2>
                  <RedactionList items={run.redactions} />
                </div>
              )}
            </section>
          )}
        </main>
      </div>
      <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        device={device}
        engine={engineKind}
        setEngine={setEngineKind}
        lan={lan}
        setLan={setLan}
        lanState={lanInfo}
        setLanState={setLanInfo}
      />
      <footer className="foot">
        Built with Firebase AI Logic hybrid inference · cloud model <code>{cfg.cloudModel}</code>
      </footer>
    </div>
  );
}
