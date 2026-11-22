package dev.tracelens

import com.google.firebase.Firebase
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.ListenerRegistration
import com.google.firebase.firestore.firestore
import kotlinx.coroutines.tasks.await

/**
 * Cloud AI rate limits, enforced server-side by firestore.rules (keep in sync with
 * web/src/lib/quota.ts). On-device Gemini Nano calls are free and never counted.
 */
const val USER_DAILY_LIMIT = 30
const val GLOBAL_DAILY_LIMIT = 300

class QuotaException(val global: Boolean) : Exception(
    if (global) "TraceLens has reached its shared daily cloud limit (it's a free demo). On-device analysis still works; cloud resumes tomorrow (UTC)."
    else "You've used all $USER_DAILY_LIMIT cloud AI runs for today. On-device (Gemini Nano) analysis is unlimited, or come back tomorrow.",
)

object Quota {
    private val db get() = Firebase.firestore
    private fun today() = System.currentTimeMillis() / 86_400_000L

    /** Atomically bump the user's and the global counter, or throw [QuotaException]. */
    suspend fun consume(uid: String): Int {
        val userRef = db.collection("usage").document(uid)
        val globalRef = db.collection("usage").document("_global")
        try {
            return db.runTransaction { tx ->
                val u = tx.get(userRef)
                val g = tx.get(globalRef)
                val d = today()
                val uc = if (u.getLong("day") == d) u.getLong("count") ?: 0 else 0
                val gc = if (g.getLong("day") == d) g.getLong("count") ?: 0 else 0
                if (uc >= USER_DAILY_LIMIT) throw QuotaException(global = false)
                if (gc >= GLOBAL_DAILY_LIMIT) throw QuotaException(global = true)
                tx.set(userRef, mapOf("day" to d, "count" to uc + 1))
                tx.set(globalRef, mapOf("day" to d, "count" to gc + 1))
                (USER_DAILY_LIMIT - (uc + 1)).toInt()
            }.await()
        } catch (e: Exception) {
            val cause = generateSequence<Throwable>(e) { it.cause }.firstOrNull { it is QuotaException }
            if (cause != null) throw cause
            if (e is FirebaseFirestoreException && e.code == FirebaseFirestoreException.Code.PERMISSION_DENIED) {
                throw QuotaException(global = false)
            }
            if (e is FirebaseFirestoreException && e.code == FirebaseFirestoreException.Code.UNAVAILABLE) {
                throw Exception("You're offline. Cloud steps need a connection; tap Retry when you're back online.")
            }
            throw e
        }
    }

    fun watchRemaining(uid: String, onChange: (Int) -> Unit): ListenerRegistration =
        db.collection("usage").document(uid).addSnapshotListener { s, _ ->
            val used = if (s?.getLong("day") == today()) s.getLong("count") ?: 0 else 0
            onChange((USER_DAILY_LIMIT - used).toInt())
        }
}
