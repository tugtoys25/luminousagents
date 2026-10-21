/** File validation for authority evidence. Mirrors the data-room upload rules; the signature check does not prove a file is safe. */
export const EVIDENCE_MAX_BYTES = 20 * 1024 * 1024;
export const EVIDENCE_MAX_PER_RECORD = 10;
export const EVIDENCE_TYPES_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function hasExpectedSignature(contentType: string, bytes: Uint8Array): boolean {
  const starts = (...sig: number[]) => sig.every((v, i) => bytes[i] === v);
  if (contentType === 'application/pdf') return bytes.length >= 5 && new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-';
  if (contentType === 'image/jpeg') return starts(0xff, 0xd8, 0xff);
  if (contentType === 'image/png') return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  // DOCX and XLSX are ZIP containers; this checks the container signature only.
  return starts(0x50, 0x4b, 0x03, 0x04) || starts(0x50, 0x4b, 0x05, 0x06) || starts(0x50, 0x4b, 0x07, 0x08);
}

export const extensionOf = (name: string): string => (name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '');

/** The declared type must agree with the extension, both must be allowed, and the bytes must carry the matching signature. */
export function validateEvidenceFile(name: string, declaredType: string, bytes: Uint8Array): { ok: true; contentType: string; extension: string } | { ok: false; message: string } {
  const extension = extensionOf(name);
  const contentType = EVIDENCE_TYPES_BY_EXTENSION[extension];
  if (!contentType) return { ok: false, message: 'Allowed types: PDF, JPEG, PNG, DOCX, XLSX.' };
  if (declaredType && declaredType !== contentType) return { ok: false, message: 'The file type does not match its extension.' };
  if (bytes.byteLength === 0 || bytes.byteLength > EVIDENCE_MAX_BYTES) return { ok: false, message: 'Files must be between 1 byte and 20 MB.' };
  if (!hasExpectedSignature(contentType, bytes)) return { ok: false, message: 'The file contents do not match its type.' };
  return { ok: true, contentType, extension };
}

/** Display name only: strips paths and control characters. It is never used as a storage key. */
// eslint-disable-next-line no-control-regex
export const safeFilename = (name: string): string => (name.split(/[\\/]/).pop() ?? 'file').replace(/[\u0000-\u001f\u007f"<>:|?*]+/g, '_').trim().slice(0, 120) || 'file';

export const evidenceKey = (recordId: string, objectId: string, extension: string): string => `seller-evidence/${recordId}/${objectId}.${extension}`;

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
