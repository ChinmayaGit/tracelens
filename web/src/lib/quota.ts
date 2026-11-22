import { doc, onSnapshot, runTransaction } from "firebase/firestore";
import { db } from "./firebase";

/**
 * Cloud AI rate limits. Enforced server-side by firestore.rules (keep in sync).
 * On-device Gemini Nano calls are free and never counted.
 */
export const USER_DAILY_LIMIT = 30;
export const GLOBAL_DAILY_LIMIT = 300;

export class QuotaError extends Error {
  constructor(public scope: "user" | "global") {
    super(
      scope === "user"
        ? `You've used all ${USER_DAILY_LIMIT} cloud AI runs for today. On-device (Gemini Nano) analysis is unlimited, or come back tomorrow.`
        : "TraceLens has reached its shared daily cloud limit (it's a free demo). On-device analysis still works; cloud resumes tomorrow (UTC).",
    );
  }
}

const today = () => Math.floor(Date.now() / 86_400_000);

interface Counter {
  day: number;
  count: number;
}

/** Atomically bump the user's and the global counter, or throw QuotaError. */
export async function consumeCloudQuota(uid: string): Promise<number> {
  const userRef = doc(db, "usage", uid);
  const globalRef = doc(db, "usage", "_global");
  try {
    return await runTransaction(db, async (tx) => {
      const [u, g] = await Promise.all([tx.get(userRef), tx.get(globalRef)]);
      const d = today();
      const uc = u.exists() && (u.data() as Counter).day === d ? (u.data() as Counter).count : 0;
      const gc = g.exists() && (g.data() as Counter).day === d ? (g.data() as Counter).count : 0;
      if (uc >= USER_DAILY_LIMIT) throw new QuotaError("user");
      if (gc >= GLOBAL_DAILY_LIMIT) throw new QuotaError("global");
      tx.set(userRef, { day: d, count: uc + 1 });
      tx.set(globalRef, { day: d, count: gc + 1 });
      return USER_DAILY_LIMIT - (uc + 1);
    });
  } catch (e) {
    if (e instanceof QuotaError) throw e;
    if ((e as { code?: string }).code === "permission-denied") throw new QuotaError("user");
    if ((e as { code?: string }).code === "unavailable") {
      throw new Error("You're offline. Cloud steps need a connection; tap Retry when you're back online.");
    }
    throw e;
  }
}

/** Live "cloud runs left today" for the UI. */
export function watchRemaining(uid: string, cb: (left: number) => void) {
  return onSnapshot(
    doc(db, "usage", uid),
    (s) => {
      const c = s.data() as Counter | undefined;
      cb(USER_DAILY_LIMIT - (c && c.day === today() ? c.count : 0));
    },
    () => cb(USER_DAILY_LIMIT),
  );
}
