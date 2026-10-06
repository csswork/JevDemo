import { useEffect, useState } from 'react';
import { LoaderFx } from './LoaderFx';

/**
 * 开场的载入画面：她的头像在中间，外面一圈是下载进度；底下是名字和一句状态。
 * 背景是两团很慢地漂着的柔光，上面一层粒子在头像周围打旋（LoaderFx，three.js），随着进度汇成头像外的光环。
 * 载完了不是一下消失：粒子往外炸开，整层淡出，头像放大、变虚，像镜头推进场景里。
 *
 * done 变成 true 之后自己再待 0.8 秒（退场动画），然后卸载
 */
export function Loader({
  done,
  progress,
  name,
  avatar,
}: {
  done: boolean;
  /** 0..1；还不知道是谁的时候（探测模型中）也是 0 */
  progress: number;
  name?: string;
  /** 头像图片地址；没有就只显示进度圈 */
  avatar?: string;
}) {
  const [gone, setGone] = useState(false);
  const [imgOk, setImgOk] = useState(true);
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setGone(true), 800);
    return () => clearTimeout(t);
  }, [done]);
  if (gone) return null;

  const pct = Math.round(progress * 100);
  const R = 54;
  const C = 2 * Math.PI * R;
  const status = !name ? '准备舞台' : pct < 100 ? '正在赶来' : '马上就好';

  return (
    <div className={`boot ${done ? 'out' : ''}`} role="status" aria-live="polite">
      <div className="boot-glow a" />
      <div className="boot-glow b" />
      {/* 粒子（three.js）：在头像周围打旋，随进度汇成光环，载完往外炸开 */}
      <LoaderFx progress={name ? progress : 0} leaving={done} />
      <div className="boot-center">
        <div className={`boot-ring ${name ? '' : 'idle'}`}>
          <svg viewBox="0 0 120 120" aria-hidden>
            <circle className="track" cx="60" cy="60" r={R} />
            <circle
              className="bar"
              cx="60"
              cy="60"
              r={R}
              strokeDasharray={C}
              strokeDashoffset={C * (1 - (name ? Math.max(0.02, progress) : 0.22))}
            />
          </svg>
          {avatar && imgOk ? (
            <img src={avatar} alt="" draggable={false} onError={() => setImgOk(false)} />
          ) : (
            <span className="boot-initial">{name?.slice(0, 1) ?? ''}</span>
          )}
        </div>
        <div className="boot-name">{name ?? ' '}</div>
        <div className="boot-status">
          {status}
          <span className="boot-dots" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          {name && <span className="boot-pct">{pct}%</span>}
        </div>
      </div>
    </div>
  );
}
