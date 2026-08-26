# Review UI Visual Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle review-ui on a semantic design-token base with auto/light/dark theming, bundled fonts, an IDE-style internal-scroll layout, and styles for the previously unstyled DecisionCard.

**Architecture:** CSS custom properties defined per theme on `:root[data-theme]`; a `useTheme` hook + `ThemeToggle` component manage the 3-state setting (`auto`/`light`/`dark`) persisted in localStorage; an inline head script prevents FOUC. All component styles move from a single `styles.css` into token-referencing stylesheets.

**Tech Stack:** React 19 + Vite 7 (existing), vanilla CSS with custom properties, `@fontsource/ibm-plex-sans`, `@fontsource-variable/jetbrains-mono`, vitest/jsdom, Playwright.

**Spec:** [docs/superpowers/specs/2026-08-26-review-ui-visual-refresh-design.md](../specs/2026-08-26-review-ui-visual-refresh-design.md)

## Global Constraints

- Vanilla CSS only; no CSS framework, no icon library, no UI library.
- Component CSS references **semantic tokens only** — raw hex values are allowed only in `src/styles/tokens.css`.
- Theme setting is exactly `"auto" | "light" | "dark"`; localStorage key is the literal string `review-ui-theme` (duplicated intentionally in `useTheme.ts` and `index.html`; keep both in sync).
- New npm dependencies limited to `@fontsource/ibm-plex-sans` and `@fontsource-variable/jetBrains-mono`. No runtime CDN font loading.
- Existing BEM class names stay stable; existing tests must keep passing with minimal fixes only.
- Security invariants untouched: no Recorder/API/plugin changes; owner token stays memory-only.
- Verification always uses repo scripts: `bun run test` (NEVER bare `bun test` at root), `bun run --cwd apps/review-ui build`, `bun run e2e`.

## File Structure

```
apps/review-ui/
  index.html                                  # modify: FOUC inline script
  package.json                                # modify: 2 fontsource deps
  src/main.tsx                                # modify: font imports
  src/test-setup.ts                           # modify: matchMedia baseline stub
  src/lib/useTheme.ts                         # create: theme state hook
  src/lib/useTheme.test.ts                    # create
  src/components/ThemeToggle.tsx              # create
  src/components/ThemeToggle.test.tsx         # create
  src/components/App.tsx                      # modify: header toggle
  src/components/BootstrapScreen.tsx          # modify: toggle placement
  src/components/BootstrapScreen.test.tsx     # modify: toggle assertion
  src/styles.css                              # rewrite: @import entry
  src/styles/tokens.css                       # create: both palettes + scales
  src/styles/base.css                         # create: element base layer
  src/styles/components.css                   # create: all component rules
  src/components/Explorer.tsx                 # modify: SVG chevron
tests/e2e/review-flow.spec.ts                 # modify: token-absence assertion + theme test
```

---

### Task 1: matchMedia stub + useTheme hook

**Files:**
- Modify: `apps/review-ui/src/test-setup.ts`
- Create: `apps/review-ui/src/lib/useTheme.ts`
- Test: `apps/review-ui/src/lib/useTheme.test.ts`

**Interfaces:**
- Consumes: nothing (foundation).
- Produces:
```ts
export type ThemeSetting = "auto" | "light" | "dark";
export function useTheme(): {
  setting: ThemeSetting;
  resolvedTheme: "light" | "dark";
  setTheme(next: ThemeSetting): void;
}
```
Later tasks import `useTheme` and `ThemeSetting` from `"../lib/useTheme"`.

- [ ] **Step 1: Add baseline matchMedia stub to test setup**

Replace the entire content of `apps/review-ui/src/test-setup.ts`:

```ts
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

afterEach(() => {
  cleanup();
});
```

- [ ] **Step 2: Write the failing tests**

Create `apps/review-ui/src/lib/useTheme.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
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
```

Add `import { vi } ...` — merge into the existing vitest import line: `import { afterEach, describe, expect, it, vi } from "vitest";`

- [ ] **Step 3: Run to verify failure**

Run: `bun run --cwd apps/review-ui test src/lib/useTheme.test.ts`
Expected: FAIL — cannot resolve `./useTheme`

- [ ] **Step 4: Implement the hook**

Create `apps/review-ui/src/lib/useTheme.ts`:

```ts
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
```

- [ ] **Step 5: Run hook tests, then the whole review-ui suite**

Run: `bun run --cwd apps/review-ui test src/lib/useTheme.test.ts`
Expected: PASS (8 tests)

Run: `bun run --cwd apps/review-ui test`
Expected: PASS — the new global matchMedia stub must not break any existing test

- [ ] **Step 6: Commit**

```bash
git add apps/review-ui/src/test-setup.ts apps/review-ui/src/lib/useTheme.ts apps/review-ui/src/lib/useTheme.test.ts
git commit -m "feat: add useTheme hook with persisted auto/light/dark resolution"
```

---

### Task 2: ThemeToggle component

**Files:**
- Create: `apps/review-ui/src/components/ThemeToggle.tsx`
- Test: `apps/review-ui/src/components/ThemeToggle.test.tsx`

**Interfaces:**
- Consumes: `useTheme`, `ThemeSetting` from `"../lib/useTheme"` (Task 1).
- Produces: `export function ThemeToggle()` — no props. Renders `<button class="theme-toggle" aria-label="Color scheme">` containing an inline SVG (`aria-hidden`) and `<span class="theme-toggle__label">`. Label text: `"System (light)"` / `"System (dark)"` / `"Light"` / `"Dark"`. Click cycles auto→light→dark→auto.

- [ ] **Step 1: Write the failing tests**

Create `apps/review-ui/src/components/ThemeToggle.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ThemeToggle } from "./ThemeToggle";

function labelOf(button: HTMLElement): string | undefined {
  return button.querySelector(".theme-toggle__label")?.textContent ?? undefined;
}

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("ThemeToggle", () => {
  it("cycles System -> Light -> Dark -> System and applies each theme", () => {
    render(<ThemeToggle />);
    const toggle = screen.getByRole("button", { name: "Color scheme" });
    expect(labelOf(toggle)).toMatch(/^System \((light|dark)\)$/);
    expect(toggle.querySelector("svg[aria-hidden='true']")).toBeTruthy();

    fireEvent.click(toggle);
    expect(labelOf(toggle)).toBe("Light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem("review-ui-theme")).toBe("light");

    fireEvent.click(toggle);
    expect(labelOf(toggle)).toBe("Dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    fireEvent.click(toggle);
    expect(labelOf(toggle)).toMatch(/^System \(/);
    expect(window.localStorage.getItem("review-ui-theme")).toBeNull();
  });

  it("starts from the persisted manual theme", () => {
    window.localStorage.setItem("review-ui-theme", "dark");
    render(<ThemeToggle />);
    const toggle = screen.getByRole("button", { name: "Color scheme" });
    expect(labelOf(toggle)).toBe("Dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run --cwd apps/review-ui test src/components/ThemeToggle.test.tsx`
Expected: FAIL — cannot resolve `./ThemeToggle`

- [ ] **Step 3: Implement the component**

Create `apps/review-ui/src/components/ThemeToggle.tsx`:

```tsx
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
```

- [ ] **Step 4: Run to verify pass**

Run: `bun run --cwd apps/review-ui test src/components/ThemeToggle.test.tsx`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/review-ui/src/components/ThemeToggle.tsx apps/review-ui/src/components/ThemeToggle.test.tsx
git commit -m "feat: add ThemeToggle cycling system/light/dark"
```

---

### Task 3: Wire toggle into App header, Bootstrap screen, and FOUC script

**Files:**
- Modify: `apps/review-ui/src/components/App.tsx` (header, around lines 288-296)
- Modify: `apps/review-ui/src/components/BootstrapScreen.tsx`
- Modify: `apps/review-ui/src/components/BootstrapScreen.test.tsx`
- Modify: `apps/review-ui/index.html`

**Interfaces:**
- Consumes: `ThemeToggle` from `"./components/ThemeToggle"` (Task 2).
- Produces: `.bootstrap-theme` wrapper div positioned by CSS in Task 6. The literal storage key `review-ui-theme` now exists in `index.html` AND `src/lib/useTheme.ts` — any future rename must touch both.

- [ ] **Step 1: Add failing assertions**

In `apps/review-ui/src/components/BootstrapScreen.test.tsx`, extend the first test ("collects the token…") right after the `render(...)` call:

```tsx
expect(screen.getByRole("button", { name: "Color scheme" })).toBeTruthy();
```

Run: `bun run --cwd apps/review-ui test src/components/BootstrapScreen.test.tsx`
Expected: FAIL — button not found

- [ ] **Step 2: Render the toggle in BootstrapScreen**

In `apps/review-ui/src/components/BootstrapScreen.tsx`: add `import { ThemeToggle } from "./ThemeToggle";` and wrap the returned JSX by placing the toggle before `<section className="bootstrap-card" …>` inside `<main>`:

```tsx
return (
  <main className="app-shell app-shell--bootstrap">
    <div className="bootstrap-theme">
      <ThemeToggle />
    </div>
    <section className="bootstrap-card" aria-labelledby="bootstrap-heading">
```

(keep the rest of the section unchanged)

- [ ] **Step 3: Render the toggle in the App header**

In `apps/review-ui/src/components/App.tsx`: add `import { ThemeToggle } from "./components/ThemeToggle";` and change the header's action area so the toggle precedes "Clear session":

```tsx
<div className="app-header__actions">
  <ThemeToggle />
  <button type="button" className="button-secondary" onClick={resetSession}>Clear session</button>
</div>
```

(replaces the single bare `<button …>Clear session</button>`)
Also update the connected-workspace test in `apps/review-ui/src/App.test.tsx` that asserts the workspace heading: after the heading assertion, add `expect(screen.getByRole("button", { name: "Color scheme" })).toBeTruthy();`

- [ ] **Step 4: Add the FOUC script to index.html**

Inside `<head>`, immediately after the `<title>` line of `apps/review-ui/index.html`:

```html
<script>
  (function () {
    try {
      var stored = localStorage.getItem("review-ui-theme");
      var mode = stored === "light" || stored === "dark"
        ? stored
        : typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark";
      document.documentElement.dataset.theme = mode;
    } catch (error) {
      document.documentElement.dataset.theme = "dark";
    }
  })();
</script>
```

- [ ] **Step 5: Verify**

Run: `bun run --cwd apps/review-ui test src/components/BootstrapScreen.test.tsx src/App.test.tsx`
Expected: PASS

Run: `bun run --cwd apps/review-ui test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/review-ui/src/components/App.tsx apps/review-ui/src/components/BootstrapScreen.tsx apps/review-ui/src/components/BootstrapScreen.test.tsx apps/review-ui/src/App.test.tsx apps/review-ui/index.html
git commit -m "feat: surface color-scheme toggle pre-auth and post-auth with FOUC guard"
```

---

### Task 4: Bundle IBM Plex Sans + JetBrains Mono

**Files:**
- Modify: `apps/review-ui/package.json` (via bun add)
- Modify: `apps/review-ui/src/main.tsx`

**Interfaces:**
- Consumes: font-family names referenced later by tokens.css in Task 5: `"IBM Plex Sans"`, `"JetBrains Mono Variable"`.
- Produces: woff2 assets emitted under `apps/review-ui/dist/assets/` at build time.

- [ ] **Step 1: Install dependencies**

Run in `apps/review-ui` (not repo root):

```bash
bun add @fontsource/ibm-plex-sans @fontsource-variable/jetbrains-mono
```

- [ ] **Step 2: Import fonts in the entry**

In `apps/review-ui/src/main.tsx`, insert above the `App` import:

```tsx
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource-variable/jetbrains-mono";
```

- [ ] **Step 3: Build and confirm bundled fonts**

Run: `bun run --cwd apps/review-ui build && ls apps/review-ui/dist/assets/*.woff2`
Expected: build succeeds; several `.woff2` files listed

- [ ] **Step 4: Commit**

```bash
git add apps/review-ui/package.json apps/review-ui/bun.lock apps/review-ui/src/main.tsx ../../bun.lock
git commit -m "feat: bundle IBM Plex Sans and JetBrains Mono via fontsource"
```

(If `bun.lock` lives only at the repo root, stage whichever lockfiles changed.)

---

### Task 5: Token stylesheet split (port existing rules onto tokens)

**Files:**
- Create: `apps/review-ui/src/styles/tokens.css`
- Create: `apps/review-ui/src/styles/base.css`
- Create: `apps/review-ui/src/styles/components.css`
- Rewrite: `apps/review-ui/src/styles.css` (becomes an import entry)

**Interfaces:**
- Consumes: font-family names from Task 4.
- Produces: every custom property listed below; Tasks 6-8 style against these names only.

- [ ] **Step 1: Write tokens.css**

Create `apps/review-ui/src/styles/tokens.css`:

```css
:root {
  --surface-base: #0f172a;
  --surface-panel: #1e293b;
  --surface-raised: #273449;
  --surface-inset: #0b1222;

  --text-primary: #f1f5f9;
  --text-secondary: #cbd5e1;
  --text-muted: #94a3b8;

  --border-subtle: rgb(148 163 184 / 16%);
  --border-strong: rgb(148 163 184 / 32%);

  --accent: #76b7ff;
  --accent-soft: rgb(118 183 255 / 16%);
  --on-accent: #0b1222;

  --status-success: #4ade80;
  --status-success-soft: rgb(74 222 128 / 14%);
  --status-warning: #fbbf24;
  --status-warning-soft: rgb(251 191 36 / 15%);
  --status-danger: #f87171;
  --status-danger-soft: rgb(248 113 113 / 14%);

  --diff-add-text: #7ee787;
  --diff-add-bg: rgb(46 160 67 / 15%);
  --diff-del-text: #ffa198;
  --diff-del-bg: rgb(248 81 73 / 15%);
  --diff-anchor: #d29922;
  --diff-anchor-soft: rgb(210 153 34 / 16%);

  --focus-ring: #76b7ff;

  --font-sans: "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: "JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace;

  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;

  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;

  color-scheme: dark;
}

:root[data-theme="light"] {
  --surface-base: #f8fafc;
  --surface-panel: #ffffff;
  --surface-raised: #f1f5f9;
  --surface-inset: #f6f8fa;

  --text-primary: #0f172a;
  --text-secondary: #334155;
  --text-muted: #64748b;

  --border-subtle: rgb(15 23 42 / 12%);
  --border-strong: rgb(15 23 42 / 24%);

  --accent: #0969da;
  --accent-soft: rgb(9 105 218 / 10%);
  --on-accent: #ffffff;

  --status-success: #1a7f37;
  --status-success-soft: rgb(26 127 55 / 12%);
  --status-warning: #9a6700;
  --status-warning-soft: rgb(154 103 0 / 12%);
  --status-danger: #cf222e;
  --status-danger-soft: rgb(207 34 46 / 10%);

  --diff-add-text: #1a7f37;
  --diff-add-bg: rgb(26 127 55 / 10%);
  --diff-del-text: #cf222e;
  --diff-del-bg: rgb(207 34 46 / 8%);
  --diff-anchor: #9a6700;
  --diff-anchor-soft: rgb(154 103 0 / 14%);

  --focus-ring: #0969da;

  color-scheme: light;
}
```

- [ ] **Step 2: Write base.css**

Create `apps/review-ui/src/styles/base.css`:

```css
* { box-sizing: border-box; }

body {
  margin: 0;
  min-width: 320px;
  background: var(--surface-base);
  color: var(--text-primary);
  font-family: var(--font-sans);
  line-height: 1.5;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
}

button, input, select { font: inherit; }
button { cursor: pointer; }

button:focus-visible,
input:focus-visible,
select:focus-visible {
  outline: 3px solid var(--focus-ring);
  outline-offset: 2px;
}

code, pre { font-family: var(--font-mono); }

h1, h2, h3, h4, p { margin-top: 0; }
p { color: var(--text-secondary); }
strong { color: var(--text-primary); }

.preserve-text { white-space: pre-wrap; }
.empty-state, .muted { color: var(--text-muted); }
.inline-error {
  padding: 0.7rem 0.9rem;
  border-left: 4px solid var(--status-danger);
  color: var(--text-primary);
  background: var(--status-danger-soft);
}
```

- [ ] **Step 3: Port all remaining rules into components.css using this substitution map**

Create `apps/review-ui/src/styles/components.css` containing every rule from the current `apps/review-ui/src/styles.css` EXCEPT those already covered by base.css above (element selectors `*`, body, button/input focus, code/pre, h/p/strong margins, `.preserve-text`, `.empty-state/.muted`, `.inline-error`). Keep selector structure and layout declarations identical; replace colors per this table:

| Current value | Token |
|---|---|
| `#10151c` (backgrounds) | `var(--surface-base)` |
| `#17202b` (bootstrap card bg) | `var(--surface-panel)` |
| `#263748` (button bg), `rgba(255,255,255,0.06)` (row hover) | `var(--surface-raised)` |
| `#0f151c` (input bg) | `var(--surface-inset)` |
| `#e9eef5`, `#f7fbff`, `#f1f6fb`, `#f0f5fa`, `#f4f8fb`, `#ffd5d1`, `#ffe8c9` | `var(--text-primary)` |
| `#bbc9d8`, `#c0ccd8`, `#bed0df`, `#b7c5d3`, `#bcd0df`, `#f1d1ac` | `var(--text-secondary)` |
| `#77c4b5` (eyebrow), `#9ed7ca` (repo code, pressed accent) | `var(--accent)` |
| `#8ea1b3`, `#8195a8`, `#99adbd`, `#627b8f` | `var(--text-muted)` |
| `#2b394b`, `#293646`, `#47576a`, `#4a6278`, `rgba(255,255,255,0.08)` | `var(--border-strong)` for input/card borders, `var(--border-subtle)` for hairline separators (header/footer borders, panel gutters) |
| `#76b7ff` (focus outline) | `var(--focus-ring)` |
| `.disposition-controls button[aria-pressed="true"]`: bg `#9ed7ca` → `var(--accent)`; color `#10221f` → `var(--on-accent)` | |
| check-status passed `#a9e2bf`/`#1a4735` → `var(--status-success)` / `var(--status-success-soft)` | |
| check-status failed `#ffc0bb`/`#502b30` → `var(--status-danger)` / `var(--status-danger-soft)` | |
| check-status not-run `#e0d0a4`/`#493d26` → `var(--status-warning)` / `var(--status-warning-soft)` | |
| source-warning `#b57a49` border → `var(--status-warning)`; bg `#3f2b1f` → `var(--status-warning-soft)`; texts `#ffe8c9`/`#f1d1ac` → `var(--text-primary)`/`var(--text-secondary)` | |
| source-safety-note `#e3bd93` → `var(--text-secondary)` | |
| inline-error `#ff8e88`/`#48262b`/`#ffd5d1` → `var(--status-danger)`/`var(--status-danger-soft)`/`var(--text-primary)` | |
| explorer selected `rgba(88,166,255,0.18)` → `var(--accent-soft)` | |
| explorer badge `rgba(88,166,255,0.25)` → `var(--accent-soft)` | |
| diff add `#7ee787` → `var(--diff-add-text)`; del `#ffa198` → `var(--diff-del-text)` | |
| anchored `rgba(210,153,34,0.16)` + `#d29922` → `var(--diff-anchor-soft)` + `var(--diff-anchor)` | |
| selected block `rgba(88,166,255,…)` outline/bg → `var(--accent)` / `var(--accent-soft)` | |
| pulse keyframe start `rgba(88,166,255,0.45)` → `var(--accent-soft)` | |

Then rewrite `apps/review-ui/src/styles.css` to contain exactly:

```css
@import "./styles/tokens.css";
@import "./styles/base.css";
@import "./styles/components.css";
```

- [ ] **Step 4: Verify visual parity plumbing**

Run: `bun run --cwd apps/review-ui build`
Expected: succeeds

Run: `grep -n "#[0-9a-fA-F]\{3,6\}" apps/review-ui/src/styles/components.css`
Expected: no output (no raw hex outside tokens.css)

Run: `bun run --cwd apps/review-ui test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/review-ui/src/styles.css apps/review-ui/src/styles/
git commit -m "refactor: split review-ui styles onto semantic design tokens"
```

---

### Task 6: IDE-style layout, app bar, Explorer polish, theme-toggle styling

**Files:**
- Modify: `apps/review-ui/src/styles/components.css`
- Modify: `apps/review-ui/src/components/Explorer.tsx` (chevron span only)

**Interfaces:**
- Consumes: tokens from Task 5; `.theme-toggle` class from Task 2 markup.
- Produces: `.app-header__actions`, `.bootstrap-theme`, panel card classes used unchanged by later tasks.

- [ ] **Step 1: Replace layout/header/explorer blocks in components.css**

Apply these rule blocks (replace the existing `.app-shell`, `.app-shell--bootstrap`, `.bootstrap-card*`, `.app-header*`, `.explorer*`, `.workspace` blocks; keep everything else):

```css
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  max-width: none;
  margin: 0 auto;
  padding: var(--space-4) clamp(var(--space-4), 3vw, var(--space-8)) var(--space-4);
}
.app-shell--bootstrap {
  position: relative;
  height: auto;
  min-height: 100vh;
  display: grid;
  place-items: center;
}
.bootstrap-theme { position: absolute; top: var(--space-4); right: var(--space-4); }
.bootstrap-card {
  width: min(560px, 100%);
  padding: clamp(1.5rem, 4vw, 3rem);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--surface-panel);
  box-shadow: 0 2rem 6rem rgb(0 0 0 / 24%);
}

.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding-bottom: var(--space-4);
  border-bottom: 1px solid var(--border-subtle);
}
.app-header h1 { margin: 0; font-size: 1.15rem; letter-spacing: -0.01em; }
.app-header .eyebrow { margin: 0 0 0.1rem; font-size: 0.68rem; }
.app-header__repo { margin: 0; font-size: 0.82rem; color: var(--text-muted); }
.app-header__repo code { color: var(--accent); font-size: 0.82rem; }
.app-header__actions { display: flex; align-items: center; gap: var(--space-2); }

.theme-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0.45rem 0.75rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-secondary);
}
.theme-toggle:hover { background: var(--surface-raised); }

.workspace {
  display: grid;
  grid-template-columns: clamp(220px, 18vw, 300px) minmax(0, 1fr) clamp(340px, 26vw, 420px);
  gap: var(--space-4);
  flex: 1;
  min-height: 0;
  padding-top: var(--space-4);
}

.explorer, .judgment-panel {
  overflow: auto;
  min-height: 0;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--surface-panel);
  padding: var(--space-3);
}
.diff-view {
  overflow: auto;
  min-height: 0;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--surface-panel);
  padding: var(--space-3);
}
.explorer__title {
  margin: 0 0 var(--space-2);
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted);
}
.explorer__dir, .explorer__file {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  text-align: left;
  padding: 5px 6px;
  cursor: pointer;
  border-radius: var(--radius-sm);
}
.explorer__dir:hover, .explorer__file:hover { background: var(--surface-raised); }
.explorer__file[aria-current="true"] {
  background: var(--accent-soft);
  color: var(--accent);
}
.explorer__badge {
  font-size: 0.72rem;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: 999px;
  padding: 0 6px;
}
.explorer__chevron { display: inline-flex; color: var(--text-muted); }

@media (max-width: 850px) {
  .app-shell { height: auto; min-height: 100vh; }
  .workspace { grid-template-columns: 1fr; }
  .explorer, .diff-view, .judgment-panel { overflow: visible; }
}
```

Delete the old standalone `.explorer { border-right: … }` / `.judgment-panel { border-left: … }` gutter rules (panels are cards now).

- [ ] **Step 2: Swap the Explorer chevron glyph for an inline SVG**

In `apps/review-ui/src/components/Explorer.tsx`, replace the chevron span contents:

```tsx
<span className="explorer__chevron" aria-hidden="true">
  <svg viewBox="0 0 16 16" width="12" height="12" style={{ transform: isCollapsed ? "none" : "rotate(90deg)", transition: "transform 120ms ease" }}>
    <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
</span>
```

- [ ] **Step 3: Verify**

Run: `bun run --cwd apps/review-ui test src/components/Explorer.test.tsx src/components/Workspace.test.tsx`
Expected: PASS

Run: `bun run --cwd apps/review-ui build`
Expected: succeeds

- [ ] **Step 4: Commit**

```bash
git add apps/review-ui/src/styles/components.css apps/review-ui/src/components/Explorer.tsx
git commit -m "feat: adopt internal-scroll workspace panels with app bar and polished explorer"
```

---

### Task 7: DiffView readability styles

**Files:**
- Modify: `apps/review-ui/src/styles/components.css`

**Interfaces:**
- Consumes: diff tokens from Task 5.
- Produces: final `.diff-*` appearance; no markup changes.

- [ ] **Step 1: Replace diff blocks in components.css**

```css
.diff-lines {
  list-style: none;
  margin: var(--space-2) 0;
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--surface-inset);
  font-family: var(--font-mono);
  font-size: 0.82rem;
}
.diff-line__body, .diff-line__static {
  display: flex;
  gap: var(--space-2);
  width: 100%;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  text-align: left;
  padding: 1px 6px;
}
.diff-line__body { cursor: pointer; border-radius: var(--radius-sm); }
.diff-line__body:hover { background: var(--surface-raised); }
.line-number {
  min-width: 3ch;
  padding-right: 1rem;
  text-align: right;
  color: var(--text-muted);
  opacity: 0.6;
  user-select: none;
}
.line-sign { min-width: 1ch; user-select: none; }
.diff-line--add .line-sign { color: var(--diff-add-text); }
.diff-line--add code { color: var(--diff-add-text); background: var(--diff-add-bg); border-radius: var(--radius-sm); }
.diff-line--del .line-sign { color: var(--diff-del-text); }
.diff-line--del code { color: var(--diff-del-text); background: var(--diff-del-bg); border-radius: var(--radius-sm); }
.diff-line--anchored {
  box-shadow: inset 3px 0 0 var(--diff-anchor);
  background: var(--diff-anchor-soft);
  border-radius: var(--radius-sm);
}
.diff-line--selected {
  outline: 1px solid var(--accent);
  background: var(--accent-soft);
}
.diff-line--pulse { animation: diff-pulse 1.2s ease-out; }
@keyframes diff-pulse {
  0% { background: var(--accent-soft); }
  100% { background: transparent; }
}
@media (prefers-reduced-motion: reduce) {
  .diff-line--pulse { animation: none; }
  * { transition-duration: 0.01ms !important; }
}
```

Remove the old `.diff-lines`, `.diff-line__body`, `.diff-line__static`, `.line-number`, `.line-sign`, `.diff-line--add/--del/--anchored/--selected/--pulse` rules this replaces.

- [ ] **Step 2: Verify**

Run: `bun run --cwd apps/review-ui test src/components/DiffView.test.tsx`
Expected: PASS

Run: `bun run --cwd apps/review-ui build`
Expected: succeeds

- [ ] **Step 3: Commit**

```bash
git add apps/review-ui/src/styles/components.css
git commit -m "feat: tint diff lines and anchor highlights for both themes"
```

---

### Task 8: DecisionCard, JudgmentPanel, disposition, Bootstrap form styles

**Files:**
- Modify: `apps/review-ui/src/styles/components.css`

**Interfaces:**
- Consumes: status/accent tokens from Task 5; existing markup class names in DecisionCard.tsx / JudgmentPanel.tsx / BootstrapScreen.tsx (unchanged).
- Produces: complete visual system; last styling task.

- [ ] **Step 1: Append/replace judgment + bootstrap blocks in components.css**

```css
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}
.section-heading h2 { margin: 0; font-size: 0.95rem; color: var(--text-primary); }
.section-heading span { color: var(--text-muted); font-size: 0.8rem; }

.judgment-stack { display: flex; flex-direction: column; gap: var(--space-3); margin-top: var(--space-2); }

.decision-card {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--surface-raised);
}
.decision-card__header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--space-3);
}
.decision-card__header .eyebrow {
  margin-bottom: var(--space-1);
  color: var(--accent);
  font-size: 0.68rem;
  font-weight: 650;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.decision-card__header h3 { margin: 0; font-size: 0.95rem; color: var(--text-primary); }
.decision-card__meta { margin: var(--space-1) 0 0; font-size: 0.78rem; color: var(--text-muted); }
.decision-card__warnings { display: grid; gap: var(--space-2); }
.decision-card__targets { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.decision-card__targets h4 { width: 100%; margin: 0; font-size: 0.78rem; color: var(--text-muted); }
.target-link {
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  padding: 2px 8px;
  font-size: 0.78rem;
}
.target-link:hover { background: var(--surface-panel); color: var(--text-primary); }
.target-link code { font-size: inherit; color: inherit; }

.disposition-controls {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 2px;
  min-width: 250px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  padding: 2px;
  background: var(--surface-panel);
}
.disposition-controls legend {
  width: 100%;
  margin-bottom: var(--space-1);
  color: var(--text-muted);
  font-size: 0.72rem;
  text-align: right;
}
.disposition-controls button {
  flex: 1;
  padding: 0.45rem 0.6rem;
  border: 0;
  border-radius: calc(var(--radius-md) - 2px);
  background: transparent;
  color: var(--text-secondary);
}
.disposition-controls button:hover:not(:disabled) { background: var(--surface-raised); }
.disposition-controls button[aria-pressed="true"] { background: var(--surface-raised); color: var(--text-primary); font-weight: 600; }
.disposition-controls button:nth-of-type(1)[aria-pressed="true"] { background: var(--status-success-soft); color: var(--status-success); }
.disposition-controls button:nth-of-type(2)[aria-pressed="true"] { background: var(--status-danger-soft); color: var(--status-danger); }
.disposition-controls button:disabled { cursor: wait; opacity: 0.6; }

button.button-secondary,
.button-secondary {
  padding: 0.45rem 0.85rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-secondary);
}
button.button-secondary:hover, .button-secondary:hover { background: var(--surface-raised); }

button[type="submit"], .bootstrap-card button {
  width: 100%;
  margin-top: var(--space-4);
  padding: 0.65rem 0.85rem;
  border: 1px solid var(--accent);
  border-radius: var(--radius-md);
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
.bootstrap-card button:disabled { cursor: wait; opacity: 0.7; }

.bootstrap-card label { color: var(--text-secondary); font-size: 0.9rem; font-weight: 600; }
.bootstrap-card input,
.bootstrap-card select {
  width: 100%;
  margin-bottom: var(--space-4);
  padding: 0.65rem 0.8rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  background: var(--surface-inset);
}
.source-metadata dt { color: var(--text-muted); font-size: 0.72rem; }
.source-metadata dd { margin: 0; color: var(--text-secondary); font-size: 0.77rem; }

@media (max-width: 850px) {
  .disposition-controls { justify-content: flex-start; min-width: 0; }
  .disposition-controls legend { text-align: left; }
}
```

Remove superseded old rules for `.disposition-controls`, `.check-status*`, `.source-metadata`, `.source-warning`, `.section-heading`, generic `button` padding rule, and `.bootstrap-card input/button` blocks replaced above. Re-add check-status/source-warning with tokens:

```css
.check-status { padding: 0.1rem 0.35rem; border-radius: var(--radius-sm); font-size: 0.7rem; font-weight: 700; }
.check-status--passed { color: var(--status-success); background: var(--status-success-soft); }
.check-status--failed { color: var(--status-danger); background: var(--status-danger-soft); }
.check-status--not-run { color: var(--status-warning); background: var(--status-warning-soft); }
.source-warning {
  padding: var(--space-3);
  border: 1px solid var(--status-warning);
  border-radius: var(--radius-md);
  background: var(--status-warning-soft);
}
.source-warning h4 { margin: 0 0 var(--space-1); color: var(--text-primary); }
.source-warning p { margin: 0 0 var(--space-1); color: var(--text-secondary); font-size: 0.85rem; }
.source-safety-note { color: var(--text-muted); font-size: 0.78rem; }
.source-metadata { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); margin: 0; padding: var(--space-2) 0 0; }
.source-metadata div { display: flex; gap: var(--space-2); align-items: baseline; }
h4 { color: var(--text-primary); font-size: 0.85rem; margin-bottom: var(--space-1); }
```

- [ ] **Step 2: Full unit verification**

Run: `bun run --cwd apps/review-ui test && bun run --cwd apps/review-ui build`
Expected: PASS, build succeeds

- [ ] **Step 3: Visual smoke check (manual)**

Serve locally per CLAUDE.md (build UI, run recorder with `--ui-root`), open http://127.0.0.1:<port>, toggle each theme, confirm: bootstrap card, explorer badges, diff tints, decision card sections, disposition pressed states readable in both themes.

- [ ] **Step 4: Commit**

```bash
git add apps/review-ui/src/styles/components.css
git commit -m "feat: style decision cards, disposition control, and bootstrap form"
```

---

### Task 9: E2E theme coverage + precise token-absence assertion

**Files:**
- Modify: `tests/e2e/review-flow.spec.ts`

**Interfaces:**
- Consumes: built UI (Playwright config builds via `bun run e2e`); ThemeToggle button labeled "Color scheme".
- Produces: regression guard for spec §5 (FOUC, persistence) and keeps §2.5 invariant exact.

- [ ] **Step 1: Narrow the storage assertion**

In `tests/e2e/review-flow.spec.ts`, replace line ~238:

```ts
await expect(page.evaluate(() => localStorage.length)).resolves.toBe(0);
```

with:

```ts
// トークンは一切ストレージに現れないこと(UI設定などの無害なキーは許容)
await expect(page.evaluate(() =>
  Object.values(localStorage).some((value) => String(value).includes(token)),
)).resolves.toBe(false);
```

Update the adjacent comment (line ~235) to say the invariant checked is token-absence rather than empty storage.

- [ ] **Step 2: Add the theme E2E test at the end of the file**

```ts
test("switches the color scheme, persists it, and boots without flashing", async ({ page }) => {
  await page.goto(app.url);
  await expect(page.locator("html")).toHaveAttribute("data-theme", /light|dark/);

  await page.emulateMedia({ colorScheme: "light" });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.evaluate(() => localStorage.getItem("review-ui-theme"))).resolves.toBeNull();

  const toggle = page.getByRole("button", { name: "Color scheme" });
  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.evaluate(() => localStorage.getItem("review-ui-theme"))).resolves.toBe("light");

  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
```

- [ ] **Step 3: Run the suite**

Run: `bun run e2e`
Expected: all specs PASS including the two touched ones

If the full e2e run needs recorder fixtures unavailable locally, run the focused spec and report: `bunx playwright test tests/e2e/review-flow.spec.ts -g "color scheme"`

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/review-flow.spec.ts
git commit -m "test: cover theme persistence end-to-end and pin token-absence invariant"
```

---

### Task 10: Final verification gate

**Files:** none (verification only)

- [ ] **Step 1:** Run `bun run test` — Expected: ALL suites PASS (bun tests + vitest)
- [ ] **Step 2:** Run `bun run --cwd apps/review-ui build` — Expected: succeeds
- [ ] **Step 3:** Run `bun run e2e` — Expected: PASS
- [ ] **Step 4:** If any step required fixes, commit them (`fix: …`) before reporting completion. Report results with actual command output summaries.
