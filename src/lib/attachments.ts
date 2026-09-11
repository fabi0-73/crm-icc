/**
 * Attachment allow-list. Anything executable (or otherwise able to run
 * on a colleague's machine) is refused before the upload starts, so a
 * blocked file never reaches storage or the message row.
 */

export const ALLOWED_ATTACHMENT_EXTENSIONS = [
  // images
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "heif",
  // documents
  "pdf", "doc", "docx", "xls", "xlsx", "xlsm", "csv", "ppt", "pptx",
  "odt", "ods", "odp", "rtf", "txt", "md", "json", "xml",
  // audio / video
  "mp3", "wav", "m4a", "ogg", "opus", "aac", "mp4", "mov", "webm", "mkv", "avi",
  // archives
  "zip", "7z", "rar", "tar", "gz",
] as const;

/**
 * Extensions that are refused outright even if something upstream ever
 * widens the allow-list — kept explicit so the reason is obvious.
 */
const BLOCKED_EXTENSIONS = [
  "exe", "msi", "bat", "cmd", "com", "cpl", "scr", "pif", "vb", "vbs",
  "vbe", "js", "jse", "wsf", "wsh", "ps1", "psm1", "sh", "bash", "zsh",
  "jar", "app", "dmg", "pkg", "deb", "rpm", "apk", "dll", "sys", "drv",
  "reg", "lnk", "hta", "iso", "img", "gadget", "scf", "inf", "msc",
];

export const ATTACHMENT_ACCEPT = ALLOWED_ATTACHMENT_EXTENSIONS.map(
  (e) => `.${e}`,
).join(",");

export function fileExtension(name: string) {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Returns an error message when the file may not be sent, else null. */
export function attachmentError(file: File): string | null {
  const ext = fileExtension(file.name);
  if (!ext) {
    return `"${file.name}" has no file type and can't be sent.`;
  }
  if (BLOCKED_EXTENSIONS.includes(ext)) {
    return `"${file.name}" is a program file (.${ext}) and can't be sent.`;
  }
  if (!(ALLOWED_ATTACHMENT_EXTENSIONS as readonly string[]).includes(ext)) {
    return `".${ext}" files can't be sent. Allowed: documents, images, audio, video and archives.`;
  }
  return null;
}
