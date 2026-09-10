"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

const STORAGE_KEY = "icc-theme";

type ThemeContextValue = {
  dark: boolean;
  setDark: (next: boolean) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside ThemeProvider");
  return ctx;
}

function applyDarkClass(dark: boolean) {
  document.documentElement.classList.toggle("dark", dark);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [dark, setDarkState] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) === "dark";
    setDarkState(stored);
    applyDarkClass(stored);
  }, []);

  const setDark = useCallback((next: boolean) => {
    setDarkState(next);
    applyDarkClass(next);
    localStorage.setItem(STORAGE_KEY, next ? "dark" : "light");
  }, []);

  const value = useMemo(() => ({ dark, setDark }), [dark, setDark]);
  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}
