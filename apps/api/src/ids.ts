import { z } from "zod";

/**
 * A case, alert or receipt id taken from an address. Ids end up in file and folder names, so the alphabet is small,
 * the first character is a letter or digit, and `..` never appears. A plain `.` or `..` would otherwise name the
 * current or the parent folder.
 */
export const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export const SafeIdSchema = z
  .string()
  .regex(SAFE_ID_PATTERN)
  .refine((id) => !id.includes(".."), "an id may not contain '..'");
