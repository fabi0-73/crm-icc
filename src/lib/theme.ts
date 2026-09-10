/**
 * Theme primitives shared by the no-flash boot script (see layout.tsx),
 * the ThemeProvider, and the ThemeToggle.
 *
 * Strategy: Tailwind v4 "class" dark mode. `.dark` on <html> flips the
 * semantic color tokens (defined in globals.css), which flips the whole app
 * because components consume those tokens. The user's choice is one of three
 * modes persisted under `icc.theme`; "system" tracks the OS preference live.
 */

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

/** localStorage key holding the persisted preference. */
export const THEME_STORAGE_KEY = "icc.theme";

/** Default when nothing is stored yet. */
export const DEFAULT_THEME: Theme = "system";

export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

/** Read the persisted preference (client only). Falls back to the default. */
export function readStoredTheme(): Theme {
  if (typeof window === "undefined") return DEFAULT_THEME;
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** True when the OS currently prefers a dark color scheme. */
export function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Collapse a mode into the concrete light/dark that should be applied now. */
export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === "system") return systemPrefersDark() ? "dark" : "light";
  return theme;
}

/** Add/remove the `.dark` class on <html> to match the given mode. */
export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  const dark = resolveTheme(theme) === "dark";
  document.documentElement.classList.toggle("dark", dark);
}

/**
 * Inline <script> body injected into <head> so the `.dark` class is set from
 * the stored/system preference BEFORE first paint — no light flash on load.
 * Kept dependency-free and defensive; mirrors the logic above exactly.
 */
export const themeInitScript = `(function(){try{var k=${JSON.stringify(
  THEME_STORAGE_KEY,
)};var t=window.localStorage.getItem(k);if(t!=="light"&&t!=="dark"&&t!=="system"){t=${JSON.stringify(
  DEFAULT_THEME,
)};}var d=t==="dark"||(t==="system"&&window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);var e=document.documentElement;if(d){e.classList.add("dark");}else{e.classList.remove("dark");}}catch(_){}})();`;
