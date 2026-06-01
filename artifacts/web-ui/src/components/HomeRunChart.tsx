import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";

  interface ChartEntry {
    date: string;
    Success: number;
    Failed: number;
  }

  interface HomeRunChartProps {
    chartData: ChartEntry[];
  }

  export default function HomeRunChart({ chartData }: HomeRunChartProps) {
    return (
      <ResponsiveContainer width="100%" height={192}>
        <BarChart data={chartData} barCategoryGap="30%" barGap={2}>
          <XAxis
            dataKey="date"
            tick={{ fontSize: 11, fontFamily: "monospace" }}
            tickLine={false}
            axisLine={false}
            stroke="hsl(var(--muted-foreground))"
          />
          <YAxis
            allowDecimals={false}
            tick={{ fontSize: 11, fontFamily: "monospace" }}
            tickLine={false}
            axisLine={false}
            stroke="hsl(var(--muted-foreground))"
            width={28}
          />
          <Tooltip
            contentStyle={{
              background: "hsl(var(--popover))",
              border: "1px solid hsl(var(--border))",
              borderRadius: "6px",
              fontSize: "12px",
              fontFamily: "monospace",
            }}
            cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }}
          />
          <Legend
            iconType="square"
            iconSize={10}
            wrapperStyle={{ fontSize: "11px", fontFamily: "monospace", paddingTop: "8px" }}
          />
          <Bar dataKey="Success" fill="hsl(142 71% 45%)" radius={[3, 3, 0, 0]} maxBarSize={40} />
          <Bar dataKey="Failed" fill="hsl(var(--destructive))" radius={[3, 3, 0, 0]} maxBarSize={40} />
        </BarChart>
      </ResponsiveContainer>
    );
  }
  