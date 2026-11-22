/**
 * Local-network inference: send work to a more powerful machine on your own
 * network (an Ollama server) instead of the cloud. Data never leaves the LAN,
 * so it's treated like on-device: no cloud quota, allowed in Private mode.
 *
 * Server setup (on the powerful machine):
 *   OLLAMA_HOST=0.0.0.0 OLLAMA_ORIGINS=* ollama serve
 *   ollama pull qwen2.5-coder:7b
 */

export interface LanConfig {
  url: string; // e.g. http://192.168.1.8:11434
  model: string; // e.g. qwen2.5-coder:7b
  /**
   * Memory saver: weights are memory-mapped from disk (only the pages in use
   * are resident), a smaller context window, and the model is unloaded after
   * 1 minute idle. Slower first token, much lower RAM pressure.
   */
  memorySaver: boolean;
}

export interface LanModel {
  name: string;
  sizeGb: number;
  params: string; // "7.6B"
  minRamGb: number;
}

export interface LanStatus {
  online: boolean;
  models: LanModel[];
  error?: string;
}

export const DEFAULT_LAN: LanConfig = { url: "http://localhost:11434", model: "", memorySaver: true };

/** Suggested models for debugging, with rough minimum RAM for 4-bit quantized weights. */
export const RECOMMENDED_MODELS = [
  { name: "llama3.2:3b", minRamGb: 4, note: "fast, fine for triage on laptops" },
  { name: "gemma3:4b", minRamGb: 6, note: "good all-rounder" },
  { name: "qwen2.5-coder:7b", minRamGb: 8, note: "best code reasoning per GB" },
  { name: "gemma3:12b", minRamGb: 12, note: "stronger root-cause analysis" },
  { name: "qwen2.5-coder:32b", minRamGb: 24, note: "near-cloud quality; desktop GPU / 32 GB Mac" },
];

/** ~0.6 GB per billion params at Q4 + runtime overhead. */
function estimateRam(sizeBytes: number): number {
  return Math.ceil(sizeBytes / 1e9 + 1.5);
}

const trimUrl = (u: string) => u.trim().replace(/\/+$/, "");

export async function lanStatus(url: string): Promise<LanStatus> {
  try {
    const res = await fetch(`${trimUrl(url)}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { online: false, models: [], error: `HTTP ${res.status}` };
    const data = (await res.json()) as { models?: { name: string; size: number; details?: { parameter_size?: string } }[] };
    return {
      online: true,
      models: (data.models ?? []).map((m) => ({
        name: m.name,
        sizeGb: Math.round((m.size / 1e9) * 10) / 10,
        params: m.details?.parameter_size ?? "",
        minRamGb: estimateRam(m.size),
      })),
    };
  } catch (e) {
    const msg = (e as Error).name === "TimeoutError" ? "no response" : (e as Error).message;
    return { online: false, models: [], error: msg };
  }
}

function options(cfg: LanConfig) {
  return cfg.memorySaver
    ? { options: { use_mmap: true, use_mlock: false, num_ctx: 4096 }, keep_alive: "1m" }
    : { options: { use_mmap: true, use_mlock: true, num_ctx: 8192 }, keep_alive: "15m" };
}

async function post(cfg: LanConfig, body: object, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${trimUrl(cfg.url)}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: cfg.model, ...options(cfg), ...body }),
      signal,
    });
  } catch {
    throw new Error(`Local server ${cfg.url} is offline or unreachable. Check it's running (see Settings → Local network).`);
  }
  if (!res.ok) throw new Error(`Local server error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

/** Single-turn chat, optionally constrained to a JSON schema. Returns the text. */
export async function lanChat(cfg: LanConfig, system: string, prompt: string, schema?: object): Promise<string> {
  const res = await post(
    cfg,
    {
      stream: false,
      format: schema,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    },
    AbortSignal.timeout(180_000),
  );
  const data = (await res.json()) as { message?: { content?: string } };
  return data.message?.content ?? "";
}

/** Streaming chat; yields text chunks. */
export async function* lanStream(cfg: LanConfig, system: string, prompt: string): AsyncGenerator<string> {
  const res = await post(cfg, {
    stream: true,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
  });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as { message?: { content?: string } };
      if (msg.message?.content) yield msg.message.content;
    }
  }
}
