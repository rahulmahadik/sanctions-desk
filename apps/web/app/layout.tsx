import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { HeadlineStrip } from "../components/HeadlineStrip";
import { UserSwitcher } from "../components/UserSwitcher";
import "./globals.css";

export const metadata: Metadata = {
  title: "Review desk",
  description: "Sanctions alert review: the desk recommends, a person decides.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="top">
            <h1>Sanctions review desk</h1>
            <nav aria-label="Main">
              <Link href="/">Alert queue</Link>
              <Link href="/policy">Policy studio</Link>
              <Link href="/exam">Exam results</Link>
              <Link href="/governance">Governance</Link>
            </nav>
            <UserSwitcher />
          </header>
          <HeadlineStrip />
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
