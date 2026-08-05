import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../context/ToastContext";
import PlaygroundPage from "./Playground";

function renderPage() {
  return render(
    <ToastProvider>
      <PlaygroundPage />
    </ToastProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  window.localStorage.clear();
});

describe("PlaygroundPage", () => {
  it("sends a request and renders the formatted response", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    renderPage();

    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText('"status": "ok"', { exact: false })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:3000/data/users",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("saves the current request to the local workspace", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByText("Untitled request")).toBeInTheDocument();
    expect(window.localStorage.getItem("restly-request-workspace")).toContain("Untitled request");
  });

  it("does not overwrite a saved request after opening a recent run", async () => {
    window.localStorage.setItem(
      "restly-request-workspace",
      JSON.stringify({
        baseUrl: "",
        variables: [],
        saved: [
          {
            id: "saved-request",
            updatedAt: 1,
            name: "Saved request",
            method: "POST",
            path: "/data/original",
            params: [],
            headers: [],
            body: '{"original":true}',
            assertions: [],
          },
        ],
        history: [
          {
            id: "recent-run",
            name: "Recent request",
            method: "GET",
            path: "/data/from-history",
            status: 200,
            durationMs: 4,
            timestampMs: 1,
          },
        ],
      }),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: /^post saved request$/i }));
    await user.click(screen.getByRole("button", { name: /data\/from-history/i }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    const workspace = JSON.parse(window.localStorage.getItem("restly-request-workspace") ?? "{}");
    expect(workspace.saved).toHaveLength(2);
    expect(workspace.saved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "saved-request", path: "/data/original" }),
        expect.objectContaining({ method: "GET", path: "/data/from-history" }),
      ]),
    );
  });

  it("deletes a saved request from the local workspace", async () => {
    window.localStorage.setItem(
      "restly-request-workspace",
      JSON.stringify({
        baseUrl: "",
        variables: [],
        saved: [
          {
            id: "saved-request",
            updatedAt: 1,
            name: "Saved request",
            method: "GET",
            path: "/data/users",
            params: [],
            headers: [],
            body: "",
            assertions: [],
          },
        ],
        history: [],
      }),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole("button", { name: "Delete saved request Saved request" }));

    expect(screen.queryByRole("button", { name: /saved request/i })).not.toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem("restly-request-workspace") ?? "{}").saved).toEqual([]);
  });
});
