import SwiftUI
import FirebaseCore
import FirebaseAppCheck

/// Release builds attest with App Attest; debug/simulator builds use the App Check
/// debug provider (accepted for the hackathon). The debug token can be supplied via
/// the FIRAAppCheckDebugToken environment variable and must be registered in the console.
final class TraceLensAppCheckFactory: NSObject, AppCheckProviderFactory {
    func createProvider(with app: FirebaseApp) -> (any AppCheckProvider)? {
        #if DEBUG || targetEnvironment(simulator)
        return AppCheckDebugProvider(app: app)
        #else
        return AppAttestProvider(app: app)
        #endif
    }
}

@main
struct TraceLensApp: App {
    init() {
        // App Check must be configured before FirebaseApp.configure() and any AI call.
        AppCheck.setAppCheckProviderFactory(TraceLensAppCheckFactory())
        FirebaseApp.configure()
        // Fetch tokens only when an AI call needs one (each attestation counts against quota).
        AppCheck.appCheck().isTokenAutoRefreshEnabled = false
    }

    var body: some Scene {
        WindowGroup { ContentView() }
    }
}
