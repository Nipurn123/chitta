import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "context · knowledge graph",
  description: "Permission-aware knowledge graph + vector memory - visual dashboard.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
