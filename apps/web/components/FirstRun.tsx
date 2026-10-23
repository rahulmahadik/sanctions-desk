"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const KEY = "desk.tourSeen";

/** A one-time pointer for a first visit, remembered in this browser; works without storage. */
export function FirstRun() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    try {
      setShow(window.localStorage.getItem(KEY) !== "yes");
    } catch {
      setShow(true);
    }
  }, []);
  if (!show) return null;
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
      New here? The <Link href="/help">help page</Link> walks through the flow in order: choose a demo user, review an
      alert, read the result, decide, and verify the receipts.{" "}
      <button type="button" className="secondary" onClick={dismiss}>
        Dismiss
      </button>
    </p>
  );
}
