import { authHeaders } from "./session";
import type {
  AutoClosedItem,
  AutonomyView,
  Decision,
  EvidenceView,
  ExamAnswer,
  GovernanceView,
  HumanView,
  MeView,
  PolicyAuditEntry,
  PolicyVersionRow,
  QueueAlert,
  RecordView,
  ReviewAnswer,
  RunEvent,
  TraceView,
  WhatIfView,
} from "./types";

/** Where the API listens, as the browser reaches it. Set NEXT_PUBLIC_API_URL when it is not on this machine. */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    cache: "no-store",
    ...init,
    headers: { ...authHeaders(), ...(init?.headers as Record<string, string> | undefined) },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text === "" ? undefined : JSON.parse(text);
  } catch {
    throw new ApiError(`the API answered with something that is not JSON (HTTP ${res.status})`, res.status);
  }
  if (!res.ok) {
    const message = (body as { error?: { message?: string } } | undefined)?.error?.message;
    throw new ApiError(message ?? `the API answered HTTP ${res.status}`, res.status);
  }
  return body as T;
}

export const fetchQueue = () => getJson<{ alerts: QueueAlert[]; sample_mode: boolean }>("/alerts");
export const fetchEvidence = (alertId: string) =>
  getJson<EvidenceView>(`/cases/${encodeURIComponent(alertId)}/evidence`);
export const fetchRecord = (alertId: string) => getJson<RecordView>(`/cases/${encodeURIComponent(alertId)}/record`);
export const fetchTrace = (alertId: string) => getJson<TraceView>(`/cases/${encodeURIComponent(alertId)}/trace`);
export const fetchGovernance = () => getJson<GovernanceView>("/governance");
export const fetchExam = () => getJson<ExamAnswer>("/exam");
export const fetchEvents = (runId: string) =>
  getJson<{ run_id: string; finished: boolean; events: RunEvent[] }>(`/runs/${encodeURIComponent(runId)}/events`);

/** Start a review. The answer arrives when the review ends; progress comes from the event stream. */
export const startReview = (alertId: string, runId: string) =>
  getJson<ReviewAnswer>("/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ alert_id: alertId, run_id: runId }),
  });

export const fetchMe = () => getJson<MeView>("/me");
export const fetchHuman = (alertId: string) => getJson<HumanView>(`/cases/${encodeURIComponent(alertId)}/human`);

const post = <T>(path: string, body: unknown) =>
  getJson<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

export interface DecisionInput {
  action: "approve" | "override";
  outcome?: Decision;
  reason: string;
  record_hash: string;
}
export const postDecision = (alertId: string, input: DecisionInput) =>
  post<HumanView>(`/cases/${encodeURIComponent(alertId)}/decision`, input);
export const fetchAutonomy = () => getJson<AutonomyView>("/autonomy");
export const fetchAutoClosed = () => getJson<{ items: AutoClosedItem[] }>("/auto-closed");
export const fetchPolicy = () => getJson<{ version: number; hash: string; policy: Record<string, unknown> }>("/policy");
export const fetchPolicyVersions = () =>
  getJson<{ active_version: number; versions: PolicyVersionRow[] }>("/policy/versions");
export const fetchPolicyAudit = () => getJson<{ entries: PolicyAuditEntry[] }>("/policy/audit");
export const postKillSwitch = (active: boolean, reason: string) =>
  post<AutonomyView>("/autonomy/kill-switch", { active, reason });
export const postPolicyDraft = (policy: unknown, reason: string) =>
  post<PolicyVersionRow>("/policy/drafts", { policy, reason });
export const postWhatIf = (version: number, limit = 30) => post<WhatIfView>("/policy/whatif", { version, limit });
export const postPublish = (version: number) => post<{ published: number }>(`/policy/drafts/${version}/publish`, {});
export const postDiscard = (version: number) => post<{ discarded: number }>(`/policy/drafts/${version}/discard`, {});
export const postReopen = (alertId: string, input: { reason: string; record_hash: string }) =>
  post<HumanView>(`/cases/${encodeURIComponent(alertId)}/reopen`, input);
export const postSecondApproval = (alertId: string, input: { approve: boolean; reason: string; record_hash: string }) =>
  post<HumanView>(`/cases/${encodeURIComponent(alertId)}/second-approval`, input);

/**
 * Follow a run's events as they happen. Returns a function that stops listening. It reads the stream with fetch, not
 * EventSource, so the sign-in header can be sent and no token ever appears in an address.
 */
export function followRun(runId: string, onEvent: (event: RunEvent) => void, onClose: () => void): () => void {
  const abort = new AbortController();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    abort.abort();
    onClose();
  };
  void (async () => {
    try {
      const res = await fetch(`${API_URL}/runs/${encodeURIComponent(runId)}/stream`, {
        headers: { ...authHeaders(), accept: "text/event-stream" },
        signal: abort.signal,
        cache: "no-store",
      });
      if (!res.ok || !res.body) return finish();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done: ended } = await reader.read();
        if (ended) break;
        buffer += decoder.decode(value, { stream: true });
        let cut = buffer.indexOf("\n\n");
        while (cut >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const data = block
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("");
          if (block.includes("event: run_event") && data) {
            const event = JSON.parse(data) as RunEvent;
            onEvent(event);
            if (event.agent === "system" && ["run_completed", "run_failed", "run_rejected"].includes(event.action))
              return finish();
          }
          cut = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // aborted by the caller, or the connection dropped; the recorded history is read afterwards
    }
    finish();
  })();
  return () => {
    done = true;
    abort.abort();
  };
}
