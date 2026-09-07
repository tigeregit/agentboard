"use client";

import { useState } from "react";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      window.prompt("Copy:", text);
    }
  }
  return (
    <Button variant="outline" size="sm" onClick={copy} title={text}>
      {done ? <IconCheck className="size-3.5" /> : <IconCopy className="size-3.5" />}
      {done ? "Copied" : label}
    </Button>
  );
}
