import { useRef, useState } from "react";
import { ChevronDown, ChevronRight, FileArchive, FileUp, FolderUp, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { NomaDatabase } from "@/lib/noma/db";
import {
  createImportImageResolver,
  importNotes,
  parseImportZip,
  parseKeepTakeout,
  parseMarkdownFiles,
  type ImportParseResult,
  type MarkdownFileInput,
  type SkippedImportFile,
} from "@/lib/noma/importers";

interface ImportSummary {
  imported: number;
  duplicates: number;
  failed: number;
  unreadable: SkippedImportFile[];
  attachmentsSkipped: number;
  imagesUnresolved: number;
  coloredNotes: number;
}

function mergeParseResults(results: ImportParseResult[]): ImportParseResult {
  const merged: ImportParseResult = {
    notes: [],
    skippedFiles: [],
    attachmentsSkipped: 0,
    imagesUnresolved: 0,
    coloredNotes: 0,
  };
  for (const result of results) {
    merged.notes.push(...result.notes);
    merged.skippedFiles.push(...result.skippedFiles);
    merged.attachmentsSkipped += result.attachmentsSkipped;
    merged.imagesUnresolved += result.imagesUnresolved;
    merged.coloredNotes += result.coloredNotes;
  }
  return merged;
}

function filePath(file: File): string {
  const withPath = file as File & { webkitRelativePath?: string };
  return withPath.webkitRelativePath || file.name;
}

const TEXT_FILE = /\.(md|markdown|txt)$/i;

/**
 * "Import from…" — brings notes in from Google Keep and Markdown/text
 * sources. Importing only ever adds notes (see importers.ts); restoring
 * a Noma backup stays the separate flow above.
 */
export function ImportSection({ db, ownerId }: { db: NomaDatabase; ownerId: string | null }) {
  const keepInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"keep" | "files" | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [showUnreadable, setShowUnreadable] = useState(false);
  const [folderSupported] = useState(
    () => typeof document !== "undefined" && "webkitdirectory" in document.createElement("input"),
  );

  async function runImport(parsed: ImportParseResult) {
    const report = await importNotes(db, ownerId, parsed.notes, (done, total) =>
      setProgress({ done, total }),
    );
    setSummary({
      imported: report.imported,
      duplicates: report.duplicates,
      failed: report.failed,
      unreadable: [
        ...parsed.skippedFiles,
        ...report.failedNames.map((name) => ({ name, reason: "Couldn't be saved." })),
      ],
      attachmentsSkipped: parsed.attachmentsSkipped,
      imagesUnresolved: parsed.imagesUnresolved,
      coloredNotes: parsed.coloredNotes,
    });
    setShowUnreadable(false);
    if (report.imported > 0) {
      toast.success(`Imported ${report.imported} note${report.imported === 1 ? "" : "s"}`);
    } else if (report.duplicates > 0) {
      toast.success("Everything in that import is already in your library");
    } else {
      toast.error("Nothing could be imported from that selection");
    }
  }

  async function handleKeepFile(file: File) {
    setBusy("keep");
    setSummary(null);
    try {
      await runImport(await parseKeepTakeout(file));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Import failed");
    } finally {
      setBusy(null);
      setProgress(null);
      if (keepInput.current) keepInput.current.value = "";
    }
  }

  async function handleMarkdownSelection(fileList: FileList) {
    setBusy("files");
    setSummary(null);
    try {
      const files = Array.from(fileList);
      const parsed: ImportParseResult[] = [];

      // ZIPs among the selection are imports of their own.
      for (const file of files.filter((f) => /\.zip$/i.test(f.name))) {
        parsed.push(await parseImportZip(file));
      }

      // Text files form one file set, so relative image references can
      // resolve against images picked alongside them (folder imports).
      const textFiles = files.filter((f) => TEXT_FILE.test(f.name));
      if (textFiles.length > 0) {
        const imageFiles = new Map<string, { name: string; blob: Blob }>();
        for (const file of files) {
          if (!TEXT_FILE.test(file.name) && !/\.zip$/i.test(file.name)) {
            imageFiles.set(filePath(file), { name: file.name, blob: file });
          }
        }
        const inputs: MarkdownFileInput[] = [];
        for (const file of textFiles) {
          inputs.push({
            name: file.name,
            path: filePath(file),
            text: await file.text(),
            lastModified: file.lastModified,
          });
        }
        parsed.push(await parseMarkdownFiles(inputs, createImportImageResolver(imageFiles)));
      }

      if (parsed.length === 0) {
        toast.error("No Markdown or text files in that selection");
        return;
      }
      await runImport(mergeParseResults(parsed));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Import failed");
    } finally {
      setBusy(null);
      setProgress(null);
      if (filesInput.current) filesInput.current.value = "";
      if (folderInput.current) folderInput.current.value = "";
    }
  }

  const running = busy !== null;

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium">Import from…</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Importing adds notes — it never replaces or deletes what&apos;s here.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          className="gap-2"
          disabled={running}
          onClick={() => keepInput.current?.click()}
        >
          {busy === "keep" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <FileArchive className="size-4" />
          )}
          Google Keep (.zip)
        </Button>
        <Button
          variant="outline"
          className="gap-2"
          disabled={running}
          onClick={() => filesInput.current?.click()}
        >
          {busy === "files" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <FileUp className="size-4" />
          )}
          Markdown or text files
        </Button>
        {folderSupported && (
          <Button
            variant="outline"
            className="gap-2"
            disabled={running}
            onClick={() => folderInput.current?.click()}
          >
            <FolderUp className="size-4" />
            Markdown folder
          </Button>
        )}
        <input
          ref={keepInput}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleKeepFile(file);
          }}
        />
        <input
          ref={filesInput}
          type="file"
          accept=".md,.markdown,.txt,.zip"
          multiple
          className="hidden"
          onChange={(event) => {
            if (event.target.files?.length) void handleMarkdownSelection(event.target.files);
          }}
        />
        {folderSupported && (
          <input
            ref={(el) => {
              folderInput.current = el;
              if (el) el.setAttribute("webkitdirectory", "");
            }}
            type="file"
            className="hidden"
            onChange={(event) => {
              if (event.target.files?.length) void handleMarkdownSelection(event.target.files);
            }}
          />
        )}
      </div>

      {progress && (
        <p className="text-sm text-muted-foreground" role="status">
          Importing {progress.done} / {progress.total}…
        </p>
      )}

      {summary && (
        <div className="rounded-2xl border border-border bg-card p-4 text-sm">
          <p>
            Imported {summary.imported} note{summary.imported === 1 ? "" : "s"}
            {summary.duplicates > 0 && ` · skipped ${summary.duplicates} already imported`}
            {summary.unreadable.length > 0 &&
              ` · ${summary.unreadable.length} file${summary.unreadable.length === 1 ? "" : "s"} couldn't be read`}
            {summary.attachmentsSkipped > 0 &&
              ` · ${summary.attachmentsSkipped} attachment${summary.attachmentsSkipped === 1 ? "" : "s"} skipped`}
            {summary.imagesUnresolved > 0 &&
              ` · ${summary.imagesUnresolved} image${summary.imagesUnresolved === 1 ? "" : "s"} couldn't be found`}
          </p>
          {summary.coloredNotes > 0 && (
            <p className="mt-1 text-muted-foreground">
              Note colours aren&apos;t supported in Noma, so coloured Keep notes were imported
              without their colour.
            </p>
          )}
          {summary.unreadable.length > 0 && (
            <div className="mt-2">
              <button
                type="button"
                className="inline-flex items-center gap-1 text-muted-foreground underline-offset-4 hover:underline"
                onClick={() => setShowUnreadable((value) => !value)}
                aria-expanded={showUnreadable}
              >
                {showUnreadable ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronRight className="size-3.5" />
                )}
                Files that couldn&apos;t be read
              </button>
              {showUnreadable && (
                <ul className="mt-1.5 space-y-1 text-muted-foreground">
                  {summary.unreadable.map((file, index) => (
                    <li key={`${file.name}-${index}`}>
                      {file.name} — {file.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Using Apple Notes? Apple Notes doesn&apos;t export files — export your notes to Markdown on
        a Mac (e.g. with the Exporter app), then import that folder here.
      </p>
    </div>
  );
}
