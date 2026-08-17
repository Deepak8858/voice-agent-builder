'use client';

import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';

/**
 * Every recharts import in the dashboard lives in this file.
 *
 * recharts pulls in d3 and is one of the largest client chunks in the app.
 * Keeping it isolated here lets `analytics-panel` load it with `next/dynamic`,
 * so the analytics route's initial JS no longer carries the charting library
 * for users who never scroll to a chart.
 */

const TOOLTIP_STYLE = {
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: '8px',
  fontSize: '12px',
} as const;

const AXIS_TICK = { fontSize: 11, fill: 'var(--muted-foreground)' } as const;

export interface CallVolumePoint {
  date: string;
  label: string;
  calls: number;
  success: number;
  failed: number;
}

export function CallVolumeChart({ data }: { data: CallVolumePoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
        <defs>
          <linearGradient id="colorCalls" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="colorSuccess" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis
          dataKey="label"
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
        />
        <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} />
        <Tooltip contentStyle={TOOLTIP_STYLE} />
        <Legend wrapperStyle={{ fontSize: '12px' }} />
        <Area
          type="monotone"
          dataKey="calls"
          name="Total calls"
          stroke="#6366f1"
          strokeWidth={2}
          fill="url(#colorCalls)"
        />
        <Area
          type="monotone"
          dataKey="success"
          name="Successful"
          stroke="#22c55e"
          strokeWidth={2}
          fill="url(#colorSuccess)"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export interface OutcomeSlice {
  name: string;
  value: number;
}

export function OutcomePieChart({
  data,
  colors,
}: {
  data: OutcomeSlice[];
  colors: readonly string[];
}) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          innerRadius={55}
          outerRadius={85}
          paddingAngle={3}
          dataKey="value"
        >
          {data.map((slice, i) => (
            <Cell key={slice.name} fill={colors[i % colors.length]} />
          ))}
        </Pie>
        <Tooltip contentStyle={TOOLTIP_STYLE} />
      </PieChart>
    </ResponsiveContainer>
  );
}

export interface AgentPerformancePoint {
  name: string;
  calls: number;
  successRate: number;
  avgDuration: number;
}

export function AgentPerformanceChart({ data }: { data: AgentPerformancePoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 30, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
        <XAxis type="number" tick={AXIS_TICK} tickLine={false} axisLine={false} />
        <YAxis
          type="category"
          dataKey="name"
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          width={90}
        />
        <Tooltip contentStyle={TOOLTIP_STYLE} />
        <Legend wrapperStyle={{ fontSize: '12px' }} />
        <Bar dataKey="calls" name="Calls" fill="#6366f1" radius={[0, 4, 4, 0]} />
        <Bar dataKey="successRate" name="Success %" fill="#22c55e" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
