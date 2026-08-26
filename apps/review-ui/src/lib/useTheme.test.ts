import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTheme } from "./useTheme";

type ChangeHandler = (event: { matches: boolean }) => void;

function installMatchMedia(initialMatches: boolean) {
  const listeners = new Set<ChangeHandler>();
  let matches = initialMatches;
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: ChangeHandler) => listeners.add(listener),
    removeEventListener: (_type: string, listener: ChangeHandler) => listeners.delete(listener),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return {
    fireChange(next: boolean) {
      matches = next;
      for (const listener of listeners) listener({ matches: next });
    },
  };
}

function currentTheme(): string | undefined {
  return document.documentElement.dataset.theme;
}

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("useTheme", () => {
  it("defaults to auto resolved dark when nothing is stored", () => {
    installMatchMedia(false);
    const { result } = renderHook(() => useTheme());
    expect(result.current.setting).toBe("auto");
    expect(result.current.resolvedTheme).toBe("dark");
    expect(currentTheme()).toBe("dark");
    expect(window.localStorage.getItem("review-ui-theme")).toBeNull();
  });

  it("resolves light from prefers-color-scheme while auto", () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useTheme());
    expect(result.current.resolvedTheme).toBe("light");
    expect(currentTheme()).toBe("light");
  });

  it("restores a stored manual theme over the system preference", () => {
    installMatchMedia(false);
    window.localStorage.setItem("review-ui-theme", "light");
    const { result } = renderHook(() => useTheme());
    expect(result.current.setting).toBe("light");
    expect(result.current.resolvedTheme).toBe("light");
    expect(currentTheme()).toBe("light");
  });

  it("falls back to auto for invalid stored values", () => {
    installMatchMedia(false);
    window.localStorage.setItem("review-ui-theme", "sepia");
    const { result } = renderHook(() => useTheme());
    expect(result.current.setting).toBe("auto");
    expect(result.current.resolvedTheme).toBe("dark");
  });

  it("persists manual choices and removes the key when returning to auto", () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme("dark"));
    expect(window.localStorage.getItem("review-ui-theme")).toBe("dark");
    expect(currentTheme()).toBe("dark");
    act(() => result.current.setTheme("auto"));
    expect(window.localStorage.getItem("review-ui-theme")).toBeNull();
    expect(result.current.resolvedTheme).toBe("light");
  });

  it("follows OS scheme changes while auto and ignores them when manual", () => {
    const media = installMatchMedia(false);
    const { result } = renderHook(() => useTheme());
    act(() => media.fireChange(true));
    expect(result.current.resolvedTheme).toBe("light");
    expect(currentTheme()).toBe("light");
    act(() => result.current.setTheme("dark"));
    act(() => media.fireChange(false));
    expect(result.current.setting).toBe("dark");
    expect(result.current.resolvedTheme).toBe("dark");
  });

  it("keeps working when localStorage throws", () => {
    installMatchMedia(false);
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const { result } = renderHook(() => useTheme());
    expect(result.current.setting).toBe("auto");
    act(() => result.current.setTheme("light"));
    expect(result.current.resolvedTheme).toBe("light");
    expect(currentTheme()).toBe("light");
  });

  it("treats a missing matchMedia as dark with no listener", () => {
    const original = window.matchMedia;
    // @ts-expect-error simulating environments without matchMedia
    delete window.matchMedia;
    try {
      const { result } = renderHook(() => useTheme());
      act(() => result.current.setTheme("auto"));
      expect(result.current.resolvedTheme).toBe("dark");
      expect(currentTheme()).toBe("dark");
    } finally {
      window.matchMedia = original;
    }
  });
});
