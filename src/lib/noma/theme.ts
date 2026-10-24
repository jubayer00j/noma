export type ThemeChoice = "light" | "dark" | "system" | "nature" | "amoled";

/** Mirror of the stored preference so the theme can apply before IndexedDB opens. */
export const THEME_STORAGE_KEY = "noma-theme";

/**
 * Cache of the last Material You palette pull (native-feel #7), owned by
 * dynamic-color.ts: the enabled flag plus the per-mode accent var maps,
 * so THEME_BOOTSTRAP_SCRIPT can paint the wallpaper colours pre-frame
 * instead of flashing the stylesheet palette on cold start.
 */
export const DYNAMIC_COLOR_STORAGE_KEY = "noma-dynamic-color";

/** Nature is a fully-resolved warm light theme; AMOLED Black is pure dark. */
export function resolveTheme(choice: ThemeChoice): "light" | "dark" {
  if (choice === "nature") return "light";
  if (choice === "amoled") return "dark";
  if (choice === "system") {
    if (typeof window === "undefined") return "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return choice;
}

/** Applies the theme to <html> immediately; safe to call on every change. */
export function applyTheme(choice: ThemeChoice) {
  if (typeof document === "undefined") return;
  const resolved = resolveTheme(choice);
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.classList.toggle("nature", choice === "nature");
  root.classList.toggle("amoled", choice === "amoled");
  root.style.colorScheme = resolved;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    /* private mode — the stored setting still wins next load */
  }
}

/**
 * Inline, render-blocking snippet that prevents a theme flash on first paint.
 * The second block applies the cached Material You vars (native-feel #7)
 * when the cache record says enabled, picking the map for the mode the
 * first block just resolved (`d`); it is fully self-contained — an absent
 * or corrupt record changes nothing.
 */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){try{var c=localStorage.getItem('${THEME_STORAGE_KEY}')||'system';var n=c==='nature';var a=c==='amoled';var d=c==='dark'||a||(!n&&c==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);document.documentElement.classList.toggle('nature',n);document.documentElement.classList.toggle('amoled',a);document.documentElement.style.colorScheme=d?'dark':'light';}catch(e){}try{var r=localStorage.getItem('${DYNAMIC_COLOR_STORAGE_KEY}');if(r){var p=JSON.parse(r);if(p&&p.enabled===true){var v=p[d?'dark':'light'];if(v){var s=document.documentElement.style;for(var k in v){if(typeof v[k]==='string'){s.setProperty(k,v[k]);}}}}}}catch(e){}})();`;
