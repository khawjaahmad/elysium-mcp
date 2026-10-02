import { ToolError } from '../errors.js';

/**
 * The explorer paginates with a `next_page_params` object that must be sent
 * back as query parameters. It is handed to agents as an opaque cursor,
 * bound to the listing it came from.
 */
type Params = Record<string, string | number | boolean | null>;

const MAX_CURSOR_LENGTH = 2048;

export function encodeCursor(path: string, params: Params | null | undefined): string | null {
  if (!params) return null;
  return Buffer.from(JSON.stringify({ p: path, q: params }), 'utf8').toString('base64url');
}

function invalid(reason: string): ToolError {
  return new ToolError('INVALID_INPUT', `cursor is not valid: ${reason}.`, {
    hint: 'Pass back nextCursor exactly as returned by the same tool and arguments, or omit it for the first page.',
  });
}

/** Decodes a cursor issued by encodeCursor for the same `path`. */
export function decodeCursor(cursor: string, path: string): Params {
  if (cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid('malformed');
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid('malformed');
  }
  if (typeof decoded !== 'object' || decoded === null) throw invalid('malformed');
  const { p, q } = decoded as { p?: unknown; q?: unknown };
  if (p !== path) throw invalid('it belongs to a different listing');
  if (typeof q !== 'object' || q === null || Array.isArray(q)) throw invalid('malformed');
  const entries = Object.entries(q as Record<string, unknown>);
  if (entries.length > 16) throw invalid('malformed');
  for (const [k, v] of entries) {
    if (!/^[a-z_]{1,40}$/.test(k)) throw invalid('malformed');
    const ok =
      v === null ||
      typeof v === 'boolean' ||
      (typeof v === 'number' && Number.isFinite(v)) ||
      (typeof v === 'string' && v.length <= 200);
    if (!ok) throw invalid('malformed');
  }
  return q as Params;
}
