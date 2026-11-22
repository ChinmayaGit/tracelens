import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  type Timestamp,
} from "firebase/firestore";
import { db } from "./firebase";
import type { StepLog, Triage } from "./pipeline";

/** Only sanitized data is ever persisted; raw input and secret values are not. */
export interface TraceDoc {
  id: string;
  title: string;
  sanitized: string;
  triage: Triage | null;
  analysis: string | null;
  steps: StepLog[];
  redactionCounts: Record<string, number>;
  redactionTotal: number;
  /** "web" | "android" */
  platform?: string;
  createdAt: Timestamp | null;
}

const MAX_STORED = 40_000;
const col = (uid: string) => collection(db, "users", uid, "traces");

export async function saveTrace(
  uid: string,
  data: Omit<TraceDoc, "id" | "createdAt">,
): Promise<string> {
  const ref = await addDoc(col(uid), {
    ...data,
    steps: storableSteps(data.steps),
    sanitized: data.sanitized.slice(0, MAX_STORED),
    platform: "web",
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export function updateTrace(uid: string, id: string, patch: Partial<Omit<TraceDoc, "id">>) {
  return updateDoc(doc(db, "users", uid, "traces", id), patch.steps ? { ...patch, steps: storableSteps(patch.steps) } : patch);
}

/** Browser-model steps count as on-device everywhere (Android/iOS/stats); the model name is in the note. */
function storableSteps(steps: StepLog[]): StepLog[] {
  return steps.map((s) => (s.source === "edge" ? { ...s, source: "on_device" } : s));
}

export function deleteTrace(uid: string, id: string) {
  return deleteDoc(doc(db, "users", uid, "traces", id));
}

export function watchHistory(uid: string, cb: (docs: TraceDoc[]) => void) {
  return onSnapshot(query(col(uid), orderBy("createdAt", "desc"), limit(50)), (snap) =>
    cb(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<TraceDoc, "id">) }))),
  );
}
