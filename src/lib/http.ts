/** Small helpers for answering requests, so every route says things the same way. */

const API_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...API_HEADERS, ...headers } });
}

export function problem(status: number, error: string, code: string, extra: Record<string, unknown> = {}): Response {
  return json({ error, code, ...extra }, status);
}

export function tooMany(retryAfterSeconds: number): Response {
  return json(
    { error: 'Too many requests. Try again later.', code: 'rate_limited' },
    429,
    { 'Retry-After': String(retryAfterSeconds) },
  );
}

/** Thrown by readJson, and turned into an answer by the router. */
export class BodyError extends Error {
  constructor(readonly response: Response) {
    super('bad body');
  }
}

/**
 * The request body as JSON, read with a ceiling rather than trusting
 * Content-Length, which a sender can leave out or get wrong.
 */
export async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new BodyError(problem(413, 'That is more than we will read', 'body/too_large'));
  }
  const reader = request.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel();
      throw new BodyError(problem(413, 'That is more than we will read', 'body/too_large'));
    }
    chunks.push(value);
  }
  if (total === 0) return undefined;
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new BodyError(problem(400, 'That is not JSON', 'body/invalid_json'));
  }
}

/** The address the request came from. Cloudflare sets this; nobody else can. */
export function clientAddress(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}
