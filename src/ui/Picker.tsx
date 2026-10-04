import { useEffect, useRef, useState, type ReactNode } from 'react';
import { IconCheck, IconChevron } from './icons';

export interface PickerItem {
  id: string;
  label: string;
  desc?: string;
  group?: string;
  disabled?: boolean;
  /** 列表项左边的东西（头像之类） */
  lead?: ReactNode;
  /** 右边的小标签（"未下载"之类） */
  note?: string;
}

/**
 * 下拉选择：比原生 select 好看，能放头像、描述、分组。
 * 点外面 / 按 Esc 收起；键盘上下选、回车确定
 */
export function Picker({
  value,
  items,
  onPick,
  disabled,
  title,
  children,
  className = '',
  icon,
}: {
  value: string | null;
  items: PickerItem[];
  onPick: (id: string) => void;
  disabled?: boolean;
  title?: string;
  /** 按钮里显示什么（默认是选中项的名字） */
  children?: ReactNode;
  className?: string;
  /** 按钮右边的图标（默认是向下的箭头；false = 不要） */
  icon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(-1);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const current = items.find((i) => i.id === value);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  // 打开时把选中项滚进视野
  useEffect(() => {
    if (!open) return;
    const i = items.findIndex((x) => x.id === value);
    setHover(i);
    list.current?.querySelector<HTMLElement>(`[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const choose = (item: PickerItem | undefined) => {
    if (!item || item.disabled) return;
    setOpen(false);
    if (item.id !== value) onPick(item.id);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      let i = hover;
      for (let n = 0; n < items.length; n++) {
        i = (i + dir + items.length) % items.length;
        if (!items[i].disabled) break;
      }
      setHover(i);
      list.current?.querySelector<HTMLElement>(`[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(items[hover]);
    }
  };

  let lastGroup: string | undefined;
  return (
    <div className={`picker ${open ? 'open' : ''} ${className}`} ref={root} onKeyDown={onKey}>
      <button
        type="button"
        className="picker-btn"
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="picker-value">{children ?? current?.label ?? '—'}</span>
        {icon === undefined ? <IconChevron size={14} /> : icon}
      </button>
      {open && (
        <div className="picker-pop" role="listbox" ref={list}>
          {items.map((item, i) => {
            const head = item.group && item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <div key={item.id}>
                {head && <div className="picker-group">{head}</div>}
                <div
                  role="option"
                  aria-selected={item.id === value}
                  aria-disabled={item.disabled}
                  data-i={i}
                  className={`picker-item${item.id === value ? ' on' : ''}${i === hover ? ' hover' : ''}${item.disabled ? ' off' : ''}`}
                  onPointerEnter={() => setHover(i)}
                  onClick={() => choose(item)}
                >
                  {item.lead}
                  <span className="picker-text">
                    <span className="picker-label">
                      {item.label}
                      {item.note && <em>{item.note}</em>}
                    </span>
                    {item.desc && <span className="picker-desc">{item.desc}</span>}
                  </span>
                  {item.id === value && <IconCheck size={14} />}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
