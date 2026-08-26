import { useTheme, type ThemeSetting } from "../lib/useTheme";

const NEXT_SETTING: Record<ThemeSetting, ThemeSetting> = { auto: "light", light: "dark", dark: "auto" };

function SettingIcon({ kind }: { kind: ThemeSetting }) {
  if (kind === "light") {
    return (
      <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16">
        <circle cx="10" cy="10" r="4" fill="currentColor" />
        <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <line x1="10" y1="1.5" x2="10" y2="3.5" />
          <line x1="10" y1="16.5" x2="10" y2="18.5" />
          <line x1="1.5" y1="10" x2="3.5" y2="10" />
          <line x1="16.5" y1="10" x2="18.5" y2="10" />
          <line x1="4.3" y1="4.3" x2="5.7" y2="5.7" />
          <line x1="14.3" y1="14.3" x2="15.7" y2="15.7" />
          <line x1="4.3" y1="15.7" x2="5.7" y2="14.3" />
          <line x1="14.3" y1="5.7" x2="15.7" y2="4.3" />
        </g>
      </svg>
    );
  }
  if (kind === "dark") {
    return (
      <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16">
        <path d="M15.5 12.6A7 7 0 0 1 7.4 4.5a7 7 0 1 0 8.1 8.1Z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16">
      <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 2.5a7.5 7.5 0 0 1 0 15Z" fill="currentColor" />
    </svg>
  );
}

export function ThemeToggle() {
  const { setting, resolvedTheme, setTheme } = useTheme();
  const label =
    setting === "auto"
      ? `System (${resolvedTheme === "light" ? "light" : "dark"})`
      : setting === "light"
        ? "Light"
        : "Dark";
  return (
    <button type="button" className="theme-toggle" aria-label="Color scheme" onClick={() => setTheme(NEXT_SETTING[setting])}>
      <SettingIcon kind={setting} />
      <span className="theme-toggle__label">{label}</span>
    </button>
  );
}
