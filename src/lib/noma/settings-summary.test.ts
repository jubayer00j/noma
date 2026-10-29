import { describe, expect, it } from "vitest";
import {
  aboutSummary,
  accountSummary,
  aiSummary,
  appearanceSummary,
  dataSummary,
  securitySummary,
  syncSummary,
  writingSummary,
} from "./settings-summary";

/* Settings restructure: the root-list summaries are pure derivations —
 * every state combination that a row can display is pinned here. */

describe("syncSummary", () => {
  it("disconnected Drive is 'Not connected' whatever the mode says", () => {
    for (const backupMode of ["off", "sync", "scheduled"] as const) {
      expect(syncSummary({ connected: false, backupMode, backupIntervalMinutes: 1440 })).toBe(
        "Not connected",
      );
    }
  });

  it("connected + sync mode", () => {
    expect(syncSummary({ connected: true, backupMode: "sync", backupIntervalMinutes: 1440 })).toBe(
      "Connected · Sync",
    );
  });

  it("connected + off", () => {
    expect(syncSummary({ connected: true, backupMode: "off", backupIntervalMinutes: 1440 })).toBe(
      "Connected · Off",
    );
  });

  it("connected + scheduled carries the interval label", () => {
    expect(
      syncSummary({ connected: true, backupMode: "scheduled", backupIntervalMinutes: 1440 }),
    ).toBe("Connected · Scheduled · Daily");
    expect(
      syncSummary({ connected: true, backupMode: "scheduled", backupIntervalMinutes: 360 }),
    ).toBe("Connected · Scheduled · Every 6 hours");
    expect(
      syncSummary({ connected: true, backupMode: "scheduled", backupIntervalMinutes: 10080 }),
    ).toBe("Connected · Scheduled · Every 7 days");
  });
});

describe("securitySummary", () => {
  it("both halves on", () => {
    expect(securitySummary({ appLockEnabled: true, encryptionEnabled: true })).toBe(
      "App lock on · Encryption on",
    );
  });

  it("halves are independent", () => {
    expect(securitySummary({ appLockEnabled: true, encryptionEnabled: false })).toBe(
      "App lock on · Encryption off",
    );
    expect(securitySummary({ appLockEnabled: false, encryptionEnabled: true })).toBe(
      "App lock off · Encryption on",
    );
    expect(securitySummary({ appLockEnabled: false, encryptionEnabled: false })).toBe(
      "App lock off · Encryption off",
    );
  });
});

describe("appearanceSummary", () => {
  const options = [
    { id: "light", name: "Light" },
    { id: "nature", name: "Nature" },
    { id: "system", name: "System" },
  ];

  it("resolves the display name from the options list", () => {
    expect(appearanceSummary("nature", options)).toBe("Nature");
    expect(appearanceSummary("system", options)).toBe("System");
  });

  it("falls back to the raw id for an unknown theme", () => {
    expect(appearanceSummary("amoled", options)).toBe("amoled");
  });
});

describe("writingSummary", () => {
  it("formats font size and line height as the sliders show them", () => {
    expect(writingSummary({ fontSize: 17, lineHeight: 1.7 })).toBe("17px · 1.7");
    expect(writingSummary({ fontSize: 14, lineHeight: 2 })).toBe("14px · 2.0");
  });
});

describe("aiSummary", () => {
  it("key saved vs not set up", () => {
    expect(aiSummary({ hasKey: true })).toBe("Key saved");
    expect(aiSummary({ hasKey: false })).toBe("Not set up");
  });
});

describe("dataSummary", () => {
  it("pluralizes the note count", () => {
    expect(dataSummary(0)).toBe("0 notes on this device");
    expect(dataSummary(1)).toBe("1 note on this device");
    expect(dataSummary(128)).toBe("128 notes on this device");
  });
});

describe("accountSummary", () => {
  it("prefers the signed-in email", () => {
    expect(accountSummary({ email: "a@b.c", signedIn: true })).toBe("a@b.c");
  });

  it("signed in without an email on record", () => {
    expect(accountSummary({ email: null, signedIn: true })).toBe("Signed in");
  });

  it("signed out is Local Mode", () => {
    expect(accountSummary({ email: null, signedIn: false })).toBe("Local Mode");
  });
});

describe("aboutSummary", () => {
  it("prefixes a bare version and leaves a prefixed one alone", () => {
    expect(aboutSummary("1.0.1")).toBe("v1.0.1");
    expect(aboutSummary("v2.3.4")).toBe("v2.3.4");
  });
});
