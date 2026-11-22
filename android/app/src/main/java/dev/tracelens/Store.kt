package dev.tracelens

import com.google.firebase.Firebase
import com.google.firebase.Timestamp
import com.google.firebase.auth.auth
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.ListenerRegistration
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.firestore
import com.google.firebase.remoteconfig.remoteConfig
import com.google.firebase.remoteconfig.remoteConfigSettings
import kotlinx.coroutines.tasks.await

/** Same document shape as the web app: users/{uid}/traces/{id}. Sanitized data only. */
data class TraceDoc(
    val id: String,
    val title: String,
    val sanitized: String,
    val triage: Triage?,
    val analysis: String?,
    val steps: List<StepLog>,
    val redactionTotal: Int,
    val platform: String,
    val createdAt: Timestamp?,
)

private const val MAX_STORED = 40_000

object Store {
    private val auth get() = Firebase.auth
    private val db get() = Firebase.firestore

    suspend fun ensureSignedIn(): String {
        auth.currentUser?.let { return it.uid }
        return auth.signInAnonymously().await().user!!.uid
    }

    suspend fun loadConfig(): RoutingConfig {
        val rc = Firebase.remoteConfig
        rc.setConfigSettingsAsync(
            remoteConfigSettings { minimumFetchIntervalInSeconds = if (BuildConfig.DEBUG) 60 else 3600 },
        ).await()
        val d = RoutingConfig()
        rc.setDefaultsAsync(
            mapOf(
                "cloud_model" to d.cloudModel,
                "escalate_below_confidence" to d.escalateBelowConfidence,
                "max_on_device_chars" to d.maxOnDeviceChars.toLong(),
                "auto_escalate" to d.autoEscalate,
            ),
        ).await()
        runCatching { rc.fetchAndActivate().await() }
        return RoutingConfig(
            cloudModel = rc.getString("cloud_model").ifBlank { d.cloudModel },
            escalateBelowConfidence = rc.getDouble("escalate_below_confidence"),
            maxOnDeviceChars = rc.getLong("max_on_device_chars").toInt(),
            autoEscalate = rc.getBoolean("auto_escalate"),
        )
    }

    private fun col(uid: String) = db.collection("users").document(uid).collection("traces")

    private fun Triage.toMap() = mapOf(
        "isError" to isError, "errorType" to errorType, "language" to language, "summary" to summary,
        "likelyCause" to likelyCause, "quickFix" to quickFix, "severity" to severity, "confidence" to confidence,
    )

    // Web stores step ids like "triage" and sources like "on_device"; keep the formats compatible.
    private fun StepLog.toMap() = buildMap {
        put("step", STEP_IDS[step] ?: step)
        put("source", source.name.lowercase())
        put("ms", ms)
        note?.let { put("note", it) }
    }

    suspend fun save(uid: String, sanitized: String, triage: Triage, steps: List<StepLog>, redactions: List<Redaction>): String {
        val ref = col(uid).add(
            mapOf(
                "title" to "${triage.errorType} · ${triage.language}".take(120),
                "sanitized" to sanitized.take(MAX_STORED),
                "triage" to triage.toMap(),
                "analysis" to null,
                "steps" to steps.map { it.toMap() },
                "redactionCounts" to redactions.groupingBy { it.kind }.eachCount(),
                "redactionTotal" to redactions.size,
                "platform" to "android",
                "createdAt" to FieldValue.serverTimestamp(),
            ),
        ).await()
        return ref.id
    }

    suspend fun saveAnalysis(uid: String, id: String, analysis: String, steps: List<StepLog>) {
        col(uid).document(id).update(mapOf("analysis" to analysis, "steps" to steps.map { it.toMap() })).await()
    }

    fun delete(uid: String, id: String) {
        col(uid).document(id).delete()
    }

    fun watch(uid: String, onChange: (List<TraceDoc>) -> Unit): ListenerRegistration =
        col(uid).orderBy("createdAt", Query.Direction.DESCENDING).limit(50).addSnapshotListener { snap, _ ->
            onChange(snap?.documents.orEmpty().map { d ->
                @Suppress("UNCHECKED_CAST")
                val t = d.get("triage") as? Map<String, Any?>
                @Suppress("UNCHECKED_CAST")
                val steps = (d.get("steps") as? List<Map<String, Any?>>).orEmpty().map { s ->
                    val id = s["step"] as? String ?: ""
                    StepLog(
                        step = STEP_IDS.entries.firstOrNull { it.value == id }?.key ?: id,
                        source = runCatching { StepSource.valueOf((s["source"] as String).uppercase()) }
                            .getOrDefault(StepSource.SKIPPED),
                        ms = (s["ms"] as? Number)?.toLong() ?: 0,
                        note = s["note"] as? String,
                    )
                }
                TraceDoc(
                    id = d.id,
                    title = d.getString("title") ?: "Trace",
                    sanitized = d.getString("sanitized") ?: "",
                    triage = t?.let {
                        Triage(
                            isError = it["isError"] as? Boolean ?: true,
                            errorType = it["errorType"] as? String ?: "",
                            language = it["language"] as? String ?: "",
                            summary = it["summary"] as? String ?: "",
                            likelyCause = it["likelyCause"] as? String ?: "",
                            quickFix = it["quickFix"] as? String ?: "",
                            severity = it["severity"] as? String ?: "medium",
                            confidence = (it["confidence"] as? Number)?.toDouble() ?: 0.0,
                        )
                    },
                    analysis = d.getString("analysis"),
                    steps = steps,
                    redactionTotal = d.getLong("redactionTotal")?.toInt() ?: 0,
                    platform = d.getString("platform") ?: "web",
                    createdAt = d.getTimestamp("createdAt"),
                )
            })
        }

    private val STEP_IDS = mapOf(
        "Read screenshot" to "extract",
        "Redact secrets (rules)" to "redact_rules",
        "Redact context (AI)" to "redact_model",
        "Quick triage" to "triage",
        "Root-cause deep dive" to "deep",
    )
}
