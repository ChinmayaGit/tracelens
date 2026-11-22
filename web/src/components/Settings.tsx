import { useEffect, useState } from "react";
import { RECOMMENDED_MODELS, lanStatus, type LanConfig, type LanStatus } from "../lib/local";
import type { DeviceStatus } from "../lib/pipeline";

export type EngineKind = "builtin" | "lan";

interface Props {
  open: boolean;
  onClose: () => void;
  device: DeviceStatus;
  engine: EngineKind;
  setEngine: (e: EngineKind) => void;
  lan: LanConfig;
  setLan: (l: LanConfig) => void;
  lanState: LanStatus | null;
  setLanState: (s: LanStatus | null) => void;
}

/** chrome:// pages can't be opened by a web page (browsers block it), so we copy them. */
const CHROME_PAGES = [
  {
    url: "chrome://flags/#prompt-api-for-gemini-nano-multimodal-input",
    what: "Set to Enabled. Turns on the Prompt API (Gemini Nano) with image input.",
  },
  {
    url: "chrome://flags/#optimization-guide-on-device-model",
    what: "Older Chrome only: Enabled BypassPerfRequirement (skip the hardware check). Missing in Chrome 150+; that's fine.",
  },
  { url: "chrome://components", what: "Optimization Guide On Device Model → Check for update (forces the download)." },
  { url: "chrome://on-device-internals", what: "Model Status / Event Logs tabs show why a download is blocked." },
];

function chromeVersion(): number {
  const m = navigator.userAgent.match(/Chrome\/(\d+)/);
  return m ? Number(m[1]) : 0;
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="chip"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          prompt("Copy this, then paste it in the address bar:", text);
        }
      }}
    >
      {done ? "Copied ✓" : "Copy"}
    </button>
  );
}

function Check({ ok, label, hint }: { ok: boolean | null; label: string; hint?: string }) {
  return (
    <li className="check">
      <span className={ok === null ? "dot dot-wait" : ok ? "dot dot-ok" : "dot dot-bad"}>{ok === null ? "…" : ok ? "✓" : "✕"}</span>
      <span>
        {label}
        {hint && !ok && <small className="muted"> {hint}</small>}
      </span>
    </li>
  );
}

export function Settings(p: Props) {
  const [testing, setTesting] = useState(false);
  const ver = chromeVersion();
  const hasApi = typeof LanguageModel !== "undefined";

  const test = async () => {
    setTesting(true);
    const s = await lanStatus(p.lan.url);
    p.setLanState(s);
    if (s.online && !p.lan.model && s.models[0]) p.setLan({ ...p.lan, model: s.models[0].name });
    setTesting(false);
  };

  useEffect(() => {
    if (p.open && p.engine === "lan") void test();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.open, p.engine]);

  if (!p.open) return null;
  const isHttpsPage = location.protocol === "https:";
  const lanIsLocalhost = /\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(p.lan.url);

  return (
    <div className="modal" role="dialog" aria-label="Settings" onClick={p.onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <h2>Settings & setup</h2>
          <button className="ghost" onClick={p.onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {/* ------------------------------------------------ engine */}
        <section>
          <h3>Local AI engine</h3>
          <p className="muted small">Used for private steps (redaction, triage). The cloud is only used in Hybrid/Cloud mode.</p>
          <label className="radio">
            <input type="radio" checked={p.engine === "builtin"} onChange={() => p.setEngine("builtin")} />
            <span>
              <b>Built-in: Gemini Nano</b> (default) · runs inside Chrome on this device
              <small className="muted"> · needs 22 GB free disk, GPU &gt; 4 GB VRAM or 16 GB RAM</small>
            </span>
          </label>
          <label className="radio">
            <input type="radio" checked={p.engine === "lan"} onChange={() => p.setEngine("lan")} />
            <span>
              <b>Bigger model on my network</b> · a powerful machine on your Wi-Fi does the work (Ollama). Nothing
              leaves your network.
            </span>
          </label>
        </section>

        {/* ------------------------------------------------ LAN */}
        {p.engine === "lan" && (
          <section>
            <h3>
              Local network server{" "}
              <span className={`pill ${p.lanState?.online ? "pill-available" : "pill-offline"}`}>
                {testing ? "Checking…" : p.lanState ? (p.lanState.online ? "Online" : "Offline") : "Unknown"}
              </span>
            </h3>
            <div className="row">
              <input
                className="field"
                value={p.lan.url}
                onChange={(e) => p.setLan({ ...p.lan, url: e.target.value })}
                placeholder="http://192.168.1.20:11434"
                spellCheck={false}
              />
              <button onClick={test} disabled={testing}>
                Test connection
              </button>
            </div>
            {p.lanState && !p.lanState.online && (
              <div className="warn">
                The device at <code>{p.lan.url}</code> is offline or unreachable ({p.lanState.error}). Check it's on the
                same Wi-Fi and running Ollama with network access:
                <pre className="cmd">OLLAMA_HOST=0.0.0.0 OLLAMA_ORIGINS=* ollama serve</pre>
                {isHttpsPage && !lanIsLocalhost && (
                  <>
                    Browsers block <code>http://</code> LAN addresses from an <code>https://</code> page. Serve Ollama over
                    HTTPS (e.g. <code>tailscale serve</code> / Caddy), or run TraceLens locally with <code>npm run dev</code>.
                  </>
                )}
              </div>
            )}
            {p.lanState?.online && (
              <>
                <label className="small">Model on this server</label>
                <select className="field" value={p.lan.model} onChange={(e) => p.setLan({ ...p.lan, model: e.target.value })}>
                  {p.lanState.models.length === 0 && <option value="">No models installed</option>}
                  {p.lanState.models.map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.name} · {m.params || `${m.sizeGb} GB`} · needs ~{m.minRamGb} GB RAM
                    </option>
                  ))}
                </select>
              </>
            )}

            <label className="toggle">
              <input
                type="checkbox"
                checked={p.lan.memorySaver}
                onChange={(e) => p.setLan({ ...p.lan, memorySaver: e.target.checked })}
              />
              <span>
                <b>Memory saver (stream weights from disk)</b>
                <small className="muted">
                  {" "}
                  Memory-maps the model file so only the layers being used sit in RAM, uses a smaller context window,
                  and unloads the model after 1 min idle. Lets a big model run on a smaller machine; the first answer is
                  slower.
                </small>
              </span>
            </label>

            <details>
              <summary className="small">Recommended models & minimum RAM</summary>
              <table className="req">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Min RAM</th>
                    <th>Good for</th>
                  </tr>
                </thead>
                <tbody>
                  {RECOMMENDED_MODELS.map((m) => (
                    <tr key={m.name}>
                      <td>
                        <code>{m.name}</code> <Copy text={`ollama pull ${m.name}`} />
                      </td>
                      <td>{m.minRamGb} GB</td>
                      <td className="muted">{m.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </section>
        )}

        {/* ------------------------------------------------ Chrome checklist */}
        <section>
          <h3>Gemini Nano setup (Chrome)</h3>
          <ul className="checks">
            <Check ok={ver >= 139} label={`Desktop Chrome 139+ (you have ${ver || "not Chrome"})`} hint="Update Chrome." />
            <Check ok={hasApi} label="Prompt API turned on" hint="Enable the first flag below, then restart Chrome." />
            <Check
              ok={p.device === "available" ? true : p.device === "downloading" ? null : false}
              label={`Model status: ${p.device}`}
              hint={
                p.device === "downloadable"
                  ? "Click “Set up on-device AI” on the main screen to start the download."
                  : "See Model Status in on-device-internals."
              }
            />
          </ul>
          <p className="small muted">
            Browsers don't let web pages open <code>chrome://</code> links. Copy each one into the address bar:
          </p>
          <ul className="pages">
            {CHROME_PAGES.map((c) => (
              <li key={c.url}>
                <div className="row">
                  <code>{c.url}</code>
                  <Copy text={c.url} />
                </div>
                <small className="muted">{c.what}</small>
              </li>
            ))}
          </ul>
          <p className="small muted">
            After changing a flag, <b>quit Chrome completely (⌘Q / Exit)</b> and reopen it. If the download is stuck at
            0%: keep 22 GB+ free disk, use unmetered Wi-Fi, then use <i>Check for update</i> on the components page.
          </p>
        </section>
      </div>
    </div>
  );
}
