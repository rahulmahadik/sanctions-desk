import { z } from "zod";

/**
 * Nightshift model ids are routing modes, not model names. `meterless/auto` lets the runtime pick
 * for us, which makes results depend on whatever happens to be loaded, so it is never allowed.
 * Every agent is pinned to an explicit mode such as meterless/fast, meterless/deep, meterless/judge
 * or a class mode such as meterless/text.deep.
 */
export const PINNED_MODE = /^meterless\/(?!auto$)[a-z][a-z0-9._-]*$/;

export const PinnedModeSchema = z
  .string()
  .regex(PINNED_MODE, "must be a pinned Meterless mode such as meterless/fast; meterless/auto is not allowed");

/** The three lanes the configuration maps to pinned modes. */
export const LANES = ["fast", "deep", "judge"] as const;
export const LaneSchema = z.enum(LANES);
export type Lane = z.infer<typeof LaneSchema>;

/** In a policy, an agent's model is a lane name or a pinned mode. */
export const AgentModelIdSchema = z.union([LaneSchema, PinnedModeSchema]);
