/**
 * Open models running inside this browser tab: Google AI Edge's MediaPipe
 * LLM Inference for Web (WebGPU), the browser twin of the Android AI Edge engine.
 * Useful when Gemini Nano isn't available or is too slow on this machine.
 *
 * Models are downloaded once into the Origin Private File System (OPFS), so
 * they survive reloads, and can be deleted from Settings.
 */
import { FilesetResolver, LlmInference } from "@mediapipe/tasks-genai";

export interface BrowserModel {
  id: string;
  name: string;
  shortName: string;
  repo: string;
  file: string;
  sizeGb: number;
  /** Rough GPU / unified memory needed. */
  minMemGb: number;
  needsToken: boolean;
  note: string;
}

export const BROWSER_MODELS: BrowserModel[] = [
  {
    id: "gemma3-270m", name: "Gemma 3 270M", shortName: "Gemma 3 270M",
    repo: "litert-community/gemma-3-270m-it", file: "gemma3-270m-it-q8-web.task",
    sizeGb: 0.28, minMemGb: 2, needsToken: true, note: "Tiny and instant; rough answers.",
  },
  {
    id: "gemma3-1b", name: "Gemma 3 1B (int4)", shortName: "Gemma 3 1B",
    repo: "litert-community/Gemma3-1B-IT", file: "gemma3-1b-it-int4-web.task",
    sizeGb: 0.7, minMemGb: 4, needsToken: true, note: "Small and fast. Good for redaction.",
  },
  {
    id: "gemma4-e2b", name: "Gemma 4 E2B", shortName: "Gemma 4 E2B",
    repo: "litert-community/gemma-4-E2B-it-litert-lm", file: "gemma-4-E2B-it-web.task",
    sizeGb: 2.0, minMemGb: 6, needsToken: false, note: "Recommended: free, strong reasoning for its size.",
  },
  {
    id: "gemma4-e4b", name: "Gemma 4 E4B", shortName: "Gemma 4 E4B",
    repo: "litert-community/gemma-4-E4B-it-litert-lm", file: "gemma-4-E4B-it-web.task",
    sizeGb: 2.96, minMemGb: 8, needsToken: false, note: "Best quality; needs a strong GPU / 16 GB Mac.",
  },
];

const url = (m: BrowserModel) => `https://huggingface.co/${m.repo}/resolve/main/${m.file}`;

/** Pinned to the npm version in package.json. */
const WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai@0.10.30/wasm";

export function webGpuSupported(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

/** Approximate device memory (browsers cap navigator.deviceMemory at 8). */
export function deviceMemoryGb(): number | undefined {
  return (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
}

async function dir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle("models", { create: true });
}

export async function installedModels(): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const d = await dir();
    for (const m of BROWSER_MODELS) {
      try {
        // A model counts as installed only once its download finished (marker file).
        await d.getFileHandle(m.file + ".ok");
        out.add(m.id);
      } catch {
        /* not downloaded */
      }
    }
  } catch {
    /* OPFS unavailable */
  }
  return out;
}

/** Stream the model into OPFS with progress (0..1). Abortable. */
export async function downloadModel(
  m: BrowserModel,
  hfToken: string,
  onProgress: (p: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  // Ask the browser not to evict multi-GB models under storage pressure.
  await navigator.storage.persist?.().catch(() => false);
  const res = await fetch(url(m), {
    headers: hfToken.trim() ? { Authorization: `Bearer ${hfToken.trim()}` } : undefined,
    signal,
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      m.needsToken
        ? `${m.name} is gated: accept the license on huggingface.co/${m.repo} and paste a Read token in Settings.`
        : `Download refused (${res.status}).`,
    );
  }
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || m.sizeGb * 1e9;
  const d = await dir();
  await d.removeEntry(m.file + ".ok").catch(() => {});
  // Write straight to the final file (no temp copy: models are GBs) and mark completion separately.
  const w = await (await d.getFileHandle(m.file, { create: true })).createWritable();
  const reader = res.body.getReader();
  let done = 0;
  let last = 0;
  try {
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      await w.write(value);
      done += value.byteLength;
      if (done - last > 8_000_000) {
        last = done;
        onProgress(done / total);
      }
    }
    await w.close();
  } catch (e) {
    await w.abort().catch(() => {});
    await d.removeEntry(m.file).catch(() => {});
    throw e;
  }
  await d.getFileHandle(m.file + ".ok", { create: true });
  onProgress(1);
}

let loaded: { id: string; llm: LlmInference } | null = null;

export async function deleteModel(m: BrowserModel) {
  if (loaded?.id === m.id) {
    loaded.llm.close();
    loaded = null;
  }
  const d = await dir();
  await d.removeEntry(m.file + ".ok").catch(() => {});
  await d.removeEntry(m.file).catch(() => {});
}

/** Load once (from OPFS, streamed) and keep it; switching models frees the old one. */
async function engine(m: BrowserModel): Promise<LlmInference> {
  if (loaded?.id === m.id) return loaded.llm;
  loaded?.llm.close();
  loaded = null;
  const fileset = await FilesetResolver.forGenAiTasks(WASM_BASE);
  const file = await (await (await dir()).getFileHandle(m.file)).getFile();
  const llm = await LlmInference.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: file.stream().getReader() },
    maxTokens: 4096,
    topK: 40,
    temperature: 0.2,
  });
  loaded = { id: m.id, llm };
  return llm;
}

export async function generate(m: BrowserModel, prompt: string): Promise<string> {
  return (await engine(m)).generateResponse(prompt);
}

/** Streams text chunks. */
export async function* stream(m: BrowserModel, prompt: string): AsyncGenerator<string> {
  const llm = await engine(m);
  const queue: string[] = [];
  let finished = false;
  let wake: (() => void) | null = null;
  const all = llm.generateResponse(prompt, (partial: string, done: boolean) => {
    queue.push(partial);
    if (done) finished = true;
    wake?.();
  });
  for (;;) {
    while (queue.length) yield queue.shift()!;
    if (finished) break;
    await new Promise<void>((r) => (wake = r));
    wake = null;
  }
  await all;
}
