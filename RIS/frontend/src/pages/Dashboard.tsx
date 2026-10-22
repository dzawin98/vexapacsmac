import { useCallback, useEffect, useState } from "react";
import { ClipboardList, ScanLine, Stethoscope, ShieldCheck } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import LoadingScreen from "@/components/LoadingScreen";
import { useToast } from "@/hooks/use-toast";
import { dicomWebService, StatisticsData } from "@/lib/dicomService";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const COLORS = ["#2563eb", "#0f766e", "#ea580c", "#7c3aed", "#dc2626", "#0891b2", "#65a30d", "#ca8a04"];

const Dashboard = () => {
  const [stats, setStats] = useState<StatisticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [recapFilter, setRecapFilter] = useState<"all" | "today" | "7days" | "lastMonth" | "range">("today");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const { toast } = useToast();
  const chartMuted = "hsl(var(--muted-foreground))";
  const chartForeground = "hsl(var(--foreground))";
  const chartBorder = "hsl(var(--border))";
  const chartSurface = "hsl(var(--card))";

  const formatDateKey = (date: Date) => {
    const year = String(date.getFullYear()).padStart(4, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}${month}${day}`;
  };

  const parseInputDateKey = (value: string) => {
    const digits = String(value || "").replace(/[^0-9]/g, "");
    return digits.length >= 8 ? digits.slice(0, 8) : "";
  };

  const getRecapRange = useCallback(() => {
    if (recapFilter === "today") {
      const key = formatDateKey(new Date());
      return { start: key, end: key };
    }
    if (recapFilter === "7days") {
      const end = new Date();
      const start = new Date();
      start.setDate(end.getDate() - 6);
      return { start: formatDateKey(start), end: formatDateKey(end) };
    }
    if (recapFilter === "lastMonth") {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 0);
      return { start: formatDateKey(start), end: formatDateKey(end) };
    }
    if (recapFilter === "range") {
      return { start: parseInputDateKey(fromDate), end: parseInputDateKey(toDate) };
    }
    return { start: "", end: "" };
  }, [fromDate, recapFilter, toDate]);

  const formatRecapLabel = (value: string) => {
    const digits = String(value || "").replace(/[^0-9]/g, "");
    if (digits.length >= 8) {
      const year = Number(digits.slice(0, 4));
      const month = Number(digits.slice(4, 6));
      const day = Number(digits.slice(6, 8));
      return new Date(year, month - 1, day).toLocaleDateString("id-ID", {
        day: "2-digit",
        month: "short",
      });
    }
    if (digits.length >= 6) {
      const year = Number(digits.slice(0, 4));
      const month = Number(digits.slice(4, 6));
      return new Date(year, month - 1, 1).toLocaleDateString("id-ID", {
        month: "short",
        year: "numeric",
      });
    }
    return value;
  };

  useEffect(() => {
    const loadStats = async () => {
      try {
        const range = getRecapRange();
        const data = await dicomWebService.fetchStatistics({
          startDate: range.start || undefined,
          endDate: range.end || undefined,
        });
        setStats(data);
      } catch (error) {
        console.error("Failed to load dashboard stats", error);
        toast({
          title: "Failed to load dashboard",
          description: "Dashboard data could not be retrieved.",
          variant: "destructive",
        });
      } finally {
        setLoading(false);
      }
    };
    loadStats();
  }, [getRecapRange, toast]);

  if (loading) return <LoadingScreen />;

  const summary = stats?.dashboardSummary;
  const cards = [
    {
      label: "TOTAL STUDY PACS",
      value: stats?.totalStudies || 0,
      icon: ClipboardList,
    },
    {
      label: "TECHNOLOGIST PROCESSED",
      value: summary?.technologistProcessed || 0,
      icon: ScanLine,
    },
    {
      label: "REPORTING",
      value: `${summary?.radiologist.read || 0}/${summary?.radiologist.total || 0}`,
      icon: Stethoscope,
    },
    {
      label: "DISTRIBUTION",
      value: `${summary?.qualityControl.done || 0}/${summary?.qualityControl.total || 0}`,
      icon: ShieldCheck,
    },
  ];

  const modalityData =
    stats?.modalities.map((item, index) => ({
      ...item,
      color: COLORS[index % COLORS.length],
    })) || [];
  const studyDescriptionData = stats?.studyDescriptions || [];
  const topStudies = studyDescriptionData.slice(0, 3);
  const totalStudyDescriptionCount = studyDescriptionData.reduce((total, item) => total + item.count, 0);

  return (
    <div className="dashboard-command-surface space-y-6 pb-10 animate-fade-in">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-1">
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">Data Summary</p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Select value={recapFilter} onValueChange={value => setRecapFilter(value as typeof recapFilter)}>
            <SelectTrigger className="h-10 w-full rounded-xl border-border/70 bg-background sm:w-[170px]">
              <SelectValue placeholder="Period" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Day</SelectItem>
              <SelectItem value="today">Today</SelectItem>
              <SelectItem value="7days">7 Days</SelectItem>
              <SelectItem value="lastMonth">1 Month</SelectItem>
              <SelectItem value="range">Custom</SelectItem>
            </SelectContent>
          </Select>

          {recapFilter === "range" && (
            <>
              <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="h-10 rounded-xl" />
              <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="h-10 rounded-xl" />
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {cards.map(card => (
          <div key={card.label} className="dashboard-metric rounded-2xl border p-5">
            <div className="mb-4 flex items-center justify-between">
              <p className="metric-label">{card.label}</p>
              <card.icon className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="text-3xl font-bold text-foreground">{card.value}</p>
            <p className="mt-2 text-sm text-muted-foreground">{card.sublabel}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_1fr]">
        <div className="dashboard-panel rounded-2xl border p-5">
          <div className="mb-4">
            <h2 className="section-title">Study by Modality</h2>
          </div>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            {modalityData.length > 0 ? (
              modalityData.map(item => (
                <div key={item.name} className="dashboard-soft-block rounded-xl px-4 py-3">
                  <p className="metric-label tracking-[0.1em]">{item.name}</p>
                  <p className="mt-1 text-2xl font-bold text-foreground">{item.count}</p>
                </div>
              ))
            ) : (
              <div className="dashboard-soft-block col-span-full rounded-xl px-4 py-6 text-sm text-muted-foreground">
                There is no data/Please Choose Filter.
              </div>
            )}
          </div>

          <div className="mt-6 h-[260px]">
            {stats?.monthlyRecap && stats.monthlyRecap.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats.monthlyRecap} margin={{ top: 10, right: 10, left: -24, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={chartBorder} />
                  <XAxis
                    dataKey="month"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 12, fontWeight: 500, fill: chartMuted }}
                    tickFormatter={value => formatRecapLabel(String(value))}
                  />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 12, fontWeight: 500, fill: chartMuted }}
                  />
                  <Tooltip
                    contentStyle={{
                      borderRadius: "12px",
                      border: `1px solid ${chartBorder}`,
                      boxShadow: "none",
                      backgroundColor: chartSurface,
                      color: chartForeground,
                      fontFamily: '"Segoe UI", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif',
                    }}
                    itemStyle={{ color: chartForeground }}
                    labelStyle={{ color: chartForeground }}
                    labelFormatter={value => formatRecapLabel(String(value))}
                    formatter={value => [value, "Order"]}
                  />
                  <Bar dataKey="count" fill="hsl(var(--foreground))" radius={[6, 6, 0, 0]} barSize={26} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">There is no data.</div>
            )}
          </div>
        </div>

        <div className="dashboard-panel rounded-2xl border p-5">
          <div className="mb-4">
            <h2 className="section-title">Modality Composition</h2>
          </div>

          <div className="h-[420px]">
            {modalityData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={modalityData}
                    cx="50%"
                    cy="48%"
                    innerRadius={70}
                    outerRadius={120}
                    paddingAngle={3}
                    dataKey="count"
                    nameKey="name"
                    stroke="none"
                    strokeWidth={0}
                  >
                    {modalityData.map((entry, index) => (
                      <Cell key={index} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      borderRadius: "12px",
                      border: `1px solid ${chartBorder}`,
                      boxShadow: "none",
                      backgroundColor: chartSurface,
                      color: chartForeground,
                      fontFamily: '"Segoe UI", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif',
                    }}
                    itemStyle={{ color: chartForeground }}
                    labelStyle={{ color: chartForeground }}
                    formatter={value => [value, "Total"]}
                  />
                  <Legend
                    iconType="circle"
                    verticalAlign="bottom"
                    wrapperStyle={{ fontSize: "12px", fontWeight: 500, color: chartForeground }}
                    formatter={value => <span style={{ color: chartForeground }}>{value}</span>}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">There is no data.</div>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_1fr]">
        <div className="dashboard-panel rounded-2xl border p-5">
          <div className="mb-4">
            <h2 className="section-title">Study Description</h2>
          </div>

          <div className="space-y-3">
            {studyDescriptionData.length > 0 ? (
              studyDescriptionData.map(item => {
                const percentage = totalStudyDescriptionCount
                  ? Math.round((item.count / totalStudyDescriptionCount) * 100)
                  : 0;

                return (
                  <div key={item.name} className="dashboard-soft-block rounded-xl px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="truncate text-sm font-semibold text-foreground" title={item.name}>
                        {item.name}
                      </p>
                      <p className="shrink-0 text-sm font-bold text-foreground">{item.count} Study</p>
                    </div>
                    <div className="dashboard-progress-track mt-3 h-1.5 overflow-hidden rounded-full">
                      <div
                        className="dashboard-progress-fill h-full rounded-full"
                        style={{ width: `${Math.max(percentage, item.count > 0 ? 6 : 0)}%` }}
                      />
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="dashboard-soft-block rounded-xl px-4 py-6 text-sm text-muted-foreground">
                There is no study description data.
              </div>
            )}
          </div>
        </div>

        <div className="dashboard-panel rounded-2xl border p-5">
          <div className="mb-4">
            <h2 className="section-title">Top Study</h2>
          </div>

          {topStudies.length > 0 ? (
            <div className="space-y-3">
              {topStudies.map(item => {
                const percentage = totalStudyDescriptionCount
                  ? Math.round((item.count / totalStudyDescriptionCount) * 100)
                  : 0;

                return (
                  <div key={item.name} className="dashboard-soft-block rounded-xl px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="truncate text-sm font-semibold text-foreground" title={item.name}>
                        {item.name}
                      </p>
                      <p className="shrink-0 text-sm font-bold text-foreground">{item.count} Study</p>
                    </div>
                    <div className="dashboard-progress-track mt-3 h-1.5 overflow-hidden rounded-full">
                      <div
                        className="dashboard-progress-fill h-full rounded-full"
                        style={{ width: `${Math.max(percentage, item.count > 0 ? 6 : 0)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="dashboard-soft-block rounded-xl px-4 py-6 text-sm text-muted-foreground">
              There is no top study data.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
