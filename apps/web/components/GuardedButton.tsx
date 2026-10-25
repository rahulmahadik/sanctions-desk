"use client";

import { type ButtonHTMLAttributes, useId } from "react";

/**
 * A button that is greyed out, with the reason beside it, when `reason` is set. The reason is linked to the button
 * (aria-describedby), so a screen reader says why it cannot be pressed.
 */
export function GuardedButton({
  reason,
  disabled,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { reason?: string }) {
  const id = useId();
  return (
    <>
      <button
        type="button"
        {...props}
        disabled={disabled === true || reason !== undefined}
        aria-describedby={reason ? id : undefined}
      >
        {children}
      </button>
      {reason ? (
        <>
          {" "}
          <span id={id} className="muted">
            {reason}
          </span>
        </>
      ) : null}
    </>
  );
}
