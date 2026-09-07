import Link from "next/link";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import { buttonVariants } from "@/components/ui/button";
import { href, type DashboardFilters } from "@/lib/query";
import { cn } from "@/lib/utils";

export function Pagination({ pathname, filters, total }: { pathname: string; filters: DashboardFilters; total: number }) {
  const pages = Math.max(1, Math.ceil(total / filters.pageSize));
  if (pages <= 1) return null;
  const page = Math.min(filters.page, pages);
  const link = (p: number, disabled: boolean, children: React.ReactNode, label: string) => (
    <Link
      href={href(pathname, { ...filters, page: p })}
      aria-disabled={disabled}
      aria-label={label}
      className={cn(buttonVariants({ variant: "outline", size: "sm" }), disabled && "pointer-events-none opacity-50")}
    >
      {children}
    </Link>
  );
  return (
    <nav className="flex items-center justify-between gap-3 text-sm text-muted-foreground" aria-label="Pagination">
      <span>
        {(page - 1) * filters.pageSize + 1}–{Math.min(total, page * filters.pageSize)} of {total}
      </span>
      <div className="flex items-center gap-1">
        {link(page - 1, page <= 1, <IconChevronLeft className="size-4" />, "Previous page")}
        <span className="px-2 tabular-nums">
          {page} / {pages}
        </span>
        {link(page + 1, page >= pages, <IconChevronRight className="size-4" />, "Next page")}
      </div>
    </nav>
  );
}
