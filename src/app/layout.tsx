import type { Metadata, Viewport } from "next";
import { Manrope } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/ThemeProvider";
import { themeInitScript } from "@/lib/theme";

const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-manrope",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ICC Desk",
  description: "Internal messaging for agent support teams",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "ICC Desk",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  // Draw under the notch/home indicator; safe-area insets pad it back.
  viewportFit: "cover",
  // Android: shrink the layout viewport when the keyboard opens.
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8fafc" },
    { media: "(prefers-color-scheme: dark)", color: "#0e1116" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={manrope.variable} suppressHydrationWarning>
      <body
        className="font-sans"
        style={{ "--font-sans": "var(--font-manrope)" } as React.CSSProperties}
      >
        {/* Parser-blocking inline script: sets the theme class before the app
            paints so there's no light flash on load. Kept as the first child of
            <body> (rather than a manual <head>) so Next's metadata is untouched. */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
