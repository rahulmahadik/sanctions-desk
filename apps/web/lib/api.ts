import type {
  EvidenceView,
  ExamAnswer,
  GovernanceView,
  QueueAlert,
  RecordView,
  ReviewAnswer,
  RunEvent,
  TraceView,
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
  const res = await fetch(`${API_URL}${path}`, { cache: "no-store", ...init });
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

/** Follow a run's events as they happen. Returns a function that stops listening. */
export function followRun(runId: string, onEvent: (event: RunEvent) => void, onClose: () => void): () => void {
  const source = new EventSource(`${API_URL}/runs/${encodeURIComponent(runId)}/stream`);
  source.addEventListener("run_event", (message) => {
    const event = JSON.parse((message as MessageEvent<string>).data) as RunEvent;
    onEvent(event);
    if (event.agent === "system" && ["run_completed", "run_failed", "run_rejected"].includes(event.action)) {
      source.close();
      onClose();
    }
  });
  source.onerror = () => {
    source.close();
    onClose();
  };
  return () => source.close();
}
