"use client";

/**
 * Browser-tab unread indicator: a count prefix on the document title and
 * a small dot drawn onto the favicon. Both are cleared when the count
 * returns to zero (which happens as soon as the unread rooms are read).
 * Everything is best-effort and guarded — a tab with no favicon link, or
 * a canvas that refuses to render, simply keeps the title behaviour.
 */

let baseTitle: string | null = null;
let faviconEl: HTMLLinkElement | null = null;
let baseIconHref: string | null = null;
let baseImage: HTMLImageElement | null = null;
let lastCount = -1;

function ensureFavicon(): HTMLLinkElement | null {
  if (typeof document === "undefined") return null;
  if (faviconEl) return faviconEl;
  let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  faviconEl = link;
  baseIconHref = link.getAttribute("href");
  return link;
}

function paintFavicon(count: number) {
  const link = ensureFavicon();
  if (!link) return;

  const draw = (img: HTMLImageElement | null) => {
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (img) ctx.drawImage(img, 0, 0, size, size);

    if (count > 0) {
      // A clean accent dot, top-right, with the count when it fits.
      const r = size * 0.3;
      const cx = size - r - 2;
      const cy = r + 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = "#ef4444";
      ctx.fill();

      const label = count > 9 ? "9+" : String(count);
      ctx.fillStyle = "#ffffff";
      ctx.font = `700 ${label.length > 1 ? 26 : 34}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, cx, cy + 1);
    }

    try {
      link.type = "image/png";
      link.href = canvas.toDataURL("image/png");
    } catch {
      /* tainted canvas or data-URL blocked — leave the icon as-is */
    }
  };

  if (count <= 0) {
    if (baseIconHref) link.href = baseIconHref;
    return;
  }

  if (baseImage) {
    draw(baseImage);
    return;
  }
  if (baseIconHref) {
    const img = new Image();
    img.onload = () => {
      baseImage = img;
      draw(img);
    };
    img.onerror = () => draw(null);
    img.src = baseIconHref;
  } else {
    draw(null);
  }
}

/** Reflect `count` unread on the tab. Call with 0 to clear. */
export function setTabBadge(count: number) {
  if (typeof document === "undefined") return;
  if (count === lastCount) return;
  lastCount = count;

  if (baseTitle === null) {
    baseTitle = document.title.replace(/^\(\d+\+?\)\s*/, "");
  }
  const prefix = count > 0 ? `(${count > 9 ? "9+" : count}) ` : "";
  document.title = `${prefix}${baseTitle}`;

  paintFavicon(count);
}
