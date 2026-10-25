"use client";

import { useEffect, useState } from "react";
import { fetchMe } from "./api";
import { type Who, whoFromError } from "./permissions";
import { SESSION_EVENT } from "./session";

/** Who is using the screen, read from /me, and read again when the person changes demo user or signs in or out. */
export function useWho(): Who {
  const [who, setWho] = useState<Who>();
  useEffect(() => {
    let live = true;
    const load = () =>
      fetchMe()
        .then((me) => {
          if (live) setWho(me);
        })
        .catch((err: unknown) => {
          if (live) setWho(whoFromError(err));
        });
    void load();
    window.addEventListener(SESSION_EVENT, load);
    return () => {
      live = false;
      window.removeEventListener(SESSION_EVENT, load);
    };
  }, []);
  return who;
}
