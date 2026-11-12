import "./setup.ts";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SettingsPage, type SettingsConfig } from "../src/pages/Settings.tsx";

afterEach(cleanup);

function cfg(): SettingsConfig {
  return {
    terminalApp: "iTerm",
    portFrom: 8787,
    workers: 2,
    maxWorkers: 3,
    checkAttempts: 3,
    checkTimeoutMin: 15,
    maxHeavy: 1,
    stallMin: 10,
    contextRestartAt: 85,
    switch: { enabled: true, at: 90, from: "claude", to: "codex" },
    roles: {
      admin: { tool: "claude", model: "opus" },
      orchestrator: { tool: "claude", model: "opus" },
      worker: { tool: "codex", model: "" },
      reviewer1: { tool: "codex", model: "" },
      reviewer2: { tool: "claude", model: "sonnet" },
      cardRunner: { tool: "codex", model: "luna" },
    },
  };
}

const save = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;

describe("SettingsPage", () => {
  test("one row per role with a tool select and a model field", () => {
    render(<SettingsPage config={cfg()} onSave={async () => null} />);
    for (const r of ["Admin", "Orchestrator", "Worker", "Reviewer 1", "Reviewer 2", "Card runner"]) {
      expect(field(`${r} tool`).value).toBe(cfg().roles[({ Admin: "admin", Orchestrator: "orchestrator", Worker: "worker", "Reviewer 1": "reviewer1", "Reviewer 2": "reviewer2", "Card runner": "cardRunner" } as const)[r as "Admin"]].tool);
      expect(field(`${r} model`)).toBeTruthy();
    }
    expect(field("Card runner model").value).toBe("luna");
    const opts = Array.from(field("Admin tool").querySelectorAll("option")).map((o) => o.textContent);
    expect(opts).toEqual(["Claude Code", "Codex"]);
  });

  test("the other settings show their values", () => {
    render(<SettingsPage config={cfg()} onSave={async () => null} />);
    expect(field("Terminal app").value).toBe("iTerm");
    expect(field("Workers per chat").value).toBe("2");
    expect(field("Check attempts").value).toBe("3");
    expect(field("Check timeout (min)").value).toBe("15");
    expect(field("Usage threshold %").value).toBe("90");
    expect(field("Context threshold %").value).toBe("85");
  });

  test("Save is off until something changes", () => {
    render(<SettingsPage config={cfg()} onSave={async () => null} />);
    expect(save().disabled).toBe(true);
    fireEvent.change(field("Admin model"), { target: { value: "sonnet" } });
    expect(save().disabled).toBe(false);
    fireEvent.change(field("Admin model"), { target: { value: "opus" } });
    expect(save().disabled).toBe(true);
  });

  test("Save sends the whole config with the edits", async () => {
    const onSave = mock(async (_c: SettingsConfig) => null as string | null);
    render(<SettingsPage config={cfg()} onSave={onSave} />);
    fireEvent.change(field("Worker tool"), { target: { value: "claude" } });
    fireEvent.change(field("Worker model"), { target: { value: "sonnet" } });
    fireEvent.change(field("Terminal app"), { target: { value: "Terminal" } });
    fireEvent.change(field("Workers per chat"), { target: { value: "3" } });
    fireEvent.change(field("Check attempts"), { target: { value: "5" } });
    fireEvent.change(field("Check timeout (min)"), { target: { value: "30" } });
    fireEvent.change(field("Usage threshold %"), { target: { value: "80" } });
    fireEvent.change(field("Context threshold %"), { target: { value: "70" } });
    await act(async () => {
      fireEvent.click(save());
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    // The call count was checked on the line above, so index 0 exists.
    const sent = onSave.mock.calls[0]![0];
    expect(sent.roles.worker).toEqual({ tool: "claude", model: "sonnet" });
    expect(sent.terminalApp).toBe("Terminal");
    expect(sent.workers).toBe(3);
    expect(sent.checkAttempts).toBe(5);
    expect(sent.checkTimeoutMin).toBe(30);
    expect(sent.switch).toEqual({ enabled: true, at: 80, from: "claude", to: "codex" });
    expect(sent.contextRestartAt).toBe(70);
    expect(sent.portFrom).toBe(8787);
    expect(sent.maxHeavy).toBe(1);
    expect(save().disabled).toBe(true);
  });

  test("an error text from the engine shows as is", async () => {
    render(<SettingsPage config={cfg()} onSave={async () => `/x/config.json: "workers" must not be more than "maxWorkers"`} />);
    fireEvent.change(field("Check attempts"), { target: { value: "4" } });
    await act(async () => {
      fireEvent.click(save());
    });
    expect(screen.getByRole("alert").textContent).toBe(`/x/config.json: "workers" must not be more than "maxWorkers"`);
    expect(save().disabled).toBe(false);
  });

  test("a number out of range is not sent and the field shows its range", async () => {
    const onSave = mock(async (_c: SettingsConfig) => null as string | null);
    render(<SettingsPage config={cfg()} onSave={onSave} />);
    fireEvent.change(field("Workers per chat"), { target: { value: "5" } });
    fireEvent.change(field("Check attempts"), { target: { value: "11" } });
    expect(screen.getAllByText("2–3").length).toBeGreaterThan(0);
    expect(field("Workers per chat").getAttribute("aria-invalid")).toBe("true");
    await act(async () => {
      fireEvent.click(save());
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  test("a blank or fractional number is out of range", async () => {
    const onSave = mock(async (_c: SettingsConfig) => null as string | null);
    render(<SettingsPage config={cfg()} onSave={onSave} />);
    fireEvent.change(field("Check timeout (min)"), { target: { value: "" } });
    expect(field("Check timeout (min)").getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(field("Check timeout (min)"), { target: { value: "1.5" } });
    expect(field("Check timeout (min)").getAttribute("aria-invalid")).toBe("true");
    await act(async () => {
      fireEvent.click(save());
    });
    expect(onSave).not.toHaveBeenCalled();
  });
});
