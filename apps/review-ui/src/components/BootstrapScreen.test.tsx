import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BootstrapScreen } from "./BootstrapScreen";

const baseProps = {
  tokenInput: "",
  onTokenChange: vi.fn(),
  repositories: [
    { repository_id: "repo-1", root: "/work/repo-one", created_at: "2026-08-22T00:00:00.000Z" },
    { repository_id: "repo-2", root: "/work/repo-two", created_at: "2026-08-22T01:00:00.000Z" },
  ],
  selectedRepositoryId: "",
  onRepositoryChange: vi.fn(),
  isLoading: false,
  error: null as string | null,
  onSubmit: vi.fn(),
};

describe("BootstrapScreen", () => {
  it("collects the token and submits without embedding it anywhere else", () => {
    const onTokenChange = vi.fn();
    const onSubmit = vi.fn();
    render(<BootstrapScreen {...baseProps} onTokenChange={onTokenChange} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText("Owner bearer token"), { target: { value: "owner-token" } });
    expect(onTokenChange).toHaveBeenCalledWith("owner-token");

    fireEvent.submit(screen.getByRole("button", { name: "Open review timeline" }).closest("form")!);
    expect(onSubmit).toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain('value="owner-token"');
  });

  it("renders the repository picker once repositories are loaded", () => {
    render(<BootstrapScreen {...baseProps} />);
    expect(screen.getByLabelText("Repository")).toBeTruthy();
    expect(screen.getByText("/work/repo-one")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open review timeline" }).textContent).toBe("Open review timeline");
  });

  it("hides the picker before repositories load and shows errors via role=alert", () => {
    render(<BootstrapScreen {...baseProps} repositories={null} isLoading={true} error="Owner token required or not accepted by Recorder." />);
    expect(screen.queryByLabelText("Repository")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Owner token required");
    expect(screen.getByRole("button", { name: "Connecting…" })).toBeTruthy();
  });
});
