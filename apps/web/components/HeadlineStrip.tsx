"use client";

import { useEffect, useState } from "react";
import { fetchExam } from "../lib/api";
import type { ExamAnswer } from "../lib/types";

/**
 * A line across the top: what the first system's 70-case exam run did with the risk cases, and the time per alert of
 * the current system's newest run, named.
 */
export function HeadlineStrip() {
  const [exam, setExam] = useState<ExamAnswer | null>();

  useEffect(() => {
    fetchExam()
      .then(setExam)
      .catch(() => setExam(null));
  }, []);

  if (exam === undefined) return null;
  const h = exam?.headline;
  return (
    <p className="strip" role="note" data-testid="headline-strip">
      {h && exam?.headline_sentence
        ? `70-case exam (first system, one run): ${exam.headline_sentence}`
        : "No complete exam run is saved yet, so there is no headline measure to show."}
      {exam?.current_run
        ? ` Current system: a median of ${exam.current_run.median_seconds.toFixed(0)} seconds per alert (measured) in run ${exam.current_run.name} of ${exam.current_run.started_at.slice(0, 10)}, ${exam.current_run.alerts} alerts.`
        : ""}
    </p>
  );
}
