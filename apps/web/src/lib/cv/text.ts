// Getting plain text out of an uploaded CV, and normalising text so quotes can be compared.

export const ACCEPTED_TYPES = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
} as const;
export const MAX_BYTES = 5 * 1024 * 1024;
// A real CV has far more text than this. Less usually means a scanned image, which ATS systems cannot read either.
export const MIN_TEXT_CHARS = 300;

export type CvKind = (typeof ACCEPTED_TYPES)[keyof typeof ACCEPTED_TYPES];

export function kindFor(mime: string, fileName: string): CvKind | null {
  if (mime in ACCEPTED_TYPES) return ACCEPTED_TYPES[mime as keyof typeof ACCEPTED_TYPES];
  const ext = fileName.toLowerCase().split(".").pop();
  return ext === "pdf" ? "pdf" : ext === "docx" ? "docx" : null;
}

export async function extractCvText(bytes: Uint8Array, kind: CvKind): Promise<string> {
  if (kind === "pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: true });
    return cleanText(text);
  }
  const mammoth = await import("mammoth");
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  return cleanText(value);
}

// Remove invisible characters that break matching, keep line breaks.
export function cleanText(text: string): string {
  return text
    .replace(/[­​-‍﻿]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// For comparing a quote against the CV: case, quotes, dashes, bullets and spacing do not matter.
export function normalize(text: string): string {
  return cleanText(text)
    .toLowerCase()
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[•·▪●◦]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
