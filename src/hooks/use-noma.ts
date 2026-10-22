import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useEffect, useState } from "react";
import { saveSettings } from "@/lib/noma/db";
import { useDatabase } from "@/lib/noma/DatabaseContext";
import { DEFAULT_SETTINGS, withBackupModeMigration, type AppSettings } from "@/lib/noma/types";

export function useSettings() {
  const { db } = useDatabase();
  // Live queries must stay read-only — Dexie rejects writes inside them, so the
  // defaults row is seeded from an effect instead of the observable.
  // The result is wrapped so `undefined` means "still loading" and a missing
  // row resolves as `{ row: undefined }` — otherwise `ready` never flips.
  const result = useLiveQuery(
    async () => (db ? { row: await db.settings.get("app") } : undefined),
    [db],
    undefined,
  );
  const stored = result?.row;
  const settings: AppSettings = withBackupModeMigration(
    {
      ...DEFAULT_SETTINGS,
      ...(stored ?? {}),
      unlockMethods: {
        ...DEFAULT_SETTINGS.unlockMethods,
        ...(stored?.unlockMethods ?? {}),
      },
    },
    stored,
  );

  useEffect(() => {
    if (!result) return;
    if (!result.row) void db?.settings.put(DEFAULT_SETTINGS);
  }, [result, db?.settings]);

  const update = useCallback(
    async (patch: Partial<AppSettings>) => {
      if (!db) return;
      await saveSettings(db!, patch);
    },
    [db],
  );

  return { settings, update, ready: result !== undefined };
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);
  return online;
}
