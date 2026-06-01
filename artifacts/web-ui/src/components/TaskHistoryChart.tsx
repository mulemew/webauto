import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";

  interface RunHistoryEntry {
    day: string;
    success: number;
    failed: number;
  }

  interface TaskHistoryChartProps {
    runHistory: RunHistoryEntry[];
  }

  export default function TaskHistoryChart({ runHistory }: TaskHistoryChartProps) {
    return (
      <ResponsiveContainer width="100%" height={140}>
        <BarChart data={runHistory} barSize={8} barCategoryGap="30%">
          <XAxis
            dataKey="day"
            tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
            tickFormatter={(d: string) => d.slice(5)}
            interval="preserveStartEnd"
            axisLine={false}
            tickLine={false}
          />
          <YAxis hide allowDecimals={false} />
          <Tooltip
            contentStyle={{
              background: "hsl(var(--card))",
              border: "1px solid hsl(var(--border))",
              borderRadius: "6px",
              fontSize: "11px",
              fontFamily: "monospace",
            }}
            labelFormatter={(l: string) => `Date: ${l}`}
          />
          <Bar dataKey="success" name="Success" stackId="a" radius={[0, 0, 0, 0]}>
            {runHistory.map((_entry, index) => (
              <Cell key={index} fill="hsl(142, 76%, 36%)" />
            ))}
          </Bar>
          <Bar dataKey="failed" name="Failed" stackId="a" radius={[2, 2, 0, 0]}>
            {runHistory.map((_entry, index) => (
              <Cell key={index} fill="hsl(0, 72%, 51%)" />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    );
  }
  