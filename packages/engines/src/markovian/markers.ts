// Derived from the Meterless Markovian reference implementation, Apache-2.0.
// Marker protocol. Canonical markers are square-bracket: [STATE_CHECKPOINT] and [TASK_COMPLETE], with
// the listed compatible variants. Angle-bracket forms (<CARRYOVER>, <DONE>, <PROGRESS>, <NEEDS_TOOL .../>)
// are accepted as extra aliases. Cleaning strips every form from display text.

export interface ParsedMarkers {
  /** Text captured after or inside a state marker. */
  state?: string;
  /** The final completion marker is present. */
  done: boolean;
  progress?: string;
  needsTool?: { tool: string; input: string };
  needsClarification?: string;
  /** Display-safe content with every marker removed. */
  cleaned: string;
}

const STATE_BLOCK = /<CARRYOVER>([\s\S]*?)<\/CARRYOVER>/g;
const STATE_TAILS = [
  /\[STATE_CHECKPOINT\]\s*([\s\S]*)$/,
  /@@@STATE@@@\s*([\s\S]*)$/,
  /(?<!_)\[STATE\]\s*([\s\S]*)$/,
  /---STATE---\s*([\s\S]*)$/,
];
const FINAL_MARKERS = [/\[TASK_COMPLETE\]/, /@@@FINAL@@@/, /(?<!_)\[FINAL\]/, /---FINAL---/, /<DONE\s*\/?>/];
const PROGRESS_BLOCK = /<PROGRESS>([\s\S]*?)<\/PROGRESS>/;
const NEEDS_TOOL = /[<[]NEEDS_TOOL\s+tool="([^"]+)"\s+input=(?:"([^"]*)"|'([^']*)')\s*\/?[\]>]/;
const NEEDS_CLARIFICATION = /[<[]NEEDS_CLARIFICATION[\]>]\s*([^\n]*)/;

function stateOf(raw: string): string | undefined {
  const blocks = [...raw.matchAll(STATE_BLOCK)];
  const last = blocks.at(-1);
  if (last) return (last[1] ?? "").trim();
  for (const re of STATE_TAILS) {
    const m = raw.match(re);
    if (m) return (m[1] ?? "").trim();
  }
  return undefined;
}

export function parseMarkers(raw: string): ParsedMarkers {
  const progress = raw.match(PROGRESS_BLOCK);
  const tool = raw.match(NEEDS_TOOL);
  const clarification = raw.match(NEEDS_CLARIFICATION);
  return {
    state: stateOf(raw),
    done: FINAL_MARKERS.some((re) => re.test(raw)),
    progress: progress ? (progress[1] ?? "").trim() : undefined,
    needsTool: tool ? { tool: tool[1] ?? "", input: tool[2] ?? tool[3] ?? "" } : undefined,
    needsClarification: clarification ? (clarification[1] ?? "").trim() : undefined,
    cleaned: cleanMarkers(raw),
  };
}

export function cleanMarkers(raw: string): string {
  let out = raw;
  out = out.replace(/<CARRYOVER>[\s\S]*?<\/CARRYOVER>/g, "");
  out = out.replace(/<PROGRESS>[\s\S]*?<\/PROGRESS>/g, "");
  out = out.replace(/[<[]NEEDS_TOOL[^\]>]*[\]>]/g, "");
  out = out.replace(/[<[]NEEDS_CLARIFICATION[\]>][^\n]*/g, "");
  out = out.replace(/\[STATE_CHECKPOINT\][\s\S]*$/, "");
  out = out.replace(/@@@STATE@@@[\s\S]*$/, "");
  out = out.replace(/---STATE---[\s\S]*$/, "");
  // A bare [STATE] tail only counts when it starts a line, so prose is not eaten.
  out = out.replace(/\n\[STATE\][\s\S]*$/, "");
  for (const re of [/\[TASK_COMPLETE\]/g, /@@@FINAL@@@/g, /---FINAL---/g, /<DONE\s*\/?>/g]) out = out.replace(re, "");
  out = out.replace(/\n\[FINAL\][\s\S]*$/, "");
  return out
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
