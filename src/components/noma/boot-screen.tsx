/**
 * The one branded boot moment for Noma — shown while auth resolves, while
 * the app-lock state resolves, and on the post-sign-in hand-off. It mirrors
 * the native splash and the sidebar brand (glowing icon tile, serif
 * wordmark, tagline) on the leaf-watermark background the lock screen uses,
 * so splash → boot → app reads as a single continuous surface in every
 * theme instead of a bare "Opening Noma…" placeholder.
 */
export function BootScreen() {
  return (
    <div
      className="noma-leaf-watermark flex min-h-dvh flex-col items-center justify-center bg-background px-4 select-none"
      role="status"
      aria-label="Opening Noma"
    >
      <div className="flex flex-col items-center animate-in fade-in zoom-in-95 duration-500 motion-reduce:animate-none">
        <div className="animate-noma-breathe motion-reduce:animate-none">
          <img
            src="/noma-icon-192.png"
            alt=""
            width={80}
            height={80}
            className="noma-glow size-20 rounded-[24px] shadow-lg"
          />
        </div>
        <h1 className="mt-5 font-serif text-3xl font-semibold tracking-tight text-foreground">
          Noma
        </h1>
        <p className="mt-1.5 text-xs text-muted-foreground">A quiet place for your thoughts.</p>
        <div
          className="mt-8 h-0.5 w-32 overflow-hidden rounded-full bg-primary/15"
          aria-hidden="true"
        >
          <div className="animate-noma-progress h-full w-2/5 rounded-full bg-primary/70 motion-reduce:animate-none" />
        </div>
      </div>
    </div>
  );
}
