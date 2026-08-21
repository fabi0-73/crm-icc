import type { Metadata, Viewport } from "next";
import { Manrope } from "next/font/google";
import "./globals.css";

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
  themeColor: "#f8fafc",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={manrope.variable}>
      <body
        className="font-sans"
        style={{ "--font-sans": "var(--font-manrope)" } as React.CSSProperties}
      >
        {children}
      </body>
    </html>
  );
}
