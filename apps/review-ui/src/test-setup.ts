import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

if (typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

function localStorageAvailable(): boolean {
  try {
    return typeof window.localStorage === "object" && window.localStorage !== null;
  } catch {
    return false;
  }
}

if (!localStorageAvailable()) {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    writable: true,
    value: {
      get length(): number {
        return store.size;
      },
      key(index: number): string | null {
        return [...store.keys()][index] ?? null;
      },
      getItem(key: string): string | null {
        return store.has(key) ? (store.get(key) as string) : null;
      },
      setItem(key: string, value: string): void {
        store.set(String(key), String(value));
      },
      removeItem(key: string): void {
        store.delete(key);
      },
      clear(): void {
        store.clear();
      },
    },
  });
}

afterEach(() => {
  cleanup();
});
