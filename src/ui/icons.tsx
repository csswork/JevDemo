/** 界面上用到的小图标（线条风格，跟随 currentColor） */
import type { ReactNode } from 'react';

function Svg({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

type P = { size?: number };

export const IconChevron = (p: P) => (
  <Svg {...p}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);
export const IconSwap = (p: P) => (
  <Svg {...p}>
    <path d="m7 15 5 5 5-5" />
    <path d="m7 9 5-5 5 5" />
  </Svg>
);
export const IconMic = (p: P) => (
  <Svg {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0" />
    <path d="M12 18v3" />
  </Svg>
);
export const IconImage = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="m3 16 5-5 4 4 3-3 6 6" />
    <circle cx="16" cy="9" r="1.6" />
  </Svg>
);
export const IconClock = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);
export const IconVolume = ({ off, ...p }: P & { off?: boolean }) => (
  <Svg {...p}>
    <path d="M4 10v4h3.5L12 18V6L7.5 10z" />
    {off ? (
      <path d="m16 9.5 5 5m0-5-5 5" />
    ) : (
      <>
        <path d="M15.5 9.2a4 4 0 0 1 0 5.6" />
        <path d="M18.3 6.6a7.6 7.6 0 0 1 0 10.8" />
      </>
    )}
  </Svg>
);
export const IconSend = (p: P) => (
  <Svg {...p}>
    <path d="M5 12h13" />
    <path d="m12 5 7 7-7 7" />
  </Svg>
);
export const IconChat = (p: P) => (
  <Svg {...p}>
    <path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4A8 8 0 1 1 20 12z" />
  </Svg>
);
export const IconClose = (p: P) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);
export const IconSliders = (p: P) => (
  <Svg {...p}>
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="10" cy="17" r="2" />
  </Svg>
);
export const IconReset = (p: P) => (
  <Svg {...p}>
    <path d="M4 12a8 8 0 1 0 2.4-5.7" />
    <path d="M4 4v4h4" />
  </Svg>
);
export const IconCollapse = (p: P) => (
  <Svg {...p}>
    <path d="M14 4h6v6M10 20H4v-6" />
    <path d="m20 4-6 6M4 20l6-6" />
  </Svg>
);
export const IconCoffee = (p: P) => (
  <Svg {...p}>
    <path d="M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z" />
    <path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16" />
    <path d="M9 3.5c-.6.8-.6 1.7 0 2.5M12.5 3.5c-.6.8-.6 1.7 0 2.5" />
  </Svg>
);
export const IconTree = (p: P) => (
  <Svg {...p}>
    <path d="M12 21v-5" />
    <path d="M12 3c3.3 0 6 2.5 6 5.6 0 1-.3 1.9-.8 2.7A4 4 0 0 1 15 18H9a4 4 0 0 1-2.2-6.7A5.3 5.3 0 0 1 6 8.6C6 5.5 8.7 3 12 3z" />
  </Svg>
);
export const IconCity = (p: P) => (
  <Svg {...p}>
    <path d="M3 21h18" />
    <path d="M5 21V9l5-3v15" />
    <path d="M10 21V4h6v17" />
    <path d="M16 21v-9h3v9" />
    <path d="M12.5 8h1M12.5 11h1M12.5 14h1" />
  </Svg>
);
export const IconBlank = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="4" width="16" height="16" rx="4" />
    <path d="M4 15c4-3 8 2 16-2" opacity={0.5} />
  </Svg>
);
export const IconSun = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
  </Svg>
);
export const IconMoon = (p: P) => (
  <Svg {...p}>
    <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
  </Svg>
);
export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);
