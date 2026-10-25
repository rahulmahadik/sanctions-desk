"use client";

import { useEffect, useState } from "react";
import { fetchExam } from "../lib/api";
import { SESSION_EVENT } from "../lib/session";
import type { ExamAnswer, Headline } from "../lib/types";

export const RESULTS_URL = "https://rahulmahadik.github.io/sanctions-desk/results.html";

/**
 * The time per alert as the README states it: the median over the alerts of the recorded 70-case run, worked out by the
 * same code (the API's headline, packages/agents/src/headline.ts). The UI shows no other per-alert median.
 */
export function perAlertLine(h: Headline | null | undefined): string {
  const p = h?.per_alert;
  if (!p || p.alerts === 0) return "";
  return ` The desk took a median of ${p.median_seconds.toFixed(0)} seconds per alert over the ${p.alerts} alerts of the recorded 70-case run (measured, for the recommendation only).`;
}

/** A line across the top: what the first system's 70-case exam run did with the risk cases, and its time per alert. */
export function HeadlineStrip() {
  const [exam, setExam] = useState<ExamAnswer | null>();
  const [signedOut, setSignedOut] = useState(false);

  useEffect(() => {
    const load = () =>
      fetchExam()
        .then((e) => {
          setExam(e);
          setSignedOut(false);
        })
        .catch((err: unknown) => {
          // A read refused for lack of sign-in says nothing about the saved runs.
          const status = (err as { status?: unknown } | null)?.status;
          setSignedOut(status === 401 || status === 403);
          setExam(null);
        });
    void load();
    window.addEventListener(SESSION_EVENT, load);
    return () => window.removeEventListener(SESSION_EVENT, load);
  }, []);

  if (exam === undefined) return null;
  if (signedOut)
    return (
      <p className="strip" role="note" data-testid="headline-strip">
        Sign in to see the exam results. <a href={RESULTS_URL}>All results</a>
      </p>
    );
  const h = exam?.headline;
  return (
    <p className="strip" role="note" data-testid="headline-strip">
      {h && exam?.headline_sentence
        ? `70-case exam (first system, one run): ${exam.headline_sentence}${perAlertLine(h)}`
        : "No complete exam run is saved yet, so there is no headline measure to show."}{" "}
      <a href={RESULTS_URL}>All results</a>
    </p>
  );
}
