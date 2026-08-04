import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useToast } from "../context/ToastContext";
import { IconActivity, IconDatabase, IconRefresh, IconServer, IconUsers } from "../icons";
import { api, type RequestTrace } from "../lib/api";
import { formatNumber, formatUptime, timeAgo } from "../lib/format";
import StatCard from "../components/StatCard";
import { useLive } from "../context/LiveContext";

type Filter = "all" | "data" | "admin" | "errors";

function traceMatches(trace: RequestTrace, filter: Filter) {
  if (filter === "data") return trace.path.startsWith("/data");
  if (filter === "admin") return trace.path.startsWith("/api");
  if (filter === "errors") return trace.status >= 400;
  return true;
}

function statusTone(status: number) {
  if (status >= 500) return "text-err bg-err-soft";
  if (status >= 400) return "text-warn bg-warn-soft";
  if (status >= 300) return "text-info bg-info-soft";
  return "text-ok bg-ok-soft";
}

export default function ObservabilityPage() {
  const { notifyError, push } = useToast();
  const { metrics } = useLive();
  const [filter, setFilter] = useState<Filter>("all");
  const requestsQuery = useQuery({
    queryKey: ["recent-requests"],
    queryFn: () => api.requests(150),
    refetchInterval: 3_000,
  });
  const collectionsQuery = useQuery({
    queryKey: ["collections"],
    queryFn: api.collections,
    refetchInterval: 10_000,
  });
  const statsQuery = useQuery({
    queryKey: ["store-stats"],
    queryFn: api.storeStats,
    refetchInterval: 10_000,
  });
  const compactMutation = useMutation({
    mutationFn: api.compact,
    onSuccess: () => push("success", "Store compacted"),
    onError: notifyError,
  });

  const allTraces = requestsQuery.data?.data ?? [];
  const traces = useMemo(
    () => allTraces.filter((trace) => trace.path !== "/api/requests" && traceMatches(trace, filter)),
    [allTraces, filter],
  );
  const errorCount = allTraces.filter((trace) => trace.status >= 400).length;
  const errorRate = allTraces.length ? (errorCount / allTraces.length) * 100 : 0;
  const averageLatency = allTraces.length
    ? allTraces.reduce((sum, trace) => sum + trace.durationMs, 0) / allTraces.length
    : 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 min-[560px]:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={<IconActivity size={18} />} label="Request rate" value={metrics ? formatNumber(metrics.requestsPerMin) : "-"} sub={metrics ? `${formatNumber(metrics.requestsTotal)} total` : "waiting for metrics"} />
        <StatCard icon={<IconServer size={18} />} label="Recent latency" value={`${averageLatency.toFixed(1)} ms`} sub={`${allTraces.length} observed requests`} />
        <StatCard icon={<IconActivity size={18} />} label="Error rate" value={`${errorRate.toFixed(1)}%`} sub={`${errorCount} responses >= 400`} />
        <StatCard icon={<IconUsers size={18} />} label="Live clients" value={metrics ? String(metrics.wsClients) : "-"} sub={metrics ? `up ${formatUptime(metrics.uptimeSecs)}` : "waiting for metrics"} />
      </div>

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section className="overflow-hidden rounded-lg border border-line bg-surface shadow-sm">
          <div className="flex min-h-12 flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-3 py-2">
            <div className="mr-auto">
              <h2 className="text-[0.9rem] font-semibold">Request stream</h2>
              <span className="font-mono text-[0.67rem] text-ink-faint">last 500 requests, refreshed every 3 s</span>
            </div>
            <div className="inline-flex rounded-md border border-line bg-surface p-0.5">
              {(["all", "data", "admin", "errors"] as Filter[]).map((entry) => (
                <button key={entry} className={`rounded px-2.5 py-1 text-[0.72rem] font-medium capitalize ${filter === entry ? "bg-accent text-on-accent" : "text-ink-muted hover:bg-surface-2 hover:text-ink"}`} onClick={() => setFilter(entry)}>{entry}</button>
              ))}
            </div>
            <button className="icon-btn size-8" onClick={() => requestsQuery.refetch()} title="Refresh request stream" aria-label="Refresh request stream"><IconRefresh size={15} /></button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-line text-left font-mono text-[0.67rem] text-ink-faint uppercase">
                  <th className="px-3 py-2 font-medium">Method</th>
                  <th className="px-3 py-2 font-medium">Path</th>
                  <th className="px-3 py-2 text-right font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Duration</th>
                  <th className="px-3 py-2 text-right font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {traces.map((trace, index) => (
                  <tr key={`${trace.timestampMs}-${index}`} className="border-b border-line last:border-b-0 hover:bg-surface-2">
                    <td className="px-3 py-2"><span className="font-mono text-[0.72rem] font-semibold text-info">{trace.method}</span></td>
                    <td className="max-w-[420px] truncate px-3 py-2 font-mono text-[0.76rem]">{trace.path}</td>
                    <td className="px-3 py-2 text-right"><span className={`rounded px-1.5 py-0.5 font-mono text-[0.67rem] ${statusTone(trace.status)}`}>{trace.status}</span></td>
                    <td className="px-3 py-2 text-right font-mono text-[0.72rem] text-ink-muted">{trace.durationMs.toFixed(1)} ms</td>
                    <td className="px-3 py-2 text-right font-mono text-[0.72rem] text-ink-faint">{timeAgo(trace.timestampMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!traces.length ? <p className="p-4 text-sm text-ink-faint">No matching requests</p> : null}
          </div>
        </section>

        <div className="flex flex-col gap-4">
          <section className="rounded-lg border border-line bg-surface p-4 shadow-sm">
            <div className="mb-3 flex items-center gap-2">
              <IconDatabase size={16} className="text-accent" />
              <h2 className="text-[0.9rem] font-semibold">Storage</h2>
            </div>
            <dl className="flex flex-col text-sm">
              <div className="flex justify-between gap-3 border-b border-line py-2"><dt className="text-ink-muted">Collections</dt><dd className="m-0 font-medium">{statsQuery.data ? formatNumber(statsQuery.data.collectionCount) : "-"}</dd></div>
              <div className="flex justify-between gap-3 border-b border-line py-2"><dt className="text-ink-muted">Documents</dt><dd className="m-0 font-medium">{statsQuery.data ? formatNumber(statsQuery.data.documentCount) : "-"}</dd></div>
              <div className="flex justify-between gap-3 py-2"><dt className="text-ink-muted">Path</dt><dd className="m-0 max-w-[65%] truncate font-mono text-[0.68rem]">{statsQuery.data?.dataPath ?? "-"}</dd></div>
            </dl>
            <button className="btn btn-secondary btn-sm mt-3 w-full" onClick={() => compactMutation.mutate()} disabled={compactMutation.isPending}>
              <IconRefresh size={14} /> Compact store
            </button>
          </section>

          <section className="overflow-hidden rounded-lg border border-line bg-surface shadow-sm">
            <div className="border-b border-line bg-surface-2 px-4 py-3"><h2 className="text-[0.9rem] font-semibold">Collection indexes</h2></div>
            <ul className="max-h-[310px] overflow-y-auto divide-y divide-line">
              {(collectionsQuery.data?.data ?? []).map((collection) => (
                <li key={collection.name} className="px-4 py-3">
                  <div className="flex items-center gap-2"><strong className="min-w-0 flex-1 truncate font-mono text-[0.76rem]">{collection.name}</strong><span className="font-mono text-[0.68rem] text-ink-faint">{collection.count}</span></div>
                  <p className="mt-1 truncate font-mono text-[0.66rem] text-ink-faint">{collection.indexes.join(", ") || "No scalar indexes"}</p>
                </li>
              ))}
              {!collectionsQuery.data?.data.length ? <li className="px-4 py-3 text-sm text-ink-faint">No collections</li> : null}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
