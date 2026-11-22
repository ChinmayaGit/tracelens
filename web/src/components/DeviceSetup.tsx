import { useEffect, useRef, useState } from "react";
import {
  NANO_REQUIREMENTS,
  deviceStatus,
  resetModels,
  startDeviceDownload,
  type DeviceStatus,
  type Hardware,
  type ProcessingMode,
} from "../lib/pipeline";

const MODES: { id: ProcessingMode; label: string; desc: string }[] = [
  { id: "hybrid", label: "Hybrid", desc: "Gemini Nano when available, cloud for fallback and deep dives" },
  { id: "private", label: "Private", desc: "On-device only. Nothing is sent to the cloud" },
  { id: "cloud", label: "Cloud", desc: "For devices without Gemini Nano. Secrets still removed locally by rules" },
];

/** Warn after this long with zero progress; auto-stop after STALL_STOP_MS. */
const STALL_WARN_MS = 30_000;
const STALL_STOP_MS = 120_000;

interface Props {
  device: DeviceStatus;
  hw: Hardware | null;
  mode: ProcessingMode;
  setMode: (m: ProcessingMode) => void;
  setDevice: (d: DeviceStatus) => void;
}

export function DeviceSetup({ device, hw, mode, setMode, setDevice }: Props) {
  const [progress, setProgress] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [showReqs, setShowReqs] = useState(false);
  const dl = useRef<{ cancel(): void } | null>(null);
  const lastProgressAt = useRef(0);

  const downloading = progress !== null;
  const stalled = downloading && progress === 0 && elapsed >= STALL_WARN_MS;

  // Watchdog: tick while downloading; auto-stop a download that never starts.
  useEffect(() => {
    if (!downloading) return;
    const t0 = Date.now();
    const id = setInterval(() => {
      setElapsed(Date.now() - t0);
      if (Date.now() - lastProgressAt.current >= STALL_STOP_MS) {
        stop("Download stopped: no progress for 2 minutes. Switched to Cloud mode so you can keep working.", true);
      }
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloading]);

  const start = async () => {
    setNotice(null);
    setShowReqs(false);
    setProgress(0);
    setElapsed(0);
    lastProgressAt.current = Date.now();
    const handle = startDeviceDownload((p) => {
      if (p > 0) lastProgressAt.current = Date.now();
      setProgress(p);
    });
    dl.current = handle;
    try {
      await handle.done;
      resetModels();
      setNotice("Gemini Nano is ready. Redaction and triage now run on this device.");
      setMode("hybrid");
    } catch (e) {
      if ((e as Error).name !== "AbortError") setNotice(`Download failed: ${(e as Error).message}`);
    } finally {
      dl.current = null;
      setProgress(null);
      setDevice(await deviceStatus());
    }
  };

  function stop(msg: string, toCloud: boolean) {
    dl.current?.cancel();
    dl.current = null;
    setProgress(null);
    setNotice(msg);
    if (toCloud) setMode("cloud");
  }

  const needsModel = device === "downloadable" || device === "downloading";
  const noNano = device === "unavailable" || device === "unsupported";
  const weakHw = !!hw && (hw.cores < 4 || (hw.memoryGb !== undefined && hw.memoryGb < 8));

  return (
    <section className="card setup">
      <div className="row between">
        <h2>Processing mode</h2>
        <div className="seg" role="radiogroup" aria-label="Processing mode">
          {MODES.map((m) => {
            const disabled = m.id === "private" && device !== "available";
            return (
              <button
                key={m.id}
                role="radio"
                aria-checked={mode === m.id}
                className={mode === m.id ? "on" : ""}
                disabled={disabled}
                title={disabled ? "Private mode needs Gemini Nano on this device" : m.desc}
                onClick={() => setMode(m.id)}
              >
                {m.label}
              </button>
            );
          })}
        </div>
      </div>
      <p className="muted small">{MODES.find((m) => m.id === mode)?.desc}</p>

      {noNano && mode !== "cloud" && (
        <div className="warn">
          This browser/device can't run Gemini Nano, so TraceLens uses the cloud with local rule-based redaction. For
          on-device AI use desktop Chrome 139+ with the Prompt API flag on.
        </div>
      )}

      {needsModel && mode !== "cloud" && !downloading && (
        <div className="offer">
          <div>
            <b>Get Gemini Nano for private, offline triage</b>
            <p className="muted small">
              One-time ~4 GB download managed by Chrome. Until then, AI steps use the cloud.
            </p>
          </div>
          {!showReqs ? (
            <div className="row">
              <button className="primary" onClick={() => setShowReqs(true)}>
                Set up on-device AI
              </button>
              <button className="ghost" onClick={() => setMode("cloud")}>
                Use Cloud mode
              </button>
            </div>
          ) : (
            <div className="reqs">
              <p className="small">Chrome only downloads the model if your device meets these requirements:</p>
              <ul className="small">
                {NANO_REQUIREMENTS.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              {hw && (
                <p className="small muted">
                  Detected: {hw.cores} CPU cores · {hw.memoryGb !== undefined ? `${hw.memoryGb}${hw.memoryGb >= 8 ? "+" : ""} GB RAM` : "RAM unknown"} ·{" "}
                  {hw.webgpu ? "GPU available" : "no WebGPU"}. Browsers can't see free disk space, so check that yourself.
                </p>
              )}
              {weakHw && <div className="warn">This device looks below the requirements. Cloud mode is recommended.</div>}
              <div className="row">
                <button className="primary" onClick={start}>
                  I meet these, download
                </button>
                <button className="ghost" onClick={() => setMode("cloud")}>
                  Use Cloud mode instead
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {downloading && (
        <div className="offer">
          <div className="row between">
            <b>Downloading Gemini Nano… {Math.round((progress ?? 0) * 100)}%</b>
            <button className="ghost" onClick={() => stop("Download cancelled.", false)}>
              Cancel
            </button>
          </div>
          <div className="progress">
            <div style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
          </div>
          {stalled && (
            <div className="warn">
              <b>The download hasn't started after {Math.round(elapsed / 1000)}s.</b> Chrome usually holds it back when
              there's <b>less than 22 GB free disk</b> or the hardware is below the requirements. Open{" "}
              <code>chrome://on-device-internals</code> → Model Status to see the reason. It stops automatically at 2
              minutes.
              <div className="row" style={{ marginTop: 8 }}>
                <button onClick={() => stop("Download stopped. Using Cloud mode.", true)}>Stop & use Cloud mode</button>
              </div>
            </div>
          )}
        </div>
      )}

      {notice && <p className="notice small">{notice}</p>}
    </section>
  );
}
