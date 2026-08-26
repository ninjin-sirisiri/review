import { useCallback, useEffect, useState } from "react";

export type ThemeSetting = "auto" | "light" | "dark";

const STORAGE_KEY = "review-ui-theme";

type ResolvedTheme = "light" | "dark";

function systemTheme(): ResolvedTheme {
  if (typeof window.matchMedia !== "function") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function readStoredSetting(): ThemeSetting {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === "light" || raw === "dark" ? raw : "auto";
  } catch {
    return "auto";
  }
}

function persist(setting: ThemeSetting): void {
  try {
    if (setting === "auto") window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, setting);
  } catch {
    // Storage can be unavailable (private mode); degrade silently to auto behavior.
  }
}

export function useTheme() {
  const [setting, setSetting] = useState<ThemeSetting>(() => readStoredSetting());
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    setting === "auto" ? systemTheme() : setting,
  );

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    persist(setting);
  }, [setting, resolvedTheme]);

  useEffect(() => {
    if (setting !== "auto" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = (event: MediaQueryListEvent) => setResolvedTheme(event.matches ? "light" : "dark");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [setting]);

  const setTheme = useCallback((next: ThemeSetting) => {
    setSetting(next);
    setResolvedTheme(next === "auto" ? systemTheme() : next);
  }, []);

  return { setting, resolvedTheme, setTheme };
}
