package dev.tracelens

import com.google.firebase.Firebase
import com.google.firebase.appcheck.appCheck
import com.google.firebase.appcheck.debug.DebugAppCheckProviderFactory

/**
 * Debug builds use the App Check debug provider (accepted for the hackathon).
 * On first run the token is printed to logcat (tag DebugAppCheckProvider):
 * register it in Firebase console → App Check → Apps → Manage debug tokens.
 */
object AppCheckSetup {
    fun install() {
        Firebase.appCheck.installAppCheckProviderFactory(DebugAppCheckProviderFactory.getInstance())
        // Fetch tokens only when an AI call needs one (each attestation counts against quota).
        Firebase.appCheck.setTokenAutoRefreshEnabled(false)
    }
}
