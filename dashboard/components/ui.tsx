"use client";
import React from "react";
import { typeColor } from "@/lib/types";

export const fmt = (n: number) =>
  n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : "" + n;

export function Card({
  title,
  tag,
  className = "",
  children,
}: {
  title?: string;
  tag?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-2xl border border-line bg-panel p-4 animate-fadeup ${className}`}
    >
      {title && (
        <div className="mb-3 flex items-center justify-between">
          <h4 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">
            {title}
          </h4>
          {tag && (
            <span className="font-mono text-[10px] text-muted">{tag}</span>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <Card>
      <div className="font-mono text-[30px] font-semibold leading-none tracking-[-1px]">
        {typeof value === "number" ? fmt(value) : value}
      </div>
      <div className="mt-2 text-[11.5px] text-muted">{label}</div>
      {sub && <div className="mt-0.5 font-mono text-[11px] text-faint">{sub}</div>}
    </Card>
  );
}

export function Bars({
  rows,
  warm = false,
}: {
  rows: [string, number][];
  warm?: boolean;
}) {
  const max = Math.max(...rows.map((r) => r[1]), 1);
  const grad = warm
    ? "linear-gradient(90deg,#5eead4,#7c9cff)"
    : "linear-gradient(90deg,#7c9cff,#9db4ff)";
  return (
    <div className="flex flex-col gap-2.5">
      {rows.map(([nm, v], i) => (
        <div
          key={nm + i}
          className="grid items-center gap-3"
          style={{ gridTemplateColumns: "120px 1fr 42px" }}
        >
          <span
            className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[12px] text-muted"
            title={nm}
          >
            {nm}
          </span>
          <div className="h-2 overflow-hidden rounded-[5px] bg-panel-2">
            <div
              className="animate-grow h-full rounded-[5px]"
              style={{
                width: `${(v / max) * 100}%`,
                background: grad,
                animationDelay: `${i * 40}ms`,
              }}
            />
          </div>
          <span className="text-right font-mono text-[11.5px] text-ink">{v}</span>
        </div>
      ))}
    </div>
  );
}

export function Donut({ types }: { types: { type: string; n: number }[] }) {
  const total = types.reduce((a, b) => a + b.n, 0);
  const R = 60,
    cx = 75,
    cy = 75,
    sw = 20,
    circ = 2 * Math.PI * R;
  let off = 0;
  return (
    <div className="flex items-center gap-5">
      <svg width="150" height="150" viewBox="0 0 150 150">
        {types.map((t) => {
          const len = (t.n / total) * circ;
          const el = (
            <circle
              key={t.type}
              cx={cx}
              cy={cy}
              r={R}
              fill="none"
              stroke={typeColor(t.type)}
              strokeWidth={sw}
              strokeDasharray={`${len} ${circ - len}`}
              strokeDashoffset={-off}
              transform={`rotate(-90 ${cx} ${cy})`}
            />
          );
          off += len;
          return el;
        })}
        <text
          x={cx}
          y={cy - 4}
          textAnchor="middle"
          fill="#e8eaf0"
          fontSize="22"
          fontWeight="600"
          fontFamily="var(--font-mono)"
        >
          {total}
        </text>
        <text x={cx} y={cy + 13} textAnchor="middle" fill="#878d9a" fontSize="10">
          entities
        </text>
      </svg>
      <div className="flex flex-1 flex-col gap-2">
        {types.map((t) => (
          <div key={t.type} className="flex items-center gap-2 text-[11.5px] text-muted">
            <span
              className="h-2.5 w-2.5 rounded-[3px]"
              style={{ background: typeColor(t.type) }}
            />
            {t.type.toLowerCase()}
            <b className="ml-auto font-mono text-ink">{t.n}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SectionHead({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="mx-auto mb-1 flex max-w-[1240px] items-baseline gap-3">
      <h2 className="text-[17px] font-semibold tracking-[-0.2px]">{title}</h2>
      <p className="text-[12px] text-faint">{sub}</p>
    </div>
  );
}
