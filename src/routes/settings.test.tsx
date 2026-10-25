// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSettingsBackHandler } from "@/lib/noma/system-back";
import { SettingsPage } from "./settings";

/* Settings restructure: the restructured page rendered at its real
 * seam — the route component itself, with the heavy blocks replaced
 * by markers and the data hooks faked. The summary builders and the
 * system-back resolver have their own unit suites; this one proves
 * the IA: eight rows with live summaries, each row opening the
 * sub-screen that mounts its block, and the hardware-back handler
 * registration following the open screen. */

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

const fake = vi.hoisted(() => ({
  settings: {
    theme: "nature",
    fontSize: 17,
    lineHeight: 1.7,
    editorWidth: 720,
    backupMode: "off",
    backupIntervalMinutes: 1440,
    hapticsEnabled: true,
    dynamicColorEnabled: false,
    appLockEnabled: false,
  },
  auth: {
    configured: true,
    user: { uid: "user-1" },
    email: "jubayer@example.com",
    providers: ["password"],
    googleLinked: true,
  },
}));

vi.mock("@tanstack/react-router", async () => {
  const React = await import("react");
  return {
    createFileRoute: () => () => ({}),
    Link: ({ children, to }: { children?: React.ReactNode; to?: string }) =>
      React.createElement("a", { href: to }, children),
  };
});

vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: (_fn: unknown, _deps: unknown, initial: unknown) => initial,
}));

vi.mock("@/hooks/use-noma", () => ({
  useSettings: () => ({ settings: fake.settings, update: vi.fn() }),
}));

vi.mock("@/lib/noma/auth", () => ({
  useAuth: () => ({
    ...fake.auth,
    linkGoogle: vi.fn(),
    unlinkGoogle: vi.fn(),
    signOut: vi.fn(),
  }),
  friendlyAuthError: () => "Something went wrong",
}));

vi.mock("@/lib/noma/DatabaseContext", () => ({
  useDatabase: () => ({ db: { name: "fake-db" } }),
}));

vi.mock("@/components/noma/app-gate", async () => {
  const React = await import("react");
  return {
    AppGate: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

vi.mock("@/components/noma/drive-card", async () => {
  const React = await import("react");
  return { DriveCard: () => React.createElement("div", { "data-testid": "drive-card" }) };
});

vi.mock("@/components/noma/app-lock-section", async () => {
  const React = await import("react");
  return {
    AppLockSection: () => React.createElement("div", { "data-testid": "app-lock-section" }),
  };
});

vi.mock("@/components/noma/backup-encryption-section", async () => {
  const React = await import("react");
  return {
    BackupEncryptionSection: () =>
      React.createElement("div", { "data-testid": "backup-encryption-section" }),
  };
});

vi.mock("@/components/noma/ai-section", async () => {
  const React = await import("react");
  return { AiSection: () => React.createElement("div", { "data-testid": "ai-section" }) };
});

vi.mock("@/components/noma/import-section", async () => {
  const React = await import("react");
  return { ImportSection: () => React.createElement("div", { "data-testid": "import-section" }) };
});

vi.mock("@/components/noma/theme-picker", async () => {
  const React = await import("react");
  return {
    ThemePicker: () => React.createElement("div", { "data-testid": "theme-picker" }),
    THEME_OPTIONS: [
      { id: "light", name: "Light", icon: "", description: "" },
      { id: "dark", name: "Noma's Default", icon: "", description: "" },
      { id: "nature", name: "Nature", icon: "", description: "" },
      { id: "amoled", name: "AMOLED Black", icon: "", description: "" },
      { id: "system", name: "System", icon: "", description: "" },
    ],
  };
});

vi.mock("@/components/noma/backup-unlock-dialog", () => ({
  BackupUnlockDialog: () => null,
}));

let container: HTMLDivElement;
let root: Root;

function renderPage() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<SettingsPage />);
  });
}

function screenEl(id: string): HTMLElement {
  const el = container.querySelector(`[data-screen="${id}"]`);
  if (!el) throw new Error(`screen ${id} not rendered`);
  return el as HTMLElement;
}

function isShown(id: string): boolean {
  return !screenEl(id).hasAttribute("hidden");
}

function rowButton(title: string): HTMLButtonElement {
  const buttons = [...container.querySelectorAll("button")];
  const match = buttons.find((b) => b.textContent?.includes(title));
  if (!match) throw new Error(`row ${title} not found`);
  return match as HTMLButtonElement;
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  window.localStorage.clear();
  fake.settings.appLockEnabled = false;
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("Settings root list", () => {
  it("shows all eight categories with their state summaries", () => {
    renderPage();
    expect(isShown("root")).toBe(true);

    const expected: Array<[string, string]> = [
      ["Sync & backup", "Not connected"],
      ["Security", "App lock off · Encryption off"],
      ["Appearance", "Nature"],
      ["Writing", "17px · 1.7"],
      ["AI features", "Not set up"],
      ["Data", "0 notes on this device"],
      ["Account", "jubayer@example.com"],
      ["About", "v1.2.0"],
    ];
    for (const [title, summary] of expected) {
      const row = rowButton(title);
      expect(row.textContent).toContain(summary);
    }
    for (const id of [
      "sync",
      "security",
      "appearance",
      "writing",
      "ai",
      "data",
      "account",
      "about",
    ]) {
      expect(isShown(id)).toBe(false);
    }
  });

  it("security summary follows the app-lock state", () => {
    fake.settings.appLockEnabled = true;
    renderPage();
    expect(rowButton("Security").textContent).toContain("App lock on · Encryption off");
  });

  it("groups the eight rows into four cards, each row with its icon tile", () => {
    renderPage();
    const root = screenEl("root");
    const cards = [...root.querySelectorAll("section")];
    expect(cards).toHaveLength(4);

    const pairs = cards.map((card) =>
      [...card.querySelectorAll("button")].map((b) => b.textContent ?? ""),
    );
    expect(pairs).toHaveLength(4);
    const pairTitles: Array<[string, string]> = [
      ["Sync & backup", "Security"],
      ["Appearance", "Writing"],
      ["AI features", "Data"],
      ["Account", "About"],
    ];
    pairs.forEach((pair, i) => {
      expect(pair).toHaveLength(2);
      expect(pair[0]).toContain(pairTitles[i]![0]);
      expect(pair[1]).toContain(pairTitles[i]![1]);
    });

    // Every row carries its category icon (an svg inside the button's tile).
    const rowButtons = [...root.querySelectorAll("button")];
    expect(rowButtons).toHaveLength(8);
    for (const button of rowButtons) {
      expect(button.querySelector("svg")).not.toBeNull();
    }
  });
});

describe("Settings sub-screens", () => {
  it("opens Appearance with the theme picker; header back returns to the root", () => {
    renderPage();
    click(rowButton("Appearance"));
    expect(isShown("root")).toBe(false);
    expect(isShown("appearance")).toBe(true);
    expect(screenEl("appearance").querySelector('[data-testid="theme-picker"]')).not.toBeNull();
    expect(container.querySelector("h1")?.textContent).toBe("Appearance");
    // The sub-screen header carries the category's icon tile beside the
    // title: back arrow + tile icon = two svgs (the root header has one).
    expect(container.querySelector("header")?.querySelectorAll("svg")).toHaveLength(2);

    click(rowButton("Settings"));
    expect(isShown("root")).toBe(true);
    expect(isShown("appearance")).toBe(false);
    expect(container.querySelector("h1")?.textContent).toBe("Settings");
    expect(container.querySelector("header")?.querySelectorAll("svg")).toHaveLength(1);
  });

  it("each sub-screen mounts its block", () => {
    renderPage();
    const blocks: Array<[string, string, string]> = [
      ["Sync & backup", "sync", "drive-card"],
      ["Appearance", "appearance", "theme-picker"],
      ["AI features", "ai", "ai-section"],
      ["Data", "data", "import-section"],
    ];
    for (const [title, id, testId] of blocks) {
      click(rowButton(title));
      expect(isShown(id)).toBe(true);
      expect(screenEl(id).querySelector(`[data-testid="${testId}"]`)).not.toBeNull();
      click(rowButton("Settings"));
      expect(isShown("root")).toBe(true);
    }

    click(rowButton("Security"));
    expect(screenEl("security").querySelector('[data-testid="app-lock-section"]')).not.toBeNull();
    expect(
      screenEl("security").querySelector('[data-testid="backup-encryption-section"]'),
    ).not.toBeNull();
    click(rowButton("Settings"));

    click(rowButton("Data"));
    expect(screenEl("data").textContent).toContain("Restore from file");
    expect(screenEl("data").textContent).toContain("0 note(s) stored on this device.");
    click(rowButton("Settings"));

    click(rowButton("Account"));
    expect(screenEl("account").textContent).toContain("Sign-in methods:");
    click(rowButton("Settings"));

    click(rowButton("About"));
    expect(screenEl("about").textContent).toContain("Noma v1.2.0");
    expect(screenEl("about").textContent).toContain("local-first");
  });

  it("registers the hardware-back handler only while a sub-screen is open", () => {
    renderPage();
    expect(getSettingsBackHandler()).toBeNull();

    click(rowButton("Data"));
    const handler = getSettingsBackHandler();
    expect(handler).not.toBeNull();

    let consumed = false;
    act(() => {
      consumed = handler!();
    });
    expect(consumed).toBe(true);
    expect(isShown("root")).toBe(true);
    expect(getSettingsBackHandler()).toBeNull();
  });
});
