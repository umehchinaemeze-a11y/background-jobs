import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Background Jobs — Order Confirmation Emails",
  description:
    "PostgreSQL-backed background job system for transactional email delivery.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}