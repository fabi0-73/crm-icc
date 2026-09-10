"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  applyTheme,
  DEFAULT_THEME,
  readStoredTheme,
  THEME_STORAGE_KEY,
  type Theme,
} from "@/lib/theme";

type ThemeContextValue = {
  /** The chosen mode: "light" | "dark" | "system". */
  theme: Theme;
  /** Persist + apply a new mode. */
  setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Owns the runtime theme: reads the persisted preference on mount, keeps the
 * `.dark` class on <html> in sync, and (in "system" mode) follows live OS
 * changes. The no-flash script in layout.tsx has already set the correct class
 * before this mounts, so there is no flash while we catch up.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Start from the default so server and client first render agree; the real
  // stored value is loaded in the effect below (hence the `mounted` gate).
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME);
  const [mounted, setMounted] = useState(false);

  // Load the persisted preference once, after hydration.
  useEffect(() => {
    setThemeState(readStoredTheme());
    setMounted(true);
  }, []);

  // Apply the class, and (only in "system" mode) subscribe to OS changes.
  useEffect(() => {
    if (!mounted) return; // don't clobber the boot script's class before load
    applyTheme(theme);

    if (theme !== "system") return;
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [theme, mounted]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* storage may be unavailable (private mode) — apply still runs */
    }
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

/** Read + set the current theme. Must be used within <ThemeProvider>. */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return ctx;
}
