import Foundation
import Network
import Observation
import FirebaseFirestore

struct RunState {
    var id: String? = nil
    var steps: [StepLog] = []
    var sanitized = ""
    var redactions: [Redaction] = []
    var triage: Triage? = nil
    var analysis = ""
    var pending: String? = nil
    var error: String? = nil
    /// Waiting for the user to approve what leaves the device.
    var review = false
}

@MainActor
@Observable
final class AppModel {
    var uid: String?
    var device: DeviceStatus = .unavailable
    var mode: ProcessingMode
    var config = RoutingConfig()
    var input = ""
    var run = RunState()
    var history: [TraceDoc] = []
    var online = true
    var refreshing = false
    var cloudLeft = userDailyLimit

    @ObservationIgnored private var redactor: Redactor?
    @ObservationIgnored private var historyReg: ListenerRegistration?
    @ObservationIgnored private var quotaReg: ListenerRegistration?
    @ObservationIgnored private var configLoaded = false
    @ObservationIgnored private let monitor = NWPathMonitor()

    init() {
        let saved = UserDefaults.standard.string(forKey: "mode").flatMap(ProcessingMode.init(rawValue:))
        mode = saved ?? .hybrid
        // Apple's availability check can take seconds on first launch: keep it off the main thread.
        Task {
            let device = await Task.detached { Pipeline.deviceStatus() }.value
            self.device = device
            if saved == nil { self.mode = device == .available ? .hybrid : .cloud }
            else if saved == .private && device != .available { self.mode = .hybrid }
            #if DEBUG
            // Test hook for headless simulator runs: TL_AUTORUN=<sample index> [TL_MODE=cloud|hybrid|private]
            let env = ProcessInfo.processInfo.environment
            if let m = env["TL_MODE"].flatMap(ProcessingMode.init(rawValue:)) { self.mode = m }
            if let i = env["TL_AUTORUN"].flatMap(Int.init), samples.indices.contains(i) {
                self.input = samples[i].1
                while self.uid == nil { try? await Task.sleep(for: .milliseconds(300)) }
                self.analyze()
                if env["TL_AUTOSEND"] != nil {
                    while !self.run.review && self.run.pending != nil { try? await Task.sleep(for: .milliseconds(300)) }
                    if self.run.review { self.approveAndSend() }
                }
            }
            #endif
        }
        // Reconnect automatically when the network comes back.
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor in
                guard let self else { return }
                let wasOffline = !self.online
                self.online = path.status == .satisfied
                if self.online && (wasOffline || self.uid == nil) { self.refresh() }
            }
        }
        monitor.start(queue: DispatchQueue(label: "net"))
        refresh()
    }

    func setMode(_ m: ProcessingMode) {
        mode = m
        UserDefaults.standard.set(m.rawValue, forKey: "mode")
    }

    /// (Re)connect: sign in, attach listeners, fetch Remote Config, re-check Apple Intelligence.
    func refresh() {
        guard !refreshing else { return }
        refreshing = true
        Task {
            defer { refreshing = false }
            device = await Task.detached { Pipeline.deviceStatus() }.value
            if !configLoaded {
                config = await Store.loadConfig()
                configLoaded = true
            }
            do {
                if uid == nil { uid = try await Store.ensureSignedIn() }
                if let uid, historyReg == nil {
                    historyReg = Store.watch(uid: uid) { [weak self] docs in
                        Task { @MainActor in self?.history = docs }
                    }
                }
                if let uid, quotaReg == nil {
                    quotaReg = Quota.watchRemaining(uid: uid) { [weak self] left in
                        Task { @MainActor in self?.cloudLeft = left }
                    }
                }
                if run.pending == nil { run.error = nil }
            } catch {
                run.error = online
                    ? "Couldn't connect to Firebase: \(error.localizedDescription)"
                    : "You're offline. Turn on Wi-Fi or mobile data, then tap Retry."
            }
        }
    }

    // MARK: Pipeline

    func analyze() {
        guard uid != nil, run.pending == nil else { return }
        let raw = input.trimmingCharacters(in: .whitespacesAndNewlines)
        run = RunState(pending: "Starting…")
        Task {
            do {
                device = await Task.detached { Pipeline.deviceStatus() }.value
                if mode == .private && device != .available {
                    throw AppError("Private mode needs Apple Intelligence on this device. Switch to Hybrid or Cloud mode.")
                }
                guard !raw.isEmpty else { throw AppError("Paste a stack trace or log first.") }
                guard looksLikeError(raw) else {
                    throw AppError("That doesn't look like an error, stack trace or log. Paste the failing output (or try a sample).")
                }
                let nano = device == .available && mode != .cloud
                run.pending = nano ? "Redacting on-device…" : "Redacting with local rules…"
                let red = await Pipeline.redact(raw, device: device, mode: mode)
                redactor = red.redactor
                run.sanitized = red.sanitized
                run.redactions = red.redactor.redactions
                run.steps = red.logs
                if !nano || !red.modelRan {
                    if mode == .private { throw AppError("Apple Intelligence couldn't redact this trace, and Private mode never uses the cloud.") }
                    // Only rules ran and the next step may be the cloud: let the user check first.
                    run.pending = nil
                    run.review = true
                    return
                }
                await triageAndSave()
            } catch {
                run.pending = nil
                run.error = error.localizedDescription
            }
        }
    }

    func approveAndSend() { Task { await triageAndSave() } }

    func cancelReview() { run = RunState() }

    /// Review step: hide the selected text everywhere in the sanitized trace.
    func hide(_ value: String) {
        guard let r = redactor else { return }
        run.sanitized = r.applyLiterals(run.sanitized, [(kind: "HIDDEN", value: value)], by: "user")
        run.redactions = r.redactions
    }

    private func triageAndSave() async {
        guard let uid else { return }
        run.review = false
        run.error = nil
        run.pending = "Triaging…"
        do {
            // Count cloud calls only; Apple Intelligence on-device is free and unmetered.
            let cloudPlanned = Pipeline.triageNeedsCloud(run.sanitized, device: device, mode: mode, cfg: config)
            if cloudPlanned { try await Quota.consume(uid: uid) }
            let (tri, log) = try await Pipeline.triage(run.sanitized, device: device, mode: mode, cfg: config)
            if !cloudPlanned && log.source == .inCloud { try? await Quota.consume(uid: uid) }
            run.steps.append(log)
            run.pending = nil
            tl("triage via \(log.source.rawValue) in \(log.ms)ms: \(tri.errorType) / \(tri.language) conf=\(tri.confidence)")
            guard tri.isError else { throw AppError("The model didn't find an error in this input, so nothing was saved.") }
            run.triage = tri
            run.id = try await Store.save(uid: uid, sanitized: run.sanitized, triage: tri, steps: run.steps, redactions: run.redactions)
            if mode != .private && config.autoEscalate && tri.confidence < config.escalateBelowConfidence {
                await deepDive()
            }
        } catch {
            run.pending = nil
            run.error = error.localizedDescription
            tl("triageAndSave error: \(error)")
        }
    }

    func startDeepDive() { Task { await deepDive() } }

    private func deepDive() async {
        guard mode != .private else {
            run.error = "Private mode: nothing is sent to the cloud. Switch to Hybrid for a deep dive."
            return
        }
        run.pending = "Deep dive in the cloud (sanitized trace only)…"
        run.analysis = ""
        run.error = nil
        let t = Date()
        do {
            if let uid { try await Quota.consume(uid: uid) }
            for try await text in Pipeline.deepDive(run.sanitized, triage: run.triage, cfg: config) {
                run.analysis = text
            }
            run.steps.removeAll { $0.step == "deep" }
            run.steps.append(StepLog(step: "deep", source: .inCloud, ms: Int(Date().timeIntervalSince(t) * 1000)))
            run.pending = nil
            tl("deep dive done, \(run.analysis.count) chars")
            if let uid, let id = run.id {
                try await Store.saveAnalysis(uid: uid, id: id, analysis: run.analysis, steps: run.steps)
            }
        } catch {
            run.pending = nil
            run.error = "Deep dive failed: \(error.localizedDescription)"
            tl("deep dive error: \(error)")
        }
    }

    func open(_ d: TraceDoc) {
        run = RunState(id: d.id, steps: d.steps, sanitized: d.sanitized, triage: d.triage, analysis: d.analysis ?? "")
    }

    func delete(_ d: TraceDoc) {
        if let uid { Store.delete(uid: uid, id: d.id) }
    }
}
