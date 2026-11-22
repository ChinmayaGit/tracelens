import { useEffect, useState } from "react";
import { RECOMMENDED_MODELS, lanStatus, type LanConfig, type LanStatus } from "../lib/local";
import type { DeviceStatus } from "../lib/pipeline";
import { BROWSER_MODELS, deviceMemoryGb, webGpuSupported } from "../lib/edge";

export type EngineKind = "builtin" | "lan" | "browser";
export type SettingsTab = "nano" | "browser" | "network";

const TAB_ENGINE: Record<SettingsTab, EngineKind> = { nano: "builtin", browser: "browser", network: "lan" };
const ENGINE_TAB: Record<EngineKind, SettingsTab> = { builtin: "nano", browser: "browser", lan: "network" };
export const tabForEngine = (e: EngineKind) => ENGINE_TAB[e];

export interface BrowserModelsProps {
  selected: string;
  select: (id: string) => void;
  installed: Set<string>;
  progress: Record<string, number>;
  download: (id: string) => void;
  cancel: (id: string) => void;
  remove: (id: string) => void;
  hfToken: string;
  setHfToken: (t: string) => void;
  notice: string | null;
}

interface Props {
  tab: SettingsTab;
  setTab: (t: SettingsTab) => void;
  onBack: () => void;
  device: DeviceStatus;
  engine: EngineKind;
  setEngine: (e: EngineKind) => void;
  lan: LanConfig;
  setLan: (l: LanConfig) => void;
  lanState: LanStatus | null;
  setLanState: (s: LanStatus | null) => void;
  browser: BrowserModelsProps;
}

const TABS: { id: SettingsTab; title: string; sub: string; icon: string }[] = [
  { id: "nano", title: "Gemini Nano", sub: "Built-in to Chrome (default)", icon: "◎" },
  { id: "browser", title: "Browser models", sub: "Google AI Edge · WebGPU", icon: "▣" },
  { id: "network", title: "Network server", sub: "Bigger model on your Wi-Fi", icon: "⇄" },
];

/* ------------------------------------------------------------------ */
/* Small shared bits                                                    */
/* ------------------------------------------------------------------ */

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

/** Header of each tab: what it is, and whether it's the engine in use. */
function EngineHeader(p: { title: string; desc: string; active: boolean; onUse: () => void; disabled?: boolean }) {
  return (
    <div className="engine-head">
      <div>
        <h3>{p.title}</h3>
        <p className="muted small">{p.desc}</p>
      </div>
      {p.active ? (
        <span className="pill pill-available">✓ In use</span>
      ) : (
        <button className="primary" onClick={p.onUse} disabled={p.disabled}>
          Use this engine
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tab: Gemini Nano                                                     */
/* ------------------------------------------------------------------ */

/** chrome:// pages can't be opened by a web page (browsers block it), so we copy them. */
const CHROME_PAGES = [
  { url: "chrome://flags/#prompt-api-for-gemini-nano-multimodal-input", what: "Set to Enabled. Turns on the Prompt API (Gemini Nano) with image input." },
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

function NanoTab({ p }: { p: Props }) {
  const ver = chromeVersion();
  const hasApi = typeof LanguageModel !== "undefined";
  return (
    <>
      <EngineHeader
        title="Built-in: Gemini Nano"
        desc="Google's on-device model inside Chrome, used through Firebase AI Logic hybrid inference. Free, private, offline."
        active={p.engine === "builtin"}
        onUse={() => p.setEngine("builtin")}
      />
      <section className="panel">
        <h4>Requirements (Chrome's)</h4>
        <ul className="reqs-list small">
          <li>Desktop Chrome 139+ on Windows 10/11, macOS 13+ or Linux</li>
          <li>22 GB free disk on the drive with your Chrome profile (the model itself is ~4 GB)</li>
          <li>GPU with more than 4 GB VRAM, or 16 GB RAM with 4+ CPU cores</li>
          <li>Unmetered network for the one-time download</li>
        </ul>
      </section>
      <section className="panel">
        <h4>Status on this device</h4>
        <ul className="checks">
          <Check ok={ver >= 139} label={`Desktop Chrome 139+ (you have ${ver || "not Chrome"})`} hint="Update Chrome." />
          <Check ok={hasApi} label="Prompt API turned on" hint="Enable the first flag below, then restart Chrome." />
          <Check
            ok={p.device === "available" ? true : p.device === "downloading" ? null : false}
            label={`Model status: ${p.device}`}
            hint={
              p.device === "downloadable"
                ? "Use “Set up on-device AI” on the main screen to start the download."
                : "See Model Status in on-device-internals."
            }
          />
        </ul>
      </section>
      <section className="panel">
        <h4>Setup pages</h4>
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
          After changing a flag, <b>quit Chrome completely (⌘Q / Exit)</b> and reopen it. Download stuck at 0%? Keep 22 GB+
          free disk, use unmetered Wi-Fi, then <i>Check for update</i> on the components page. Too slow on your machine? Try
          the <b>Browser models</b> or <b>Network server</b> tab.
        </p>
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Tab: Browser models (Google AI Edge / WebGPU)                        */
/* ------------------------------------------------------------------ */

function BrowserTab({ p }: { p: Props }) {
  const b = p.browser;
  const gpu = webGpuSupported();
  const mem = deviceMemoryGb();
  const anyInstalled = b.installed.size > 0;
  return (
    <>
      <EngineHeader
        title="Open model in this browser (Google AI Edge)"
        desc="Download Gemma once and run it on your GPU via WebGPU. Works without Gemini Nano, fully offline after the download."
        active={p.engine === "browser"}
        onUse={() => p.setEngine("browser")}
        disabled={!gpu}
      />
      {!gpu && (
        <div className="warn">This browser has no WebGPU, so open models can't run here. Use desktop Chrome / Edge 121+ (or Safari 26+).</div>
      )}
      {p.engine === "browser" && !anyInstalled && <div className="warn">Download a model below to start using this engine.</div>}
      <p className="small muted">
        Stored in this browser's private storage (OPFS), so each model downloads once.
        {mem ? ` This device reports ${mem}${mem >= 8 ? "+" : ""} GB RAM.` : ""}
      </p>
      <div className="models">
        {BROWSER_MODELS.map((m) => {
          const installed = b.installed.has(m.id);
          const prog = b.progress[m.id];
          return (
            <div key={m.id} className={`model ${b.selected === m.id && installed ? "on" : ""}`}>
              <label className="radio">
                <input type="radio" disabled={!installed} checked={b.selected === m.id} onChange={() => b.select(m.id)} />
                <span>
                  <b>{m.name}</b>
                  <small className="muted">
                    {" "}
                    · {m.sizeGb} GB · needs ~{m.minMemGb} GB memory · {m.needsToken ? "Hugging Face token" : "free"}
                  </small>
                  <br />
                  <small>{m.note}</small>
                </span>
              </label>
              {prog !== undefined ? (
                <div className="row">
                  <div className="progress grow">
                    <div style={{ width: `${Math.round(prog * 100)}%` }} />
                  </div>
                  <small>{Math.round(prog * 100)}%</small>
                  <button className="ghost" onClick={() => b.cancel(m.id)}>
                    Cancel
                  </button>
                </div>
              ) : installed ? (
                <div className="row">
                  <span className="pill pill-available">Downloaded</span>
                  <button className="ghost" onClick={() => b.remove(m.id)}>
                    Delete
                  </button>
                </div>
              ) : (
                <button disabled={!gpu} onClick={() => b.download(m.id)}>
                  Download
                </button>
              )}
            </div>
          );
        })}
      </div>
      <section className="panel">
        <label className="small">Hugging Face token (only for Gemma 3 models)</label>
        <input
          className="field"
          type="password"
          value={b.hfToken}
          placeholder="hf_…"
          onChange={(e) => b.setHfToken(e.target.value)}
          autoComplete="off"
        />
        <p className="small muted">
          Gemma 3 is free but gated: accept its license on huggingface.co, then create a Read token. It's stored only in this
          browser.
        </p>
      </section>
      {b.notice && <p className="notice small">{b.notice}</p>}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Tab: Network server (Ollama)                                         */
/* ------------------------------------------------------------------ */

function NetworkTab({ p }: { p: Props }) {
  const [testing, setTesting] = useState(false);
  const test = async () => {
    setTesting(true);
    const s = await lanStatus(p.lan.url);
    p.setLanState(s);
    if (s.online && !p.lan.model && s.models[0]) p.setLan({ ...p.lan, model: s.models[0].name });
    setTesting(false);
  };
  useEffect(() => {
    void test();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const isHttpsPage = location.protocol === "https:";
  const lanIsLocalhost = /\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(p.lan.url);

  return (
    <>
      <EngineHeader
        title="Bigger model on my network"
        desc="A powerful machine on your Wi-Fi runs the model (Ollama). Nothing leaves your network, and it uses no cloud quota."
        active={p.engine === "lan"}
        onUse={() => p.setEngine("lan")}
      />
      <section className="panel">
        <h4>
          Server{" "}
          <span className={`pill ${p.lanState?.online ? "pill-available" : "pill-offline"}`}>
            {testing ? "Checking…" : p.lanState ? (p.lanState.online ? "Online" : "Offline") : "Unknown"}
          </span>
        </h4>
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
            The device at <code>{p.lan.url}</code> is offline or unreachable ({p.lanState.error}). Check it's on the same Wi-Fi
            and running Ollama with network access:
            <pre className="cmd">OLLAMA_HOST=0.0.0.0 OLLAMA_ORIGINS=* ollama serve</pre>
            {isHttpsPage && !lanIsLocalhost && (
              <>
                Browsers block <code>http://</code> LAN addresses from an <code>https://</code> page. Serve Ollama over HTTPS
                (e.g. <code>tailscale serve</code> / Caddy), or run TraceLens locally with <code>npm run dev</code>.
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
      </section>
      <section className="panel">
        <label className="toggle">
          <input type="checkbox" checked={p.lan.memorySaver} onChange={(e) => p.setLan({ ...p.lan, memorySaver: e.target.checked })} />
          <span>
            <b>Memory saver (stream weights from disk)</b>
            <small className="muted">
              {" "}
              Memory-maps the model file so only the layers being used sit in RAM, uses a smaller context window, and
              unloads the model after 1 min idle. Lets a big model run on a smaller machine; the first answer is slower.
            </small>
          </span>
        </label>
      </section>
      <section className="panel">
        <h4>Recommended models (minimum RAM on the server)</h4>
        <table className="req">
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
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                 */
/* ------------------------------------------------------------------ */

export function SettingsPage(p: Props) {
  const activeTab = ENGINE_TAB[p.engine];
  return (
    <div className="settings-page">
      <div className="settings-top">
        <button className="ghost" onClick={p.onBack}>
          ← Back
        </button>
        <div>
          <h2>Settings & setup</h2>
          <p className="muted small">Choose where private AI steps run. The cloud is only used in Hybrid / Cloud mode.</p>
        </div>
      </div>

      <nav className="tabs" role="tablist" aria-label="Local AI engine">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={p.tab === t.id}
            className={`tab ${p.tab === t.id ? "on" : ""}`}
            onClick={() => p.setTab(t.id)}
          >
            <span className="tab-icon" aria-hidden>
              {t.icon}
            </span>
            <span className="tab-text">
              <b>
                {t.title}
                {activeTab === t.id && <span className="tab-dot" title="In use" />}
              </b>
              <small>{t.sub}</small>
            </span>
          </button>
        ))}
      </nav>

      <div className="tab-body" role="tabpanel">
        {p.tab === "nano" && <NanoTab p={p} />}
        {p.tab === "browser" && <BrowserTab p={p} />}
        {p.tab === "network" && <NetworkTab p={p} />}
      </div>
    </div>
  );
}

export { TAB_ENGINE };
