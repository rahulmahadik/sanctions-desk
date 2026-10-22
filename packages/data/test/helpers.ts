/** Returns the first element, failing the test if there is none (avoids non-null assertions). */
export function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error("expected a non-empty list");
  return item;
}
