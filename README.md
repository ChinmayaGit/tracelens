# TraceLens

**Debug your errors with AI, without leaking your secrets.**

Stack traces and logs are full of things that should never be pasted into a chatbot: database passwords, API keys, JWTs, customer emails, internal hostnames. TraceLens cleans them **on your device** with Gemini Nano, triages the error locally, and only sends the **sanitized** trace to cloud Gemini when it needs a deeper root-cause analysis.

Built for the Firebase **#BuildHybridAI** hackathon using the **Firebase AI Logic Hybrid Inference SDK**.

| | On-device (Gemini Nano) | Cloud (Gemini) |
|---|---|---|
| Find contextual PII (names, internal hosts, customer IDs) | ✅ `ONLY_ON_DEVICE`, never falls back | ❌ by design |
| Read error screenshots | ✅ `ONLY_ON_DEVICE` | only with explicit opt-in |
| Quick triage (structured JSON) | ✅ `PREFER_ON_DEVICE` | fallback when Nano is missing or the trace is too long |
| Deep root-cause analysis + fix | | ✅ `ONLY_IN_CLOUD`, streamed, sanitized input only |

## Why hybrid

- **Privacy:** raw logs never leave the machine. Redaction is a hard gate: deterministic local rules always run, and the AI pass is `ONLY_ON_DEVICE`, so it can never silently fall back to the cloud.
- **Cost and latency:** most errors (NPEs, KeyErrors, typos, auth failures) are triaged by Gemini Nano in about a second, for free. The cloud is used only when on-device confidence is low or the user asks for it.
- **Offline:** triage works on a plane. History is cached by Firestore offline persistence.
- **Works everywhere:** browsers without Gemini Nano fall back to cloud triage through the same SDK call, still on sanitized text only.

## Processing modes

Not every machine can run Gemini Nano (Chrome needs 22 GB free disk, plus a GPU with more than 4 GB VRAM or 16 GB RAM), so the user picks a mode. A sensible default is chosen on first visit from `LanguageModel.availability()` and basic hardware hints.

| Mode | Redaction | Triage | Deep dive |
|---|---|---|---|
| **Hybrid** (default) | rules + Gemini Nano | `PREFER_ON_DEVICE` | cloud |
| **Private** | rules + Gemini Nano | `ONLY_ON_DEVICE` | disabled, nothing leaves the device |
| **Cloud** (low-spec devices) | rules only | `ONLY_IN_CLOUD` | cloud |

The model download is opt-in. The app shows the requirements first, warns if no progress arrives within 30 s (usually low disk space), and can be cancelled. It stops itself after 2 minutes of no progress and switches to Cloud mode.

## Abuse protection and cost caps

Cloud calls are rate-limited by **Firestore security rules**, so the limits hold even if someone modifies the client:

- **30 cloud AI calls per user per day** and **300 per day for the whole app**. That keeps reCAPTCHA Enterprise under its free 10k assessments/month.
- Before every cloud call, the client must bump its own counter and the global counter in a single transaction. The rules check that the day comes from the server clock, that each counter goes up by exactly +1, and that the limits aren't exceeded. Rule tests cover skipping ahead, resetting to yesterday, bumping only one counter, writing someone else's counter and the 31st call: all are rejected.
- **On-device Gemini Nano calls are free and never counted**, so privacy-first users are unlimited.
- App Check fetches tokens lazily (`isTokenAutoRefreshEnabled: false`), so page visits that don't use AI cost no reCAPTCHA assessment.

Code: [firestore.rules](firestore.rules), [web/src/lib/quota.ts](web/src/lib/quota.ts), [Quota.kt](android/app/src/main/java/dev/tracelens/Quota.kt).

## How it works

```
input (text / .log / screenshot)
  │
  ├─ 1. extract     screenshot → text       Gemini Nano (ONLY_ON_DEVICE)
  ├─ 2. redact      regex rules             local, no model
  │                 contextual PII          Gemini Nano (ONLY_ON_DEVICE, JSON schema)
  ├─ 3. triage      error type, cause, fix, confidence
  │                                         PREFER_ON_DEVICE → cloud fallback
  ├─ 4. route       confidence < threshold (Remote Config) → escalate
  └─ 5. deep dive   root cause + code fix   ONLY_IN_CLOUD, streaming
```

Every step records `response.inferenceSource` (`on_device` / `in_cloud`) and latency, and the UI shows it as a timeline. The sidebar tracks **% of AI steps run on-device** and **secrets kept local**.

### Firebase products used

| Product | Use |
|---|---|
| **Firebase AI Logic** (`firebase/ai`) | Hybrid inference: `getGenerativeModel` with `InferenceMode`, `onDeviceParams` (Prompt API `responseConstraint`), `inCloudParams` (`responseJsonSchema`), `initializeDeviceModel`, `generateContentStream`, `inferenceSource` |
| **App Check** | reCAPTCHA Enterprise; required by AI Logic (debug token supported for judging) |
| **Authentication** | Anonymous sign-in on first visit, upgrade to Google to sync history across devices |
| **Cloud Firestore** | Per-user history of **sanitized** traces only, with offline persistence; locked down by [firestore.rules](firestore.rules) |
| **Remote Config** | Routing knobs: `cloud_model`, `escalate_below_confidence`, `max_on_device_chars`, `auto_escalate` |
| **Hosting** | Live demo |

Key code: [web/src/lib/pipeline.ts](web/src/lib/pipeline.ts) (hybrid models and routing), [web/src/lib/redact.ts](web/src/lib/redact.ts) (deterministic redaction).

## Run it

### 1. Enable Gemini Nano in Chrome (desktop, Chrome 139+)

1. Open `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input`, set it to **Enabled**, and restart Chrome.
2. In TraceLens, click **Enable on-device AI** to start the model download. The first download can take a few minutes.

Without Gemini Nano the app still works: triage and deep dive use the cloud, and redaction uses local rules only.

### 2. Firebase project

1. Create a Firebase project and add a **Web app**.
2. **AI Logic:** enable the Gemini Developer API.
3. **App Check:** register the web app with **reCAPTCHA Enterprise**, then enforce it for Firebase AI Logic. For local dev, add a debug token under *Manage debug tokens*.
4. **Authentication:** enable **Anonymous** and **Google** providers.
5. **Firestore:** create a database.

```bash
cd web
cp .env.example .env      # fill in config, reCAPTCHA key, optional debug token
npm install
npm run dev
```

### 3. Deploy

```bash
cd web && npm run build && cd ..
firebase deploy --only hosting,firestore:rules,remoteconfig
```

## Platforms

Both apps share one Firebase project, the same Firestore layout (`users/{uid}/traces`, tagged `platform: web | android`) and the same Remote Config routing knobs.

### Web (Chrome): [web/](web/)
Gemini Nano through Chrome's Prompt API. See *Run it* above.

### Android (Kotlin, Jetpack Compose): [android/](android/)
Gemini Nano through ML Kit's Prompt API (AICore) via `firebase-ai-ondevice`. Key code: [Pipeline.kt](android/app/src/main/java/dev/tracelens/Pipeline.kt).

| Step | Android API |
|---|---|
| Model status / download | `FirebaseAIOnDevice.checkStatus()` / `FirebaseAIOnDevice.download()` |
| Contextual redaction | `OnDeviceConfig(mode = InferenceMode.ONLY_ON_DEVICE)` |
| Triage | `PREFER_ON_DEVICE` / `ONLY_ON_DEVICE` / `ONLY_IN_CLOUD` by processing mode, JSON `responseSchema` |
| Deep dive | `ONLY_IN_CLOUD` + `generateContentStream` |
| Which backend answered | `response.inferenceSource` |

Android-only extras:
- **Share to TraceLens:** share a crash log or logcat text from any app straight into the input.
- **Review before cloud:** on phones without AICore, long-press and select any text in the sanitized trace to hide it before anything is sent.

Build and run:
1. In the Firebase console, add an Android app with package `dev.tracelens` and put its `google-services.json` in `android/app/`. It is git-ignored.
2. Run `cd android && ./gradlew installDebug` (JDK 17, Android SDK 37.2).
3. On first launch, logcat prints an App Check debug token. Register it with `firebase appcheck:debugtokens:create <token> --app <android app id>`.

Gemini Nano runs on AICore devices (e.g. Pixel 9+, Galaxy S24+). Other phones fall back to the cloud automatically, with the review step.

## License

[Apache 2.0](LICENSE)
# tracelens
