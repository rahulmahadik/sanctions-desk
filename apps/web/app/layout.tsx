import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { FirstRun } from "../components/FirstRun";
import { HeadlineStrip } from "../components/HeadlineStrip";
import { UserSwitcher } from "../components/UserSwitcher";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sanctions Desk",
  description: "Sanctions alert review: the desk recommends, a person decides.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="top">
            <h1>Sanctions Desk</h1>
            <nav aria-label="Main">
              <Link href="/">Alert queue</Link>
              <Link href="/policy">Policy studio</Link>
              <Link href="/exam">Exam results</Link>
              <Link href="/governance">Governance</Link>
              <Link href="/help">Help</Link>
            </nav>
            <UserSwitcher />
          </header>
          <FirstRun />
          <HeadlineStrip />
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
