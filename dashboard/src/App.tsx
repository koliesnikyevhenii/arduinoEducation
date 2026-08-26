import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CarModel } from "./CarModel";
import { RobotControl } from "./RobotControl";
import { TiltGauge } from "./TiltGauge";
import { useTelemetry, type ConnState } from "./useTelemetry";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:54344";
const DEVICE = "esp32";
const PITCH_COLOR = "#38bdf8";
const ROLL_COLOR = "#f472b6";

const STATUS_TEXT: Record<ConnState, string> = {
  connecting: "Connecting…",
  connected: "Live",
  reconnecting: "Reconnecting…",
  disconnected: "Disconnected",
};

export function App() {
  const { state, pitch, roll, yaw, guard, history } = useTelemetry(API_URL, { device: DEVICE });

  return (
    <div className="app">
      <header className="app__header">
        <h1>Robot — drive &amp; tilt</h1>
        <span className={`status status--${state}`}>
          <span className="status__dot" />
          {STATUS_TEXT[state]}
        </span>
      </header>

      {/* guard is the firmware's own tilt cutoff (lesson 22): while it's set the
          ESP32 ignores drive commands, so the pad says so instead of looking broken. */}
      <RobotControl blocked={guard === true} />

      <section className="gauges">
        <TiltGauge label="Pitch" angle={pitch} color={PITCH_COLOR} />
        <TiltGauge label="Roll" angle={roll} color={ROLL_COLOR} />
      </section>

      <section className="chart">
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={history} margin={{ top: 8, right: 16, bottom: 8, left: -16 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            <XAxis
              dataKey="t"
              type="number"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(t) => new Date(t).toLocaleTimeString()}
              stroke="#64748b"
              minTickGap={48}
            />
            <YAxis domain={[-90, 90]} ticks={[-90, -45, 0, 45, 90]} stroke="#64748b" />
            <ReferenceLine y={0} stroke="#334155" />
            <Tooltip
              contentStyle={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 8 }}
              labelFormatter={(t) => new Date(t as number).toLocaleTimeString()}
              formatter={(v: number, name) => [`${v?.toFixed(1)}°`, name]}
            />
            <Line
              type="monotone"
              dataKey="pitch"
              stroke={PITCH_COLOR}
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="roll"
              stroke={ROLL_COLOR}
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      </section>

      <section className="model">
        <div className="model__title">
          <span>Robot orientation (drag to orbit)</span>
          <span className="model__heading">
            heading {yaw !== null ? `${yaw.toFixed(0)}°` : "—"}
            <span className="model__hint"> · gyro-only, drifts over time</span>
          </span>
        </div>
        <div className="model__canvas">
          <CarModel pitch={pitch} roll={roll} yaw={yaw} />
        </div>
      </section>

      <footer className="app__footer">
        device <code>{DEVICE}</code> · pushed live over SignalR from <code>{API_URL}</code>
      </footer>
    </div>
  );
}
