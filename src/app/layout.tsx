import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Shell } from "@/components/dashboard/shell";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "agentboard", template: "%s · agentboard" },
  description: "One dashboard over every AI coding agent's session history on this machine.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`} style={{ ["--font-sans" as string]: "var(--font-geist-sans)" }}>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
