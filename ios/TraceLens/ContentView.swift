import SwiftUI

private let brand = Color(red: 0.43, green: 0.30, blue: 1.0)
private let deviceGreen = Color(red: 0.09, green: 0.64, blue: 0.29)
private let cloudBlue = Color(red: 0.15, green: 0.39, blue: 0.92)
private let rulesPurple = Color(red: 0.49, green: 0.23, blue: 0.93)
private let warn = Color(red: 0.85, green: 0.47, blue: 0.02)
private let bad = Color(red: 0.86, green: 0.15, blue: 0.15)

private func color(_ s: StepSource) -> Color {
    switch s {
    case .onDevice: deviceGreen
    case .inCloud: cloudBlue
    case .localRules: rulesPurple
    case .skipped: .gray
    }
}

private func sevColor(_ s: String) -> Color {
    switch s { case "low": deviceGreen; case "medium": warn; default: bad }
}

/// Placeholders like [AWS_KEY_1] highlighted.
private func highlighted(_ text: String) -> AttributedString {
    var out = AttributedString(text)
    var search = out.startIndex
    while let r = out[search...].range(of: #"\[[A-Z_]+_\d+\]"#, options: .regularExpression) {
        out[r].backgroundColor = Color.yellow.opacity(0.35)
        out[r].font = .system(.caption, design: .monospaced).weight(.semibold)
        search = r.upperBound
    }
    return out
}

struct Badge: View {
    let text: String
    let color: Color
    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(color.opacity(0.14), in: Capsule())
    }
}

struct Card<Content: View>: View {
    var title: String? = nil
    var accent: Color? = nil
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let title { Text(title).font(.headline) }
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 14))
        .overlay {
            if let accent { RoundedRectangle(cornerRadius: 14).stroke(accent, lineWidth: 1.5) }
        }
    }
}

struct ContentView: View {
    @State private var model = AppModel()

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    modeCard
                    stats
                    inputCard
                    if !model.online {
                        banner("Offline: on-device steps still work; cloud steps resume when you reconnect.", warn)
                    }
                    if let e = model.run.error { errorBanner(e) }
                    if !model.run.steps.isEmpty || model.run.pending != nil { pipeline }
                    if model.run.review { ReviewCard(model: model) }
                    if let t = model.run.triage { triageCard(t) }
                    if !model.run.analysis.isEmpty {
                        Card(title: "Root-cause analysis") { MarkdownView(markdown: model.run.analysis) }
                    }
                    if !model.run.sanitized.isEmpty && !model.run.review { sanitizedCard }
                    historySection
                    Text("Firebase AI Logic + Apple Foundation Models · cloud model \(model.config.cloudModel)")
                        .font(.caption2).foregroundStyle(.secondary).padding(.vertical, 12)
                }
                .padding(16)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("TraceLens")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { devicePill }
            }
        }
    }

    // MARK: Header

    private var devicePill: some View {
        let (label, c): (String, Color) = switch model.device {
        case .available: ("Apple Intelligence ready", deviceGreen)
        case .notEnabled: ("Apple Intelligence off", warn)
        case .downloading: ("Model downloading…", warn)
        case .unavailable: ("No on-device AI", .gray)
        }
        return Badge(text: label, color: c)
    }

    private var modeCard: some View {
        Card(title: "Processing mode") {
            Picker("Mode", selection: Binding(get: { model.mode }, set: { model.setMode($0) })) {
                ForEach(ProcessingMode.allCases) { m in
                    Text(m.label).tag(m)
                        .disabled(m == .private && model.device != .available)
                }
            }
            .pickerStyle(.segmented)
            Text(model.mode.detail).font(.caption).foregroundStyle(.secondary)
            switch model.device {
            case .notEnabled where model.mode != .cloud:
                banner("Turn on Apple Intelligence in Settings to analyze privately on this device. Until then, TraceLens uses the cloud with local redaction and a review step.", warn)
            case .downloading where model.mode != .cloud:
                banner("Apple Intelligence is still downloading its model. AI steps use the cloud until it's ready.", warn)
            case .unavailable where model.mode != .cloud:
                banner("This device can't run Apple Intelligence. TraceLens uses the cloud with local rule-based redaction and asks you to review before sending.", warn)
            default: EmptyView()
            }
        }
    }

    private var stats: some View {
        var ai = 0, local = 0, secrets = 0
        for d in model.history {
            secrets += d.redactionTotal
            for s in d.steps where s.source == .onDevice || s.source == .inCloud {
                ai += 1
                if s.source == .onDevice { local += 1 }
            }
        }
        let pct = ai > 0 ? local * 100 / ai : 0
        return HStack(spacing: 8) {
            stat("\(model.history.count)", "traces")
            stat("\(secrets)", "secrets kept local")
            stat("\(pct)%", "AI steps on-device")
        }
    }

    private func stat(_ v: String, _ l: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(v).font(.title2.bold())
            Text(l).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
    }

    // MARK: Input

    private var inputCard: some View {
        Card(title: "Paste an error, stack trace or log") {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack {
                    ForEach(samples, id: \.0) { s in
                        Button(s.0) { model.input = s.1 }.buttonStyle(.bordered).font(.caption)
                    }
                }
            }
            TextEditor(text: $model.input)
                .font(.system(.caption, design: .monospaced))
                .frame(minHeight: 140, maxHeight: 240)
                .scrollContentBackground(.hidden)
                .padding(6)
                .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10))
                .overlay(alignment: .topLeading) {
                    if model.input.isEmpty {
                        Text("Paste text, or try a sample…").font(.caption).foregroundStyle(.secondary).padding(12)
                            .allowsHitTesting(false)
                    }
                }
            HStack {
                Button { if let s = UIPasteboard.general.string { model.input = s } } label: {
                    Image(systemName: "doc.on.clipboard")
                }
                if !model.input.isEmpty {
                    Button { model.input = "" } label: { Image(systemName: "xmark.circle") }
                }
                Spacer()
                Text("\(model.cloudLeft)/\(userDailyLimit) cloud left").font(.caption2).foregroundStyle(.secondary)
                Button(model.run.pending != nil ? "Working…" : "Analyze privately") { model.analyze() }
                    .buttonStyle(.borderedProminent).tint(brand)
                    .disabled(model.uid == nil || model.run.pending != nil || model.input.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }

    // MARK: Results

    private var pipeline: some View {
        Card(title: "Pipeline") {
            ForEach(model.run.steps) { s in
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(s.title).font(.subheadline.weight(.medium))
                        Spacer()
                        Badge(text: s.source.label, color: color(s.source))
                        if s.source != .skipped { Text("\(s.ms) ms").font(.caption).foregroundStyle(.secondary) }
                    }
                    if let n = s.note { Text(n).font(.caption2).foregroundStyle(.secondary) }
                }
            }
            if let p = model.run.pending {
                HStack { ProgressView().controlSize(.small); Text(p).font(.subheadline).foregroundStyle(.secondary) }
            }
        }
    }

    private func triageCard(_ t: Triage) -> some View {
        Card(accent: sevColor(t.severity)) {
            HStack(alignment: .top) {
                VStack(alignment: .leading) {
                    Text(t.errorType).font(.headline)
                    Text(t.language).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Badge(text: t.severity.uppercased(), color: sevColor(t.severity))
            }
            Text(t.summary)
            Text("Likely cause").font(.caption).foregroundStyle(.secondary)
            Text(t.likelyCause).font(.subheadline)
            Text("Quick fix").font(.caption).foregroundStyle(.secondary)
            Text(t.quickFix).font(.subheadline)
            let pct = Int(t.confidence * 100)
            ProgressView(value: t.confidence).tint(pct >= 75 ? deviceGreen : pct >= 50 ? warn : bad)
            Text("\(pct)% confident").font(.caption)
            if model.run.analysis.isEmpty && model.run.pending == nil && model.mode != .private {
                Button("Deep dive in cloud →") { model.startDeepDive() }.buttonStyle(.borderedProminent).tint(brand)
            }
        }
    }

    private var sanitizedCard: some View {
        Card(title: "What the cloud sees") {
            Text(highlighted(model.run.sanitized))
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10))
            if !model.run.redactions.isEmpty {
                Text("Kept on this device").font(.subheadline.weight(.semibold))
                RedactionList(items: model.run.redactions)
            }
        }
    }

    private var historySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("History").font(.title3.bold()).padding(.top, 8)
            if model.history.isEmpty {
                Text("No traces yet. Try a sample.").foregroundStyle(.secondary)
            }
            ForEach(model.history) { d in
                HStack {
                    Circle().fill(sevColor(d.triage?.severity ?? "low")).frame(width: 8, height: 8)
                    VStack(alignment: .leading) {
                        Text(d.title).lineLimit(1)
                        Text("\(d.redactionTotal) redacted · \(d.platform)").font(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button { model.delete(d) } label: { Image(systemName: "xmark") }.foregroundStyle(.secondary)
                }
                .padding(12)
                .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
                .contentShape(Rectangle())
                .onTapGesture { model.open(d) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Banners

    private func banner(_ text: String, _ c: Color) -> some View {
        Text(text).font(.subheadline).foregroundStyle(c)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(c.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
    }

    private func errorBanner(_ text: String) -> some View {
        HStack {
            Text(text).font(.subheadline).foregroundStyle(bad)
            Spacer()
            if model.refreshing {
                ProgressView().controlSize(.small)
            } else {
                Button { model.refresh() } label: { Label("Retry", systemImage: "arrow.clockwise") }
                    .tint(bad).font(.subheadline.weight(.semibold))
            }
        }
        .padding(12)
        .background(bad.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
    }
}

/// Review before cloud: select any text in the sanitized trace to hide it.
struct ReviewCard: View {
    @Bindable var model: AppModel
    @State private var selection: TextSelection?

    private var selected: String {
        guard let sel = selection, case .selection(let range) = sel.indices,
              range.lowerBound >= model.run.sanitized.startIndex, range.upperBound <= model.run.sanitized.endIndex
        else { return "" }
        return String(model.run.sanitized[range]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        Card(title: "Review before sending to the cloud", accent: warn) {
            Text("Apple Intelligence isn't running here, so only the rules removed secrets. Select any name, ID or hostname below to hide it, then send.")
                .font(.subheadline).foregroundStyle(warn)
            TextEditor(text: Binding(get: { model.run.sanitized }, set: { _ in }), selection: $selection)
                .font(.system(.caption, design: .monospaced))
                .frame(minHeight: 180)
                .scrollContentBackground(.hidden)
                .padding(6)
                .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10))
            HStack {
                let s = selected
                Button(s.isEmpty ? "Select text to hide" : "Hide “\(s.prefix(18))\(s.count > 18 ? "…" : "")”") {
                    model.hide(s)
                    selection = nil
                }
                .buttonStyle(.bordered).disabled(s.isEmpty)
                Button("Send →") { model.approveAndSend() }.buttonStyle(.borderedProminent).tint(brand)
                Button("Cancel") { model.cancelReview() }
            }
            if !model.run.redactions.isEmpty { RedactionList(items: model.run.redactions) }
        }
    }
}

struct RedactionList: View {
    let items: [Redaction]
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(items) { r in
                HStack {
                    Text(r.placeholder).font(.system(.caption2, design: .monospaced))
                        .padding(.horizontal, 3).background(Color.yellow.opacity(0.35))
                    Text(r.original.count > 6 ? "\(r.original.prefix(3))•••\(r.original.suffix(2))" : "•••")
                        .font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary)
                    Spacer()
                    switch r.by {
                    case "rule": Badge(text: "rule", color: rulesPurple)
                    case "user": Badge(text: "you", color: warn)
                    default: Badge(text: "Apple Intelligence", color: deviceGreen)
                    }
                }
            }
        }
    }
}

/// Minimal Markdown: ## headings, fenced code, bullets, inline **bold**/`code`.
struct MarkdownView: View {
    let markdown: String

    private enum Block: Hashable { case heading(String), code(String), text(String) }

    private var blocks: [Block] {
        var out: [Block] = []
        var code: [String] = []
        var inCode = false
        for line in markdown.components(separatedBy: "\n") {
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                if inCode { out.append(.code(code.joined(separator: "\n"))); code = [] }
                inCode.toggle()
                continue
            }
            if inCode { code.append(line); continue }
            if line.hasPrefix("#") { out.append(.heading(line.trimmingCharacters(in: CharacterSet(charactersIn: "# ")))) }
            else if !line.trimmingCharacters(in: .whitespaces).isEmpty {
                out.append(.text(line.replacingOccurrences(of: #"^\s*[-*] "#, with: "• ", options: .regularExpression)))
            }
        }
        if inCode, !code.isEmpty { out.append(.code(code.joined(separator: "\n"))) }
        return out
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, b in
                switch b {
                case .heading(let s): Text(s).font(.headline).padding(.top, 6)
                case .code(let s):
                    ScrollView(.horizontal) {
                        Text(s).font(.system(.caption2, design: .monospaced)).padding(8)
                    }
                    .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8))
                case .text(let s):
                    Text((try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s))
                        .font(.subheadline)
                }
            }
        }
    }
}
