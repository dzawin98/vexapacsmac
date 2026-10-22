import { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type DetailHeroProps = {
  title: string;
  subtitle?: string;
  badges?: Array<{
    label: string;
    variant?: "default" | "secondary" | "destructive" | "outline";
  }>;
};

export const DetailHero = ({ title, subtitle, badges = [] }: DetailHeroProps) => (
  <div className="rounded-xl border bg-gradient-to-br from-muted/50 via-background to-muted/15 px-4 py-3">
    <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
      <div className="space-y-0.5">
        <h3 className="text-lg font-semibold leading-tight tracking-tight text-foreground">{title}</h3>
        {subtitle ? <p className="text-xs text-muted-foreground">{subtitle}</p> : null}
      </div>
      {badges.length ? (
        <div className="flex flex-wrap gap-1.5">
          {badges.map((badge, index) => (
            <Badge key={`${badge.label}-${index}`} variant={badge.variant || "secondary"} className="rounded-full px-2 py-0.5 text-[10px]">
              {badge.label}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  </div>
);

export const DetailSection = ({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) => (
  <section className={cn("rounded-xl border bg-card/70 p-3 shadow-sm", className)}>
    <div className="mb-2.5 space-y-0.5">
      <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-foreground/80">{title}</h4>
      {description ? <p className="text-[11px] text-muted-foreground">{description}</p> : null}
    </div>
    {children}
  </section>
);

export const DetailGrid = ({ children }: { children: ReactNode }) => (
  <div className="grid grid-cols-1 gap-2 md:grid-cols-2">{children}</div>
);

export const DetailItem = ({
  label,
  value,
  className,
}: {
  label: string;
  value: ReactNode;
  className?: string;
}) => (
  <div className={cn("rounded-lg border bg-background/80 px-3 py-2", className)}>
    <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
    <div className="mt-0.5 break-words text-sm leading-snug text-foreground">{value || "-"}</div>
  </div>
);
