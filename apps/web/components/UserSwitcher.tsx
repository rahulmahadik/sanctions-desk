"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchMe } from "../lib/api";
import { roleLabel } from "../lib/format";
import { getToken, SESSION_EVENT, setDemoUser, setToken } from "../lib/session";
import type { MeView } from "../lib/types";

/**
 * Who you are. In sample mode this is a labelled demo-user switcher, so a visitor can try the whole decision flow
 * (an analyst decides, an approver gives the second approval of a block) without any setup. With sign-in on, it asks
 * for the token a person was given. Demo users never work against a live deployment.
 */
export function UserSwitcher() {
  const [me, setMe] = useState<MeView>();
  const [problem, setProblem] = useState<string>();
  const [token, setTokenText] = useState("");

  const load = useCallback(() => {
    fetchMe()
      .then((m) => {
        setMe(m);
        setProblem(undefined);
      })
      .catch((err: unknown) => {
        setMe(undefined);
        setProblem(err instanceof Error ? err.message : String(err));
      });
  }, []);

  useEffect(() => {
    load();
    window.addEventListener(SESSION_EVENT, load);
    return () => window.removeEventListener(SESSION_EVENT, load);
  }, [load]);

  if (problem && getToken() === null && !me) {
    return (
      <form
        className="user-switcher"
        aria-label="Sign in"
        onSubmit={(e) => {
          e.preventDefault();
          if (token.trim() !== "") setToken(token.trim());
        }}
      >
        <label>
          Sign in with your token{" "}
          <input type="password" autoComplete="off" value={token} onChange={(e) => setTokenText(e.target.value)} />
        </label>{" "}
        <button type="submit">Sign in</button>
      </form>
    );
  }
  if (!me) return <div className="user-switcher muted">{problem ?? "…"}</div>;

  if (me.demo_users.length > 0) {
    return (
      <div className="user-switcher">
        <label>
          <span className="badge tone-wait">Demo user</span>{" "}
          <select
            aria-label="Demo user (sample mode only)"
            value={me.user.demo ? me.user.id : ""}
            onChange={(e) => setDemoUser(e.target.value === "" ? null : e.target.value)}
          >
            <option value="">Visitor (can review, cannot decide)</option>
            {me.demo_users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.id} — {roleLabel(u.role)}
              </option>
            ))}
          </select>
        </label>
      </div>
    );
  }
  return (
    <div className="user-switcher">
      Signed in as <strong>{me.user.id}</strong> <span className="muted">({roleLabel(me.user.role)})</span>{" "}
      <button
        type="button"
        className="secondary"
        onClick={() => {
          // The token box keeps what was typed; clear it so the next person does not find the last token there.
          setTokenText("");
          setToken(null);
        }}
      >
        Sign out
      </button>
    </div>
  );
}
