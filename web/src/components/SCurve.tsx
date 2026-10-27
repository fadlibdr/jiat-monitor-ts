import { monthIndex, monthLong, monthShort, percentMicro, periodOfIndex } from '../lib/format';
import type { CurvePoint } from '../lib/types';

const W = 520;
const H = 210;
const PAD = { left: 40, right: 56, top: 12, bottom: 28 };
const FULL = 100_000_000;
const GRID = [0, 0.25, 0.5, 0.75, 1];
const MAX_X_LABELS = 7;

/**
 * Weighted S-curve: plan dashed, actual solid up to the last approved month, the selected month as an
 * amber marker. The x axis is calendar time: the curve only has points where a plan or an opname
 * exists, so spacing points evenly would draw a one-month step as wide as a three-month one and bend
 * the slope (the rate of progress) the chart is read for. Colours come from CSS classes (styles.css).
 */
export function SCurve({ points, period }: { points: readonly CurvePoint[]; period: string }) {
  const pts = points
    .flatMap((p) => {
      const m = monthIndex(p.period);
      return m === null ? [] : [{ ...p, m }];
    })
    .sort((a, b) => a.m - b.m);
  if (pts.length === 0) return <div className="empty">Belum ada rencana atau opname untuk kurva S.</div>;
  const first = pts[0]!.m;
  const last = pts[pts.length - 1]!.m;
  const span = last - first;
  const inner = W - PAD.left - PAD.right;
  const x = (m: number) => PAD.left + (span === 0 ? inner / 2 : ((m - first) * inner) / span);
  const y = (micro: number) => PAD.top + (1 - Math.max(0, Math.min(FULL, micro)) / FULL) * (H - PAD.top - PAD.bottom);
  const plan = pts.map((p) => `${x(p.m).toFixed(1)},${y(p.plannedMicroPct).toFixed(1)}`).join(' ');
  const actual = pts.flatMap((p) => (p.actualMicroPct === null ? [] : [`${x(p.m).toFixed(1)},${y(p.actualMicroPct).toFixed(1)}`])).join(' ');

  const step = Math.max(1, Math.ceil((span + 1) / MAX_X_LABELS));
  const ticks: number[] = [];
  for (let m = first; m <= last; m += step) ticks.push(m);

  const sel = monthIndex(period);
  const onAxis = sel !== null && sel >= first && sel <= last ? sel : null;
  const now = pts.find((p) => p.m === sel);
  const summary = now
    ? `Kurva S: rencana ${percentMicro(now.plannedMicroPct)}, realisasi ${percentMicro(now.actualMicroPct)} pada ${monthLong(period)}`
    : `Kurva S ${monthLong(pts[0]!.period)} sampai ${monthLong(pts[pts.length - 1]!.period)}`;

  return (
    <figure className="scurve">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={summary}>
        {GRID.map((g) => (
          <g key={g}>
            <line className={g === 0 ? 'sc-base' : 'sc-grid'} x1={PAD.left} x2={W - PAD.right} y1={y(g * FULL)} y2={y(g * FULL)} />
            <text className="sc-axis" x={PAD.left - 8} y={y(g * FULL) + 3} textAnchor="end">{g * 100}%</text>
          </g>
        ))}
        {ticks.map((m) => (
          <text key={m} className="sc-axis" x={x(m)} y={H - 8} textAnchor="middle">{tickLabel(m)}</text>
        ))}
        <polyline className="sc-plan" points={plan} />
        {actual && <polyline className="sc-actual" points={actual} />}
        {onAxis !== null && <line className="sc-now" x1={x(onAxis)} x2={x(onAxis)} y1={PAD.top} y2={H - PAD.bottom} />}
        {now && (
          <g>
            <circle className="sc-plan-dot" cx={x(now.m)} cy={y(now.plannedMicroPct)} r="3" />
            <text className="sc-axis" x={x(now.m) + 6} y={y(now.plannedMicroPct) - 4}>{percentMicro(now.plannedMicroPct)}</text>
            {now.actualMicroPct !== null && (
              <>
                <circle className="sc-actual-dot" cx={x(now.m)} cy={y(now.actualMicroPct)} r="3.5" />
                <text className="sc-axis sc-actual-label" x={x(now.m) + 6} y={y(now.actualMicroPct) + 10}>{percentMicro(now.actualMicroPct)}</text>
              </>
            )}
          </g>
        )}
      </svg>
      <figcaption className="legend">
        <span><span className="sw" />Realisasi</span>
        <span><span className="sw dash" />Rencana</span>
        <span><span className="sw now" />Bulan dipilih</span>
      </figcaption>
    </figure>
  );
}

/** January carries its year so a curve that crosses New Year stays readable. */
function tickLabel(m: number): string {
  const period = periodOfIndex(m);
  return m % 12 === 0 ? `${monthShort(period)} ${period.slice(2, 4)}` : monthShort(period);
}
