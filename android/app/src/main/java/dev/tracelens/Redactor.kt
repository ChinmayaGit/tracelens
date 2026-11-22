package dev.tracelens

/**
 * Deterministic, model-free redaction (port of web/src/lib/redact.ts).
 * Runs first and always, so secrets never depend on a model being present.
 * The on-device model then catches contextual leftovers.
 */
data class Redaction(val kind: String, val original: String, val placeholder: String, val by: String)

private data class Rule(val kind: String, val re: Regex, val group: Int = 0)

private val RULES = listOf(
    Rule("PRIVATE_KEY", Regex("-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]+?-----END [A-Z ]*PRIVATE KEY-----")),
    Rule("JWT", Regex("\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\b")),
    Rule("AWS_KEY", Regex("\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b")),
    Rule("GOOGLE_API_KEY", Regex("\\bAIza[0-9A-Za-z_-]{35}\\b")),
    Rule("GITHUB_TOKEN", Regex("\\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\\b")),
    Rule("SLACK_TOKEN", Regex("\\bxox[abprs]-[A-Za-z0-9-]{10,}\\b")),
    Rule("STRIPE_KEY", Regex("\\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\\b")),
    Rule("API_KEY", Regex("\\bsk-[A-Za-z0-9_-]{20,}\\b")),
    Rule("BEARER", Regex("\\b[Bb]earer\\s+([A-Za-z0-9._~+/=-]{16,})"), 1),
    Rule("URL_CREDENTIALS", Regex("\\b[a-zA-Z][a-zA-Z0-9+.-]*://[^\\s:/@]+:([^\\s@/]+)@"), 1),
    Rule(
        "SECRET_ASSIGNMENT",
        Regex(
            "\\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\\b[\"']?\\s*[:=]\\s*[\"']?([^\\s\"',;}{]{6,})",
            RegexOption.IGNORE_CASE,
        ),
        1,
    ),
    Rule("EMAIL", Regex("\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b")),
    Rule("CREDIT_CARD", Regex("\\b(?:\\d[ -]?){13,16}\\b")),
    Rule("PHONE", Regex("(?<![\\w.])(?:\\+\\d{1,3}[\\s.-]?)?\\(?\\d{2,4}\\)?[\\s.-]\\d{3,4}[\\s.-]\\d{3,4}(?![\\w.])")),
    Rule(
        "PERSON",
        Regex(
            "\\b(?:name|rider|driver|user|customer|patient|employee|client|owner|author|contact|recipient|sender)\\b[\"']?\\s*[:=]?\\s*[\"']?([A-Z][a-z]+(?:\\s[A-Z][a-z'-]+){1,2})\\b",
        ),
        1,
    ),
    Rule(
        "IPV4",
        Regex("\\b(?!127\\.0\\.0\\.1\\b)(?!0\\.0\\.0\\.0\\b)(?:(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\b"),
    ),
    Rule("HOME_PATH_USER", Regex("(?:/Users/|/home/|C:\\\\Users\\\\)([A-Za-z0-9._-]+)"), 1),
)

private val PLACEHOLDER = Regex("\\[[A-Z_]+_\\d+]")
private val PLACEHOLDERISH = Regex("^\\[*[A-Z_]+_\\d+]*$")

private fun luhn(digits: String): Boolean {
    var sum = 0
    var dbl = false
    for (i in digits.indices.reversed()) {
        var d = digits[i] - '0'
        if (dbl) {
            d *= 2
            if (d > 9) d -= 9
        }
        sum += d
        dbl = !dbl
    }
    return sum % 10 == 0
}

/** Apply [fn] only to text between placeholders, leaving placeholders intact. */
private fun outsidePlaceholders(text: String, fn: (String) -> String): String {
    val sb = StringBuilder()
    var last = 0
    for (m in PLACEHOLDER.findAll(text)) {
        sb.append(fn(text.substring(last, m.range.first)))
        sb.append(m.value)
        last = m.range.last + 1
    }
    sb.append(fn(text.substring(last)))
    return sb.toString()
}

class Redactor {
    private val byOriginal = LinkedHashMap<String, Redaction>()
    private val counters = HashMap<String, Int>()

    val redactions: List<Redaction> get() = byOriginal.values.toList()

    private fun placeholderFor(kind: String, original: String, by: String): String {
        byOriginal[original]?.let { return it.placeholder }
        val n = (counters[kind] ?: 0) + 1
        counters[kind] = n
        val ph = "[${kind}_$n]"
        byOriginal[original] = Redaction(kind, original, ph, by)
        return ph
    }

    fun applyRules(text: String): String {
        var out = text
        for (rule in RULES) {
            out = outsidePlaceholders(out) { seg ->
                rule.re.replace(seg) { m ->
                    val secret = if (rule.group == 0) m.value else m.groups[rule.group]?.value
                    when {
                        secret.isNullOrEmpty() || secret.startsWith("[") -> m.value
                        rule.kind == "CREDIT_CARD" && !luhn(secret.filter { it.isDigit() }) -> m.value
                        else -> {
                            val ph = placeholderFor(rule.kind, secret, "rule")
                            if (rule.group == 0) ph else m.value.replace(secret, ph)
                        }
                    }
                }
            }
        }
        return out
    }

    /** Literal strings flagged by the on-device model or chosen by the user. */
    fun applyLiterals(text: String, items: List<Pair<String, String>>, by: String = "on_device"): String {
        var out = text
        for ((kind, value) in items.sortedByDescending { it.second.length }) {
            val v = value.trim()
            if (v.length < 3 || PLACEHOLDERISH.matches(v) || PLACEHOLDER.containsMatchIn(v)) continue
            val free = PLACEHOLDER.split(out).joinToString("\u0000")
            if (!free.contains(v)) continue
            val k = kind.uppercase().replace(Regex("[^A-Z_]"), "_").ifEmpty { "PII" }
            val ph = placeholderFor(k, v, by)
            out = outsidePlaceholders(out) { it.replace(v, ph) }
        }
        return out
    }
}

private val ERROR_HINT = Regex(
    "(error|exception|traceback|fatal|failed|failure|panic|crash|segfault|errno|denied|refused|timeout|timed out|" +
        "undefined|null|cannot|can't|unable|invalid|unexpected|warn|\\bat\\s+[\\w$.<>]+\\s*\\(|line \\d+|:\\d+:\\d+|" +
        "exit code|status \\d{3}|\\b[45]\\d\\d\\b|[EWF]/\\w+)",
    RegexOption.IGNORE_CASE,
)

/** Cheap local check so obvious non-errors never reach a model. */
fun looksLikeError(text: String) = text.trim().length >= 12 && ERROR_HINT.containsMatchIn(text)
