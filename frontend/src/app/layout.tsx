import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OnDemand Chat MVP",
  description: "Split frontend/backend chat MVP",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
