import Foundation

/// Local-network inference: a more powerful machine on your Wi-Fi (Ollama) does the work.
/// Data never leaves your network, so it's treated like on-device.
/// On the server: `OLLAMA_HOST=0.0.0.0 ollama serve`, then `ollama pull qwen2.5-coder:7b`.
struct LanConfig: Codable, Equatable {
    var url = "http://192.168.1.10:11434"
    var model = ""
    /// Memory-map weights from disk, smaller context, unload after 1 min idle.
    var memorySaver = true
}

struct LanModel: Identifiable, Hashable {
    let name: String
    let params: String
    let sizeGb: Double
    let minRamGb: Int
    var id: String { name }
}

struct LanStatus: Equatable {
    var online: Bool
    var models: [LanModel] = []
    var error: String? = nil
}

let recommendedLanModels: [(name: String, ram: Int, note: String)] = [
    ("llama3.2:3b", 4, "fast, fine for triage on laptops"),
    ("gemma3:4b", 6, "good all-rounder"),
    ("qwen2.5-coder:7b", 8, "best code reasoning per GB"),
    ("gemma3:12b", 12, "stronger root-cause analysis"),
    ("qwen2.5-coder:32b", 24, "near-cloud quality; desktop GPU / 32 GB Mac"),
]

enum Lan {
    private static func base(_ url: String) -> String {
        var u = url.trimmingCharacters(in: .whitespaces)
        while u.hasSuffix("/") { u.removeLast() }
        return u
    }

    static func status(_ url: String) async -> LanStatus {
        guard let u = URL(string: base(url) + "/api/tags") else { return LanStatus(online: false, error: "bad address") }
        var req = URLRequest(url: u)
        req.timeoutInterval = 2.5
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard (resp as? HTTPURLResponse)?.statusCode == 200 else { return LanStatus(online: false, error: "bad response") }
            let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            let models = (obj?["models"] as? [[String: Any]] ?? []).map { m -> LanModel in
                let size = (m["size"] as? NSNumber)?.doubleValue ?? 0
                return LanModel(
                    name: m["name"] as? String ?? "?",
                    params: (m["details"] as? [String: Any])?["parameter_size"] as? String ?? "",
                    sizeGb: (size / 1e8).rounded() / 10,
                    minRamGb: Int((size / 1e9 + 1.5).rounded(.up)))
            }
            return LanStatus(online: true, models: models)
        } catch {
            return LanStatus(online: false, error: error.localizedDescription)
        }
    }

    private static func body(_ cfg: LanConfig, system: String, prompt: String, stream: Bool, schema: [String: Any]?) -> Data {
        var b: [String: Any] = [
            "model": cfg.model,
            "stream": stream,
            "messages": [["role": "system", "content": system], ["role": "user", "content": prompt]],
            "keep_alive": cfg.memorySaver ? "1m" : "15m",
            "options": ["use_mmap": true, "use_mlock": !cfg.memorySaver, "num_ctx": cfg.memorySaver ? 4096 : 8192],
        ]
        if let schema { b["format"] = schema }
        return try! JSONSerialization.data(withJSONObject: b)
    }

    private static func request(_ cfg: LanConfig, _ payload: Data, timeout: TimeInterval) throws -> URLRequest {
        guard let u = URL(string: base(cfg.url) + "/api/chat") else { throw AppError("Bad local server address.") }
        var req = URLRequest(url: u)
        req.httpMethod = "POST"
        req.httpBody = payload
        req.timeoutInterval = timeout
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return req
    }

    private static func offline(_ cfg: LanConfig) -> AppError {
        AppError("Local server \(cfg.url) is offline or unreachable. Check it's running and on the same Wi-Fi.")
    }

    static func chat(_ cfg: LanConfig, system: String, prompt: String, schema: [String: Any]? = nil) async throws -> String {
        let req = try request(cfg, body(cfg, system: system, prompt: prompt, stream: false, schema: schema), timeout: 180)
        let (data, resp): (Data, URLResponse)
        do { (data, resp) = try await URLSession.shared.data(for: req) } catch { throw offline(cfg) }
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
            throw AppError("Local server error: \(String(data: data, encoding: .utf8)?.prefix(200) ?? "")")
        }
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        return (obj?["message"] as? [String: Any])?["content"] as? String ?? ""
    }

    /// Streams accumulated text.
    static func stream(_ cfg: LanConfig, system: String, prompt: String) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let req = try request(cfg, body(cfg, system: system, prompt: prompt, stream: true, schema: nil), timeout: 300)
                    let bytes: URLSession.AsyncBytes
                    do { (bytes, _) = try await URLSession.shared.bytes(for: req) } catch { throw offline(cfg) }
                    var acc = ""
                    for try await line in bytes.lines where !line.isEmpty {
                        let obj = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
                        acc += (obj?["message"] as? [String: Any])?["content"] as? String ?? ""
                        continuation.yield(acc)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
