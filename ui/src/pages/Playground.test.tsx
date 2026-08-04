import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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

    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(await screen.findByText("Untitled request")).toBeInTheDocument();
    expect(window.localStorage.getItem("restly-request-workspace")).toContain("Untitled request");
  });
});
