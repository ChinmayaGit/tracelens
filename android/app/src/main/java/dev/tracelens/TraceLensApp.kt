package dev.tracelens

import android.app.Application
import com.google.firebase.Firebase
import com.google.firebase.initialize

class TraceLensApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Firebase.initialize(this)
        // App Check must be installed before any Firebase AI Logic call.
        AppCheckSetup.install()
    }
}
