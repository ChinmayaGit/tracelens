import Foundation
import FirebaseAuth
import FirebaseFirestore
import FirebaseRemoteConfig

/// Same document shape as web/Android: users/{uid}/traces/{id}. Sanitized data only.
struct TraceDoc: Identifiable, Hashable {
    let id: String
    let title: String
    let sanitized: String
    let triage: Triage?
    let analysis: String?
    let steps: [StepLog]
    let redactionTotal: Int
    let platform: String
}

enum Store {
    private static var db: Firestore { Firestore.firestore() }
    private static let maxStored = 40_000

    static func ensureSignedIn() async throws -> String {
        if let u = Auth.auth().currentUser { return u.uid }
        return try await Auth.auth().signInAnonymously().user.uid
    }

    static func loadConfig() async -> RoutingConfig {
        let d = RoutingConfig()
        let rc = RemoteConfig.remoteConfig()
        let settings = RemoteConfigSettings()
        #if DEBUG
        settings.minimumFetchInterval = 60
        #endif
        rc.configSettings = settings
        rc.setDefaults([
            "cloud_model": d.cloudModel as NSObject,
            "escalate_below_confidence": d.escalateBelowConfidence as NSObject,
            "max_on_device_chars": d.maxOnDeviceChars as NSObject,
            "auto_escalate": d.autoEscalate as NSObject,
        ])
        _ = try? await rc.fetchAndActivate()
        let model = rc["cloud_model"].stringValue
        return RoutingConfig(
            cloudModel: model.isEmpty ? d.cloudModel : model,
            escalateBelowConfidence: rc["escalate_below_confidence"].numberValue.doubleValue,
            maxOnDeviceChars: rc["max_on_device_chars"].numberValue.intValue,
            autoEscalate: rc["auto_escalate"].boolValue
        )
    }

    private static func col(_ uid: String) -> CollectionReference {
        db.collection("users").document(uid).collection("traces")
    }

    private static func map(_ t: Triage) -> [String: Any] {
        ["isError": t.isError, "errorType": t.errorType, "language": t.language, "summary": t.summary,
         "likelyCause": t.likelyCause, "quickFix": t.quickFix, "severity": t.severity, "confidence": t.confidence]
    }

    private static func map(_ s: StepLog) -> [String: Any] {
        var m: [String: Any] = ["step": s.step, "source": s.source.rawValue, "ms": s.ms]
        if let n = s.note { m["note"] = n }
        return m
    }

    static func save(uid: String, sanitized: String, triage: Triage, steps: [StepLog], redactions: [Redaction]) async throws -> String {
        var counts: [String: Int] = [:]
        for r in redactions { counts[r.kind, default: 0] += 1 }
        let ref = try await col(uid).addDocument(data: [
            "title": String("\(triage.errorType) · \(triage.language)".prefix(120)),
            "sanitized": String(sanitized.prefix(maxStored)),
            "triage": map(triage),
            "analysis": NSNull(),
            "steps": steps.map(map),
            "redactionCounts": counts,
            "redactionTotal": redactions.count,
            "platform": "ios",
            "createdAt": FieldValue.serverTimestamp(),
        ])
        return ref.documentID
    }

    static func saveAnalysis(uid: String, id: String, analysis: String, steps: [StepLog]) async throws {
        try await col(uid).document(id).updateData(["analysis": analysis, "steps": steps.map(map)])
    }

    static func delete(uid: String, id: String) {
        col(uid).document(id).delete()
    }

    static func watch(uid: String, onChange: @escaping ([TraceDoc]) -> Void) -> ListenerRegistration {
        col(uid).order(by: "createdAt", descending: true).limit(to: 50).addSnapshotListener { snap, _ in
            onChange((snap?.documents ?? []).map { d in
                let data = d.data()
                let t = data["triage"] as? [String: Any]
                let steps = (data["steps"] as? [[String: Any]] ?? []).map { s in
                    StepLog(step: s["step"] as? String ?? "",
                            source: StepSource(rawValue: s["source"] as? String ?? "") ?? .skipped,
                            ms: (s["ms"] as? NSNumber)?.intValue ?? 0,
                            note: s["note"] as? String)
                }
                return TraceDoc(
                    id: d.documentID,
                    title: data["title"] as? String ?? "Trace",
                    sanitized: data["sanitized"] as? String ?? "",
                    triage: t.map {
                        Triage(isError: $0["isError"] as? Bool ?? true,
                               errorType: $0["errorType"] as? String ?? "",
                               language: $0["language"] as? String ?? "",
                               summary: $0["summary"] as? String ?? "",
                               likelyCause: $0["likelyCause"] as? String ?? "",
                               quickFix: $0["quickFix"] as? String ?? "",
                               severity: $0["severity"] as? String ?? "medium",
                               confidence: ($0["confidence"] as? NSNumber)?.doubleValue ?? 0)
                    },
                    analysis: data["analysis"] as? String,
                    steps: steps,
                    redactionTotal: (data["redactionTotal"] as? NSNumber)?.intValue ?? 0,
                    platform: data["platform"] as? String ?? "web")
            })
        }
    }
}

// MARK: - Rate limiting (enforced by firestore.rules; keep in sync with web quota.ts / Android Quota.kt)

let userDailyLimit = 30
let globalDailyLimit = 300

enum Quota {
    private static var db: Firestore { Firestore.firestore() }
    private static func today() -> Int64 { Int64(Date().timeIntervalSince1970 / 86_400) }

    struct LimitError: LocalizedError {
        let global: Bool
        var errorDescription: String? {
            global
                ? "TraceLens has reached its shared daily cloud limit (it's a free demo). On-device analysis still works; cloud resumes tomorrow (UTC)."
                : "You've used all \(userDailyLimit) cloud AI runs for today. On-device (Apple Intelligence) analysis is unlimited, or come back tomorrow."
        }
    }

    /// Atomically bump the user's and the global counter, or throw `LimitError`.
    static func consume(uid: String) async throws {
        let userRef = db.collection("usage").document(uid)
        let globalRef = db.collection("usage").document("_global")
        let d = today()
        do {
            _ = try await db.runTransaction { tx, errorPointer -> Any? in
                do {
                    let u = try tx.getDocument(userRef)
                    let g = try tx.getDocument(globalRef)
                    let uc = (u.data()?["day"] as? NSNumber)?.int64Value == d ? (u.data()?["count"] as? NSNumber)?.int64Value ?? 0 : 0
                    let gc = (g.data()?["day"] as? NSNumber)?.int64Value == d ? (g.data()?["count"] as? NSNumber)?.int64Value ?? 0 : 0
                    if uc >= Int64(userDailyLimit) {
                        errorPointer?.pointee = NSError(domain: "quota", code: 1); return nil
                    }
                    if gc >= Int64(globalDailyLimit) {
                        errorPointer?.pointee = NSError(domain: "quota", code: 2); return nil
                    }
                    tx.setData(["day": d, "count": uc + 1], forDocument: userRef)
                    tx.setData(["day": d, "count": gc + 1], forDocument: globalRef)
                    return nil
                } catch {
                    errorPointer?.pointee = error as NSError
                    return nil
                }
            }
        } catch let e as NSError where e.domain == "quota" {
            throw LimitError(global: e.code == 2)
        } catch let e as NSError where e.domain == FirestoreErrorDomain && e.code == FirestoreErrorCode.permissionDenied.rawValue {
            throw LimitError(global: false)
        } catch let e as NSError where e.domain == FirestoreErrorDomain && e.code == FirestoreErrorCode.unavailable.rawValue {
            throw AppError("You're offline. Cloud steps need a connection; tap Retry when you're back online.")
        }
    }

    static func watchRemaining(uid: String, onChange: @escaping (Int) -> Void) -> ListenerRegistration {
        db.collection("usage").document(uid).addSnapshotListener { s, _ in
            let data = s?.data()
            let used = (data?["day"] as? NSNumber)?.int64Value == today() ? (data?["count"] as? NSNumber)?.intValue ?? 0 : 0
            onChange(userDailyLimit - used)
        }
    }
}
