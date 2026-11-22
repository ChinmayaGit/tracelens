package dev.tracelens

import com.google.firebase.Firebase
import com.google.firebase.appcheck.appCheck
import com.google.firebase.appcheck.playintegrity.PlayIntegrityAppCheckProviderFactory

/** Release builds attest with Play Integrity. */
object AppCheckSetup {
    fun install() {
        Firebase.appCheck.installAppCheckProviderFactory(PlayIntegrityAppCheckProviderFactory.getInstance())
        // Fetch tokens only when an AI call needs one (each attestation counts against quota).
        Firebase.appCheck.setTokenAutoRefreshEnabled(false)
    }
}
