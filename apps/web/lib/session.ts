/**
 * Who is using the desk. In sample mode a visitor picks a demo user; with auth on they paste the token they were
 * given. Both live only in this browser's local storage, which may be unavailable (private window), so every read and
 * write is guarded and the desk works without it as a read-only visitor.
 */
const USER = "desk.demoUser";
const TOKEN = "desk.token";
export const SESSION_EVENT = "desk-session-changed";

const read = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string | null): void => {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // storage is blocked; the choice lasts until the page is reloaded
  }
  window.dispatchEvent(new Event(SESSION_EVENT));
};

const getDemoUser = (): string | null => (typeof window === "undefined" ? null : read(USER));
export const setDemoUser = (id: string | null): void => write(USER, id);
export const getToken = (): string | null => (typeof window === "undefined" ? null : read(TOKEN));
export const setToken = (token: string | null): void => write(TOKEN, token);

/** Headers for the API. The token is sent only in the Authorization header, never in a URL. */
export function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = getToken();
  const demo = getDemoUser();
  if (token) headers.authorization = `Bearer ${token}`;
  else if (demo) headers["x-demo-user"] = demo;
  return headers;
}
