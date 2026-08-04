import type { ReactElement, ReactNode } from "react";
interface StatCardProps {
  icon: ReactElement;
  label: string;
  value: ReactNode;
  sub?: ReactNode;
}

export default function StatCard({
  icon,
  label,
  value,
  sub,
}: StatCardProps) {
  return (
    <div className="card flex flex-col gap-1 pb-4">
      <div className="flex items-center gap-2">
        <span className="inline-flex text-ink-faint">{icon}</span>
        <span className="font-mono text-[0.7rem] font-medium tracking-wide text-ink-muted uppercase">
          {label}
        </span>
      </div>
      <div className="text-[1.7rem] leading-tight font-semibold">{value}</div>
      {sub ? <div className="font-mono text-[0.68rem] text-ink-faint">{sub}</div> : null}
    </div>
  );
}
