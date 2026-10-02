import type { z } from 'zod';
import type { Config } from '../config.js';
import { redactUrl } from '../config.js';
import { ToolError } from '../errors.js';
import type { Logger } from '../logger.js';
import { parseRetryAfter, RateLimiter, realSleep, withRetry, type Sleep } from '../rpc.js';

/** Largest response body accepted. Verified contract records with source code run to ~130 KB. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** A failed HTTP exchange with the explorer, before it is turned into a ToolError. */
export class ExplorerHttpError extends Error {
  constructor(
    readonly kind: 'timeout' | 'network' | 'status',
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ExplorerHttpError';
  }
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof ExplorerHttpError)) return false;
  if (err.kind !== 'status') return true;
  const s = err.status ?? 0;
  return s === 408 || s === 429 || s >= 500;
}

function toExplorerToolError(err: unknown, path: string): ToolError {
  if (err instanceof ToolError) return err;
  if (!(err instanceof ExplorerHttpError)) {
    return new ToolError('EXPLORER_UNAVAILABLE', `Explorer request failed: ${String(err)}`, { cause: err });
  }
  const details = { path, ...(err.status === undefined ? {} : { status: err.status }) };
  if (err.kind === 'timeout' || err.kind === 'network' || (err.status ?? 0) >= 500 || err.status === 408) {
    return new ToolError('EXPLORER_UNAVAILABLE', `The explorer API is unavailable: ${err.message}`, {
      hint: 'Retry later. The RPC tools (get_balance, get_transaction, read_contract, ...) do not depend on the explorer.',
      details,
      cause: err,
    });
  }
  if (err.status === 429) {
    return new ToolError('RATE_LIMITED', 'The explorer API is rate limiting requests (HTTP 429).', {
      hint: 'Wait a few seconds and retry, or lower EXPLORER_RATE_LIMIT_RPS.',
      details: { ...details, source: 'explorer' },
      cause: err,
    });
  }
  if (err.status === 404) {
    return new ToolError('NOT_FOUND', `The explorer has no record for ${path}.`, {
      hint: 'The address may be a plain account rather than a contract, may not be indexed yet, or may be on another network.',
      details,
      cause: err,
    });
  }
  return new ToolError('EXPLORER_ERROR', `The explorer API rejected the request (HTTP ${err.status}).`, {
    details,
    cause: err,
  });
}

export interface ExplorerClientOptions {
  logger?: Logger;
  fetchFn?: typeof fetch;
  sleep?: Sleep;
  limiter?: RateLimiter;
}

/**
 * Minimal client for the explorer's Blockscout-style /api/v2 JSON API.
 * Every response is validated against a schema of the fields this server
 * uses; a mismatch means the undocumented API changed and becomes
 * EXPLORER_RESPONSE_INVALID rather than bad data.
 */
export class ExplorerClient {
  readonly origin: string;
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly limiter: RateLimiter;
  private readonly sleep: Sleep;

  constructor(
    baseUrl: string,
    private readonly config: Pick<Config, 'explorerTimeoutMs' | 'explorerRetryCount' | 'explorerRateLimitRps'>,
    private readonly options: ExplorerClientOptions = {},
  ) {
    this.base = baseUrl.replace(/\/+$/, '');
    this.origin = redactUrl(baseUrl);
    this.fetchFn = options.fetchFn ?? fetch;
    this.limiter = options.limiter ?? new RateLimiter(config.explorerRateLimitRps);
    this.sleep = options.sleep ?? realSleep;
  }

  /**
   * GETs `path` (relative to the API base, e.g. "/addresses/0x…") and
   * validates the JSON body with `schema`.
   */
  async get<S extends z.ZodType>(
    path: string,
    schema: S,
    query: Record<string, string | number | boolean | null> = {},
  ): Promise<z.infer<S>> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(query)) if (v !== null) url.searchParams.set(k, String(v));

    let body: unknown;
    try {
      body = await withRetry(() => this.fetchJson(url), {
        retries: this.config.explorerRetryCount,
        baseDelayMs: 500,
        isRetryable,
        sleep: this.sleep,
        retryAfterMs: (err) => (err instanceof ExplorerHttpError ? err.retryAfterMs : undefined),
        onRetry: ({ attempt, delayMs, error }) =>
          this.options.logger?.warn(`Explorer ${path} failed (${String(error)}); retry ${attempt} in ${delayMs} ms`),
      });
    } catch (err) {
      throw toExplorerToolError(err, path);
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new ToolError('EXPLORER_RESPONSE_INVALID', `The explorer returned an unexpected response for ${path}.`, {
        hint: 'The undocumented explorer API may have changed. The RPC tools are unaffected.',
        details: { path, issues },
      });
    }
    return parsed.data;
  }

  private async fetchJson(url: URL): Promise<unknown> {
    await this.limiter.acquire();
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.config.explorerTimeoutMs),
      });
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new ExplorerHttpError('timeout', `no response within ${this.config.explorerTimeoutMs} ms`);
      }
      throw new ExplorerHttpError('network', err instanceof Error ? err.message : String(err));
    }

    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new ExplorerHttpError(
        'status',
        `HTTP ${res.status}`,
        res.status,
        parseRetryAfter(res.headers.get('retry-after')),
      );
    }

    const declared = Number(res.headers.get('content-length') ?? NaN);
    if (declared > MAX_BODY_BYTES) {
      await res.body?.cancel().catch(() => {});
      throw new ToolError('EXPLORER_RESPONSE_INVALID', `Explorer response too large (${declared} bytes).`);
    }
    const text = await res.text();
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
      throw new ToolError('EXPLORER_RESPONSE_INVALID', 'Explorer response too large.');
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new ToolError('EXPLORER_RESPONSE_INVALID', 'The explorer returned a body that is not JSON.', {
        hint: 'The undocumented explorer API may have changed, or EXPLORER_API_URL may not point at its /api/v2 base.',
        details: { path: url.pathname },
      });
    }
  }
}
