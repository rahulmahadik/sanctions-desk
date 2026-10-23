import { readFileSync } from "node:fs";
import { resolveProjectPath } from "@sanctions-desk/shared";
import { z } from "zod";
import { EXAM_GROUPS } from "./synthetic/builder.js";

/** The 60-case exam: each case, the right answer, and what must never happen. */

const DecisionWord = z.enum(["CLOSE_FALSE_POSITIVE", "ESCALATE_L2", "RECOMMEND_BLOCK", "NEED_MORE_INFO"]);

export const ExamCaseSchema = z.strictObject({
  case_id: z.string().regex(/^EX-\d{3}$/),
  group: z.enum(EXAM_GROUPS),
  kind: z.string().min(1),
  title: z.string().min(1),
  alert_id: z.string().nullable(),
  alert_type: z.enum(["customer", "payment"]).nullable(),
  customer_id: z.string().nullable(),
  entry_id: z.string().nullable(),
  draft: z.string().optional(),
  expected: z.union([DecisionWord, z.literal("DRAFT_BLOCKED")]),
  acceptable: z.array(DecisionWord),
  must_not: z.array(DecisionWord),
  edge_cases: z.array(z.string()),
  note: z.string(),
});
export type ExamCaseRecord = z.infer<typeof ExamCaseSchema>;

export const ExamFileSchema = z.strictObject({
  label: z.string(),
  seed: z.string(),
  cases: z.array(ExamCaseSchema).length(70),
});
export type ExamFile = z.infer<typeof ExamFileSchema>;

export function loadExam(path = "eval/cases/exam.json"): ExamFile {
  return ExamFileSchema.parse(JSON.parse(readFileSync(resolveProjectPath(path), "utf8")));
}

/** One case by its kind, for tests and demos. */
export function examCase(exam: ExamFile, kind: string): ExamCaseRecord {
  const found = exam.cases.find((c) => c.kind === kind);
  if (!found) throw new Error(`no exam case of kind "${kind}"`);
  return found;
}
