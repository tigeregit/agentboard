"use client";

import { useEffect, useRef, type ReactNode } from "react";

/** Horizontal scroll container that starts scrolled to its right edge, so the newest columns are visible on narrow screens. */
export function ScrollEnd({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, []);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
