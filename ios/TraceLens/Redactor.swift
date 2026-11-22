import Foundation

/// Deterministic, model-free redaction (port of web/src/lib/redact.ts).
/// Runs first and always, so secrets never depend on a model being present.
struct Redaction: Identifiable, Hashable {
    let kind: String
    let original: String
    let placeholder: String
    let by: String // "rule" | "on_device" | "user"
    var id: String { placeholder }
}

private struct Rule {
    let kind: String
    let re: NSRegularExpression
    let group: Int
    init(_ kind: String, _ pattern: String, group: Int = 0, caseInsensitive: Bool = false) {
        self.kind = kind
        self.re = try! NSRegularExpression(pattern: pattern, options: caseInsensitive ? [.caseInsensitive] : [])
        self.group = group
    }
}

private let rules: [Rule] = [
    Rule("PRIVATE_KEY", #"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----"#),
    Rule("JWT", #"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"#),
    Rule("AWS_KEY", #"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"#),
    Rule("GOOGLE_API_KEY", #"\bAIza[0-9A-Za-z_-]{35}\b"#),
    Rule("GITHUB_TOKEN", #"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b"#),
    Rule("SLACK_TOKEN", #"\bxox[abprs]-[A-Za-z0-9-]{10,}\b"#),
    Rule("STRIPE_KEY", #"\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b"#),
    Rule("API_KEY", #"\bsk-[A-Za-z0-9_-]{20,}\b"#),
    Rule("BEARER", #"\b[Bb]earer\s+([A-Za-z0-9._~+/=-]{16,})"#, group: 1),
    Rule("URL_CREDENTIALS", #"\b[a-zA-Z][a-zA-Z0-9+.-]*://[^\s:/@]+:([^\s@/]+)@"#, group: 1),
    Rule("SECRET_ASSIGNMENT",
         #"\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\b["']?\s*[:=]\s*["']?([^\s"',;}{]{6,})"#,
         group: 1, caseInsensitive: true),
    Rule("EMAIL", #"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"#),
    Rule("CREDIT_CARD", #"\b(?:\d[ -]?){13,16}\b"#),
    Rule("PHONE", #"(?<![\w.])(?:\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]\d{3,4}[\s.-]\d{3,4}(?![\w.])"#),
    Rule("PERSON",
         #"\b(?:name|rider|driver|user|customer|patient|employee|client|owner|author|contact|recipient|sender)\b["']?\s*[:=]?\s*["']?([A-Z][a-z]+(?:\s[A-Z][a-z'-]+){1,2})\b"#,
         group: 1),
    Rule("IPV4", #"\b(?!127\.0\.0\.1\b)(?!0\.0\.0\.0\b)(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b"#),
    Rule("HOME_PATH_USER", #"(?:/Users/|/home/|C:\\Users\\)([A-Za-z0-9._-]+)"#, group: 1),
]

private let placeholderRe = try! NSRegularExpression(pattern: #"\[[A-Z_]+_\d+\]"#)
private let placeholderishRe = try! NSRegularExpression(pattern: #"^\[*[A-Z_]+_\d+\]*$"#)

private func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
    re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
}

private func luhn(_ digits: String) -> Bool {
    var sum = 0, dbl = false
    for ch in digits.reversed() {
        guard var d = ch.wholeNumberValue else { return false }
        if dbl { d *= 2; if d > 9 { d -= 9 } }
        sum += d
        dbl.toggle()
    }
    return sum % 10 == 0
}

/// Apply `fn` only to text between placeholders, leaving placeholders intact.
private func outsidePlaceholders(_ text: String, _ fn: (String) -> String) -> String {
    var out = ""
    var last = text.startIndex
    for m in placeholderRe.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
        let r = Range(m.range, in: text)!
        out += fn(String(text[last..<r.lowerBound]))
        out += text[r]
        last = r.upperBound
    }
    out += fn(String(text[last...]))
    return out
}

final class Redactor {
    private var byOriginal: [String: Redaction] = [:]
    private var order: [String] = []
    private var counters: [String: Int] = [:]

    var redactions: [Redaction] { order.compactMap { byOriginal[$0] } }

    private func placeholder(_ kind: String, _ original: String, by: String) -> String {
        if let r = byOriginal[original] { return r.placeholder }
        let n = (counters[kind] ?? 0) + 1
        counters[kind] = n
        let ph = "[\(kind)_\(n)]"
        byOriginal[original] = Redaction(kind: kind, original: original, placeholder: ph, by: by)
        order.append(original)
        return ph
    }

    func applyRules(_ text: String) -> String {
        var out = text
        for rule in rules {
            out = outsidePlaceholders(out) { seg in
                var result = ""
                var last = seg.startIndex
                for m in rule.re.matches(in: seg, range: NSRange(seg.startIndex..., in: seg)) {
                    guard let whole = Range(m.range, in: seg) else { continue }
                    let gRange = rule.group == 0 ? whole : Range(m.range(at: rule.group), in: seg)
                    result += seg[last..<whole.lowerBound]
                    last = whole.upperBound
                    guard let g = gRange else { result += seg[whole]; continue }
                    let secret = String(seg[g])
                    if secret.isEmpty || secret.hasPrefix("[")
                        || (rule.kind == "CREDIT_CARD" && !luhn(secret.filter(\.isNumber))) {
                        result += seg[whole]
                        continue
                    }
                    let ph = placeholder(rule.kind, secret, by: "rule")
                    result += seg[whole.lowerBound..<g.lowerBound] + ph + seg[g.upperBound..<whole.upperBound]
                }
                result += seg[last...]
                return result
            }
        }
        return out
    }

    /// Literal strings flagged by the on-device model or selected by the user.
    func applyLiterals(_ text: String, _ items: [(kind: String, value: String)], by: String = "on_device") -> String {
        var out = text
        for item in items.sorted(by: { $0.value.count > $1.value.count }) {
            let v = item.value.trimmingCharacters(in: .whitespacesAndNewlines)
            if v.count < 3 || matches(placeholderishRe, v) || matches(placeholderRe, v) { continue }
            let free = placeholderRe.stringByReplacingMatches(
                in: out, range: NSRange(out.startIndex..., in: out), withTemplate: "\u{0}")
            if !free.contains(v) { continue }
            var kind = item.kind.uppercased().replacingOccurrences(of: #"[^A-Z_]"#, with: "_", options: .regularExpression)
            if kind.isEmpty { kind = "PII" }
            let ph = placeholder(kind, v, by: by)
            out = outsidePlaceholders(out) { $0.replacingOccurrences(of: v, with: ph) }
        }
        return out
    }
}

private let errorHint = try! NSRegularExpression(
    pattern: #"(error|exception|traceback|fatal|failed|failure|panic|crash|segfault|errno|denied|refused|timeout|timed out|undefined|null|nil|cannot|can't|unable|invalid|unexpected|warn|\bat\s+[\w$.<>]+\s*\(|line \d+|:\d+:\d+|exit code|status \d{3}|\b[45]\d\d\b|[EWF]/\w+)"#,
    options: [.caseInsensitive])

/// Cheap local check so obvious non-errors never reach a model.
func looksLikeError(_ text: String) -> Bool {
    text.trimmingCharacters(in: .whitespacesAndNewlines).count >= 12 && matches(errorHint, text)
}

import os
/// App log (visible in Console.app / `log stream --predicate 'subsystem == "dev.tracelens"'`).
let tlLog = Logger(subsystem: "dev.tracelens", category: "pipeline")
func tl(_ s: String) { tlLog.notice("\(s, privacy: .public)") }
