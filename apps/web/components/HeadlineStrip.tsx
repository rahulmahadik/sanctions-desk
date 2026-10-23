"use client";

import { useEffect, useState } from "react";
import { fetchExam } from "../lib/api";
import type { ExamAnswer } from "../lib/types";

/** A line across the top with the measure the desk is judged by, from the newest complete exam run. */
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
        ? `Latest exam (full system): ${exam.headline_sentence}`
        : "No complete exam run is saved yet, so there is no headline measure to show."}
    </p>
  );
}
