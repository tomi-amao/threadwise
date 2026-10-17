import React, { useEffect, useState } from 'react';
import { Moon, Sun } from 'phosphor-react';

const KEY = 'cv2-theme';

/** Light/dark preference for the v2 pages. Shared key, so every v2 page agrees. */
export function useCv2Theme() {
  const [dark, setDarkState] = useState(false);

  // SSR always renders light; restore the saved choice after hydration.
  useEffect(() => {
    try {
      if (localStorage.getItem(KEY) === 'dark') setDarkState(true);
    } catch {
      /* storage unavailable — stay on light */
    }
  }, []);

  const setDark = (next: boolean) => {
    setDarkState(next);
    try {
      localStorage.setItem(KEY, next ? 'dark' : 'light');
    } catch {
      /* ignore */
    }
  };

  return [dark, setDark] as const;
}

export function ThemeToggle({
  dark,
  onChange,
}: {
  dark: boolean;
  onChange: (dark: boolean) => void;
}) {
  const icon = { marginRight: 6, verticalAlign: '-2px' } as const;
  return (
    <div className="cv2-seg" role="group" aria-label="Theme">
      <button type="button" aria-pressed={!dark} onClick={() => onChange(false)}>
        <Sun size={14} weight="light" style={icon} />
        Light
      </button>
      <button type="button" aria-pressed={dark} onClick={() => onChange(true)}>
        <Moon size={14} weight="light" style={icon} />
        Dark
      </button>
    </div>
  );
}
