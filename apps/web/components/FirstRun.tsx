"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchMe } from "../lib/api";
import { SESSION_EVENT } from "../lib/session";

const KEY = "desk.tourSeen";

/** How a first visitor starts: pick a demo user (sample mode), sign in (live, signed out), or nothing to pick. */
type Start = "demo" | "sign-in" | "signed-in";

const STEPS: Record<Start, string> = {
  demo: "choose a demo user, review an alert, read the result, decide, and verify the receipts.",
  "sign-in": "review an alert, read the result, decide, and verify the receipts.",
  "signed-in": "review an alert, read the result, decide, and verify the receipts.",
};

/**
 * A one-time pointer for a first visit, remembered in this browser; works without storage. Demo users exist only in
 * sample mode, so a live desk asks for the token instead.
 */
export function FirstRun() {
  const [show, setShow] = useState(false);
  const [start, setStart] = useState<Start>();
  useEffect(() => {
    try {
      setShow(window.localStorage.getItem(KEY) !== "yes");
    } catch {
      setShow(true);
    }
    // Asked again when someone signs in or out, so the sign-in prompt goes once a token is accepted.
    const read = () =>
      fetchMe()
        .then((me) => setStart(me.demo_users.length > 0 ? "demo" : "signed-in"))
        .catch((err: unknown) =>
          setStart((err as { status?: unknown } | null)?.status === 401 ? "sign-in" : "signed-in"),
        );
    read();
    window.addEventListener(SESSION_EVENT, read);
    return () => window.removeEventListener(SESSION_EVENT, read);
  }, []);
  if (!show || start === undefined) return null;
  const dismiss = () => {
    try {
      window.localStorage.setItem(KEY, "yes");
    } catch {
      // the notice returns on the next visit; nothing else depends on it
    }
    setShow(false);
  };
  return (
    <p className="banner" role="note" data-testid="first-run">
      {start === "sign-in" ? "Sign in with your token to start. " : ""}
      New here? The <Link href="/help">help page</Link> walks through the flow in order: {STEPS[start]}{" "}
      <button type="button" className="secondary" onClick={dismiss}>
        Dismiss
      </button>
    </p>
  );
}
