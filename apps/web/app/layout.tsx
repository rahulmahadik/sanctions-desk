import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
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
              <Link href="/exam">Exam results</Link>
            </nav>
          </header>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
