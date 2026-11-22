import { initializeApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import { getAI, GoogleAIBackend } from "firebase/ai";
import { getAuth } from "firebase/auth";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";
import { getRemoteConfig } from "firebase/remote-config";

const env = import.meta.env;

export const app = initializeApp({
  apiKey: env.VITE_FB_API_KEY,
  authDomain: env.VITE_FB_AUTH_DOMAIN,
  projectId: env.VITE_FB_PROJECT_ID,
  storageBucket: env.VITE_FB_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FB_MESSAGING_SENDER_ID,
  appId: env.VITE_FB_APP_ID,
});

// App Check is required by Firebase AI Logic. A debug token (registered in the
// console) is allowed for the hackathon; it must be set before initializeAppCheck.
if (env.VITE_APPCHECK_DEBUG_TOKEN) {
  (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: string }).FIREBASE_APPCHECK_DEBUG_TOKEN =
    env.VITE_APPCHECK_DEBUG_TOKEN;
}
initializeAppCheck(app, {
  provider: new ReCaptchaEnterpriseProvider(env.VITE_RECAPTCHA_ENTERPRISE_KEY),
  isTokenAutoRefreshEnabled: true,
});

export const ai = getAI(app, { backend: new GoogleAIBackend() });
export const auth = getAuth(app);
// Offline cache: history stays readable when the network is gone, matching the
// on-device inference story.
export const db = initializeFirestore(app, {
  // Optional fields (e.g. step notes) may be undefined; drop them instead of throwing.
  ignoreUndefinedProperties: true,
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
export const remoteConfig = getRemoteConfig(app);
