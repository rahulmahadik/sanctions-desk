// Retries and timeouts shared by the connectors.
export async function withRetry(label, fn, { tries = 3, delayMs = 200 } = {}) {
  let last;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (attempt < tries) await new Promise((r) => setTimeout(r, delayMs * attempt));
    }
  }
  throw new Error(`${label} failed after ${tries} tries: ${last?.message}`);
}
