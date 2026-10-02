/**
 * A fake explorer API behind `fetch`. Routes map a path (relative to /api/v2,
 * query string excluded) to a handler returning a JSON body, an
 * ExplorerReply for a specific status/body, or throwing to simulate a network
 * failure. Unrouted paths answer 404.
 */
export class ExplorerReply {
  constructor(
    readonly status: number,
    readonly body: string = '',
    readonly headers: Record<string, string> = {},
  ) {}
}

export type ExplorerRoute = (query: URLSearchParams) => unknown;
export type ExplorerRoutes = Record<string, ExplorerRoute>;

export function mockExplorer(routes: ExplorerRoutes) {
  const calls: { path: string; query: string }[] = [];
  const fetchFn = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v2/, '');
    calls.push({ path, query: url.search });
    const route = routes[path];
    if (!route) return new Response('{"message":"Not found"}', { status: 404 });
    const result = await route(url.searchParams);
    if (result === HANG) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')));
      });
    }
    if (result instanceof ExplorerReply) {
      return new Response(result.body, { status: result.status, headers: result.headers });
    }
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return {
    fetchFn: fetchFn as typeof fetch,
    calls,
    count: (path: string) => calls.filter((c) => c.path === path).length,
  };
}

export const HANG = Symbol('hang');
