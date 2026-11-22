/**
 * Deterministic, model-free redaction. Runs first and always, so secrets never
 * depend on a model being available. The on-device model then catches the
 * contextual leftovers (names, internal hosts, customer IDs).
 */

export interface Redaction {
  kind: string;
  original: string;
  placeholder: string;
  by: "rule" | "on_device" | "user";
}

const PLACEHOLDER = /(\[[A-Z_]+_\d+\])/;
const isPlaceholderish = (v: string) => /^\[*[A-Z_]+_\d+\]*$/.test(v.trim());

interface Rule {
  kind: string;
  re: RegExp;
  /** Capture group holding the secret; 0 = whole match. */
  group?: number;
}

const RULES: Rule[] = [
  { kind: "PRIVATE_KEY", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: "JWT", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: "AWS_KEY", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "GOOGLE_API_KEY", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "GITHUB_TOKEN", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { kind: "SLACK_TOKEN", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "STRIPE_KEY", re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { kind: "API_KEY", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "BEARER", re: /\b[Bb]earer\s+([A-Za-z0-9._~+/=-]{16,})/g, group: 1 },
  { kind: "URL_CREDENTIALS", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]+)@/gi, group: 1 },
  {
    kind: "SECRET_ASSIGNMENT",
    re: /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\b["']?\s*[:=]\s*["']?([^\s"',;}{]{6,})/gi,
    group: 1,
  },
  { kind: "EMAIL", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: "CREDIT_CARD", re: /\b(?:\d[ -]?){13,16}\b/g },
  // International / NANP phone numbers: +1 415 555 0136, (415) 555-0136, +44 20 7946 0958
  { kind: "PHONE", re: /(?<![\w.])(?:\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]\d{3,4}[\s.-]\d{3,4}(?![\w.])/g },
  // Capitalised names after a person label: "rider Marcus Okafor", "name: Jane Doe"
  {
    kind: "PERSON",
    re: /\b(?:name|rider|driver|user|customer|patient|employee|client|owner|author|contact|recipient|sender)\b["']?\s*[:=]?\s*["']?([A-Z][a-z]+(?:\s[A-Z][a-z'-]+){1,2})\b/g,
    group: 1,
  },
  { kind: "IPV4", re: /\b(?!127\.0\.0\.1\b)(?!0\.0\.0\.0\b)(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
  { kind: "HOME_PATH_USER", re: /(?:\/Users\/|\/home\/|C:\\Users\\)([A-Za-z0-9._-]+)/g, group: 1 },
];

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl && (d *= 2) > 9) d -= 9;
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export class Redactor {
  private byOriginal = new Map<string, Redaction>();
  private counters = new Map<string, number>();

  get redactions(): Redaction[] {
    return [...this.byOriginal.values()];
  }

  /** Stable placeholder: the same secret always maps to the same token. */
  private placeholderFor(kind: string, original: string, by: Redaction["by"]): string {
    const existing = this.byOriginal.get(original);
    if (existing) return existing.placeholder;
    const n = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, n);
    const placeholder = `[${kind}_${n}]`;
    this.byOriginal.set(original, { kind, original, placeholder, by });
    return placeholder;
  }

  applyRules(text: string): string {
    let out = text;
    for (const rule of RULES) {
      out = outsidePlaceholders(out, (seg) => seg.replace(rule.re, (match, ...groups) => {
        const g = rule.group ?? 0;
        const secret = g === 0 ? match : (groups[g - 1] as string | undefined);
        if (!secret || secret.startsWith("[")) return match;
        if (rule.kind === "CREDIT_CARD" && !luhn(secret.replace(/\D/g, ""))) return match;
        const ph = this.placeholderFor(rule.kind, secret, "rule");
        return g === 0 ? ph : match.replace(secret, ph);
      }));
    }
    return out;
  }

  /**
   * Apply literal strings flagged by the on-device model (or selected by the
   * user). Never rewrites text inside an existing placeholder.
   */
  applyLiterals(text: string, items: { kind: string; value: string }[], by: Redaction["by"] = "on_device"): string {
    let out = text;
    // Longest first so substrings don't break longer matches.
    for (const { kind, value } of [...items].sort((a, b) => b.value.length - a.value.length)) {
      const v = value.trim();
      if (v.length < 3 || isPlaceholderish(v) || PLACEHOLDER.test(v)) continue;
      if (!outsidePlaceholderText(out).includes(v)) continue;
      const ph = this.placeholderFor(kind.toUpperCase().replace(/[^A-Z_]/g, "_") || "PII", v, by);
      out = outsidePlaceholders(out, (seg) => seg.split(v).join(ph));
    }
    return out;
  }
}

/** Run fn only on the text between placeholders, leaving placeholders intact. */
function outsidePlaceholders(text: string, fn: (segment: string) => string): string {
  return text
    .split(PLACEHOLDER)
    .map((seg, i) => (i % 2 === 1 ? seg : fn(seg)))
    .join("");
}

function outsidePlaceholderText(text: string): string {
  return text.split(PLACEHOLDER).filter((_, i) => i % 2 === 0).join("\u0000");
}
