"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconLayoutDashboard, IconFolders, IconPlugConnected, IconReportAnalytics, IconTerminal2 } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { ScanButton } from "./scan-button";

const NAV = [
  { href: "/", label: "Sessions", icon: IconLayoutDashboard },
  { href: "/projects", label: "Projects", icon: IconFolders },
  { href: "/summary", label: "Reports", icon: IconReportAnalytics },
  { href: "/sources", label: "Sources", icon: IconPlugConnected },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-20 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground">
              <IconTerminal2 className="size-4" />
            </span>
            <span className="hidden sm:inline">agentboard</span>
          </Link>
          <nav className="ml-2 flex items-center gap-1 overflow-x-auto">
            {NAV.map((n) => {
              const active = n.href === "/" ? pathname === "/" || pathname.startsWith("/sessions") : pathname.startsWith(n.href);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                    active && "bg-muted text-foreground",
                  )}
                >
                  <n.icon className="size-4" />
                  <span className="hidden md:inline">{n.label}</span>
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <ScanButton />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">{children}</main>
      <footer className="border-t py-4 text-center text-xs text-muted-foreground">
        Same engine as the CLI: <code className="rounded bg-muted px-1 py-0.5">agentboard list --since 7d --json</code> · API at <code className="rounded bg-muted px-1 py-0.5">/api/sessions</code>
      </footer>
    </div>
  );
}
