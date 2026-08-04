import { useQuery } from "@tanstack/react-query";
import ActivityFeed from "../components/ActivityFeed";
import StatCard from "../components/StatCard";
import { useLive } from "../context/LiveContext";
import { IconActivity, IconDatabase, IconServer, IconUsers } from "../icons";
import { api } from "../lib/api";
import { formatNumber, formatUptime } from "../lib/format";

export default function DashboardPage() {
  const { metrics, activities } = useLive();
  const statsQuery = useQuery({ queryKey: ["store-stats"], queryFn: api.storeStats });
  const stats = statsQuery.data;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 min-[560px]:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={<IconDatabase size={18} />}
          label="Collections"
          value={stats ? formatNumber(stats.collectionCount) : "—"}
          sub={stats ? `${formatNumber(stats.documentCount)} documents` : "loading storage"}
        />
        <StatCard
          icon={<IconActivity size={18} />}
          label="Requests / min"
          value={metrics ? formatNumber(metrics.requestsPerMin) : "—"}
          sub={metrics ? `${formatNumber(metrics.requestsTotal)} total` : "waiting for data"}
        />
        <StatCard
          icon={<IconServer size={18} />}
          label="Server uptime"
          value={metrics ? formatUptime(metrics.uptimeSecs) : "—"}
          sub={stats ? stats.dataPath : "waiting for data"}
        />
        <StatCard
          icon={<IconUsers size={18} />}
          label="Clients online"
          value={metrics ? String(metrics.wsClients) : "—"}
          sub={metrics ? `server up ${formatUptime(metrics.uptimeSecs)}` : "waiting for data"}
        />
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1fr_1fr]">
        <section className="card">
          <div className="card-head">
            <h2>Storage</h2>
            <span className="card-hint">local filesystem</span>
          </div>
          <dl className="flex flex-col text-sm">
            <div className="flex justify-between gap-4 border-b border-line py-2">
              <dt className="text-ink-muted">Data directory</dt>
              <dd className="m-0 max-w-[60%] truncate font-mono text-[0.78rem]">{stats?.dataPath ?? "…"}</dd>
            </div>
            <div className="flex justify-between gap-4 py-2">
              <dt className="text-ink-muted">Automatic indexes</dt>
              <dd className="m-0">scalar fields</dd>
            </div>
          </dl>
        </section>
        <section className="card">
          <div className="card-head">
            <h2>Activity</h2>
            <span className="card-hint">server events</span>
          </div>
          <ActivityFeed activities={activities} />
        </section>
      </div>
    </div>
  );
}
