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
    const toggle = screen.getByRole("button", { name: /Color scheme/ });
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
    const toggle = screen.getByRole("button", { name: /Color scheme/ });
    expect(labelOf(toggle)).toBe("Dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
