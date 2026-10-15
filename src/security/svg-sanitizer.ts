/**
 * SVG upload safety check, ported from the PHP edition (`cx_svg_safe`).
 *
 * SVG is accepted in the media library for logos and favicons only when it carries no script,
 * event handler, external reference or embedded document. The check is a strict allow-by-absence
 * screen: anything suspicious is rejected rather than rewritten, so stored bytes always equal the
 * uploaded (and hashed) bytes.
 */

export const MAX_SVG_BYTES = 512 * 1024;

const STRUCTURE =
  /^(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE svg[^>[]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i;
const FORBIDDEN_ELEMENTS =
  /<\s*(?:script|foreignObject|iframe|object|embed|audio|video|canvas|link|meta|base|form|input|animate[a-z]*|set|handler|listener)\b/i;
const FORBIDDEN_PATTERNS =
  /<!ENTITY|\bon[a-z]+\s*=|javascript\s*:|vbscript\s*:|data\s*:\s*text|@import|url\(\s*['"]?\s*(?!#)/i;
const HREF = /(?:xlink:)?href\s*=\s*(["'])([\s\S]*?)\1/gi;
const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i;

export function isSafeSvg(bytes: Uint8Array): boolean {
  if (bytes.length === 0 || bytes.length > MAX_SVG_BYTES || bytes.includes(0)) return false;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  const source = text.replace(/^\uFEFF/, '').trimStart();
  if (!STRUCTURE.test(source)) return false;
  if (FORBIDDEN_ELEMENTS.test(source)) return false;
  if (FORBIDDEN_PATTERNS.test(source)) return false;
  for (const match of source.matchAll(HREF)) {
    const ref = (match[2] ?? '').trim();
    if (!(ref.startsWith('#') || SAFE_DATA_IMAGE.test(ref))) return false;
  }
  return true;
}

/** ICO files start with the reserved word 0 followed by image type 1. */
export function hasIcoSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0;
}

/** Headers that stop an SVG (opened directly) from running script or loading anything. */
export const SVG_SANDBOX_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
