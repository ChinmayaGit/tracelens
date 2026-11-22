import { useMemo } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import type { StepLog, StepSource } from "../lib/pipeline";
import type { Redaction } from "../lib/redact";

const SOURCE_LABEL: Record<StepSource, string> = {
  on_device: "On-device · Gemini Nano",
  in_cloud: "Cloud · Gemini",
  local_rules: "Local rules",
  skipped: "Skipped",
};

const STEP_LABEL: Record<StepLog["step"], string> = {
  extract: "Read screenshot",
  redact_rules: "Redact secrets (rules)",
  redact_model: "Redact context (AI)",
  triage: "Quick triage",
  deep: "Root-cause deep dive",
};

export function SourceBadge({ source }: { source: StepSource }) {
  return <span className={`badge badge-${source}`}>{SOURCE_LABEL[source]}</span>;
}

export function Timeline({ steps, pending }: { steps: StepLog[]; pending?: string | null }) {
  return (
    <ol className="timeline">
      {steps.map((s, i) => (
        <li key={i}>
          <span className="tl-name">{STEP_LABEL[s.step]}</span>
          <SourceBadge source={s.source} />
          {s.source !== "skipped" && <span className="tl-ms">{Math.round(s.ms)} ms</span>}
          {s.note && <span className="tl-note">{s.note}</span>}
        </li>
      ))}
      {pending && (
        <li className="tl-pending">
          <span className="spinner" aria-hidden /> {pending}
        </li>
      )}
    </ol>
  );
}

/** Sanitized text with placeholders highlighted. */
export function Sanitized({ text }: { text: string }) {
  const parts = useMemo(() => text.split(/(\[[A-Z_]+_\d+\])/g), [text]);
  return (
    <pre className="sanitized">
      {parts.map((p, i) =>
        /^\[[A-Z_]+_\d+\]$/.test(p) ? (
          <mark key={i}>{p}</mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </pre>
  );
}

/** Kept only in memory for this session; shows the user what stayed local. */
export function RedactionList({ items }: { items: Redaction[] }) {
  if (!items.length) return <p className="muted">Nothing sensitive found.</p>;
  return (
    <ul className="redactions">
      {items.map((r) => (
        <li key={r.placeholder}>
          <mark>{r.placeholder}</mark>
          <span className="secret" title="Never leaves this device">
            {r.original.length > 6 ? `${r.original.slice(0, 3)}•••${r.original.slice(-2)}` : "•••"}
          </span>
          <span className={`by by-${r.by}`}>{r.by === "rule" ? "rule" : r.by === "user" ? "you" : "Gemini Nano"}</span>
        </li>
      ))}
    </ul>
  );
}

export function Markdown({ md }: { md: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(md, { async: false }) as string), [md]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Confidence({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const tone = pct >= 75 ? "good" : pct >= 50 ? "warn" : "bad";
  return (
    <div className="confidence" aria-label={`Confidence ${pct}%`}>
      <div className={`bar bar-${tone}`} style={{ width: `${pct}%` }} />
      <span>{pct}% confident</span>
    </div>
  );
}
