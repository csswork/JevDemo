import { useEffect, useRef, useState } from 'react';
import { IconCheck, IconMoon, IconSun } from './icons';

/** 几点 → "14:05" */
function clock(h: number) {
  const m = Math.round((((h % 24) + 24) % 24) * 60) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 几点 → 一天里的哪个时段 */
function periodOf(h: number) {
  if (h < 5) return '深夜';
  if (h < 7) return '清晨';
  if (h < 11) return '上午';
  if (h < 13) return '中午';
  if (h < 17) return '下午';
  if (h < 19) return '黄昏';
  if (h < 22.5) return '晚上';
  return '深夜';
}

const nowHours = () => {
  const d = new Date();
  return d.getHours() + d.getMinutes() / 60;
};

/** 白天（太阳在地平线上，大致）：拉杆上的小圆点显示太阳，否则月亮 */
const isDay = (h: number) => h >= 6 && h < 18.5;

/** 拉杆上的天色（和轨道的渐变一致），给小圆点的光晕用 */
const SKY: Array<[number, string]> = [
  [0, '#141a3d'],
  [4.5, '#232a5c'],
  [6, '#f39a6b'],
  [8, '#8cc6f2'],
  [12, '#5fb2f0'],
  [16, '#8cc6f2'],
  [18, '#f5a35f'],
  [19.2, '#c35c86'],
  [20.5, '#2c2d68'],
  [24, '#141a3d'],
];
const TRACK = `linear-gradient(90deg, ${SKY.map(([h, c]) => `${c} ${((h / 24) * 100).toFixed(1)}%`).join(', ')})`;

function skyAt(h: number) {
  for (let i = 1; i < SKY.length; i++) {
    if (h <= SKY[i][0]) {
      const [h0, c0] = SKY[i - 1];
      const [h1, c1] = SKY[i];
      const k = (h - h0) / (h1 - h0);
      const a = parseInt(c0.slice(1), 16);
      const b = parseInt(c1.slice(1), 16);
      const mix = (s: number) => Math.round(((a >> s) & 255) * (1 - k) + ((b >> s) & 255) * k);
      return `rgb(${mix(16)}, ${mix(8)}, ${mix(0)})`;
    }
  }
  return SKY[0][1];
}

/**
 * 时间：「实时」勾上 = 跟着电脑的时钟走；拖拉杆 = 停在某个钟点（拖的时候自动取消实时）。
 * 拉杆是一整天的天色，小圆点白天是太阳、晚上是月亮
 */
export function TimeSlider({
  value,
  onChange,
  onCommit,
}: {
  /** 'now' = 实时，否则是几点（0..24） */
  value: 'now' | number;
  /** 拖动中（不存） */
  onChange: (v: 'now' | number) => void;
  /** 松手 / 勾选（存下来） */
  onCommit: (v: 'now' | number) => void;
}) {
  const live = value === 'now';
  const [now, setNow] = useState(nowHours);
  useEffect(() => {
    const t = window.setInterval(() => setNow(nowHours()), 15000);
    return () => clearInterval(t);
  }, []);
  const hours = live ? now : value;

  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const last = useRef(hours);
  const hoursAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    const k = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    // 吸到 5 分钟；拖到最右边算 23:55，不绕回 0 点
    return Math.min(24 - 1 / 12, Math.round(k * 24 * 12) / 12);
  };
  const move = (clientX: number) => {
    const h = hoursAt(clientX);
    last.current = h;
    onChange(h);
  };

  const step = (dh: number) => {
    const h = (((hours + dh) % 24) + 24) % 24;
    onChange(h);
    onCommit(h);
  };

  return (
    <div className={`time ${live ? 'live' : ''}`}>
      <div className="time-head">
        <label className="check">
          <input type="checkbox" checked={live} onChange={(e) => onCommit(e.target.checked ? 'now' : Math.round(now * 12) / 12)} />
          <span className="box">
            <IconCheck size={12} />
          </span>
          实时
          {live && <span className="pulse" />}
        </label>
        <span className="time-read">
          <b>{clock(hours)}</b>
          <span>{periodOf(hours)}</span>
        </span>
      </div>
      <div
        className="time-track"
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label="时间"
        aria-valuemin={0}
        aria-valuemax={24}
        aria-valuenow={hours}
        aria-valuetext={`${clock(hours)} ${periodOf(hours)}`}
        style={{ background: TRACK }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          dragging.current = true;
          move(e.clientX);
        }}
        onPointerMove={(e) => dragging.current && move(e.clientX)}
        onPointerUp={() => {
          if (!dragging.current) return;
          dragging.current = false;
          onCommit(last.current);
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowUp') step(e.shiftKey ? 1 : 0.25);
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') step(e.shiftKey ? -1 : -0.25);
          else return;
          e.preventDefault();
        }}
      >
        <div
          className={`time-thumb ${isDay(hours) ? 'sun' : 'moon'}`}
          style={{ left: `${(hours / 24) * 100}%`, ['--glow' as string]: skyAt(hours) }}
        >
          {isDay(hours) ? <IconSun size={13} /> : <IconMoon size={12} />}
        </div>
      </div>
      <div className="time-ticks">
        {[0, 6, 12, 18, 24].map((h) => (
          <span key={h} style={{ left: `${(h / 24) * 100}%` }}>
            {h}
          </span>
        ))}
      </div>
    </div>
  );
}
