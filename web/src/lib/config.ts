import { fetchAndActivate, getValue } from "firebase/remote-config";
import { remoteConfig } from "./firebase";

/** Routing knobs, tunable from the Remote Config console without a redeploy. */
export interface RoutingConfig {
  /** Gemini model used for cloud deep analysis. */
  cloudModel: string;
  /** Triage confidence below this escalates to the cloud automatically. */
  escalateBelowConfidence: number;
  /** Traces longer than this skip on-device triage (Gemini Nano context ~9k tokens). */
  maxOnDeviceChars: number;
  /** When true, the cloud deep-dive starts automatically on low confidence. */
  autoEscalate: boolean;
}

export const DEFAULTS: RoutingConfig = {
  cloudModel: "gemini-3.5-flash",
  escalateBelowConfidence: 0.7,
  maxOnDeviceChars: 24000,
  autoEscalate: true,
};

remoteConfig.settings.minimumFetchIntervalMillis = import.meta.env.DEV ? 60_000 : 3_600_000;
remoteConfig.defaultConfig = {
  cloud_model: DEFAULTS.cloudModel,
  escalate_below_confidence: DEFAULTS.escalateBelowConfidence,
  max_on_device_chars: DEFAULTS.maxOnDeviceChars,
  auto_escalate: DEFAULTS.autoEscalate,
};

export async function loadRoutingConfig(): Promise<RoutingConfig> {
  try {
    await fetchAndActivate(remoteConfig);
  } catch {
    // Offline or blocked: defaults/cached values still apply.
  }
  return {
    cloudModel: getValue(remoteConfig, "cloud_model").asString() || DEFAULTS.cloudModel,
    escalateBelowConfidence: getValue(remoteConfig, "escalate_below_confidence").asNumber(),
    maxOnDeviceChars: getValue(remoteConfig, "max_on_device_chars").asNumber(),
    autoEscalate: getValue(remoteConfig, "auto_escalate").asBoolean(),
  };
}
