import { QueryClient, useQuery } from '@tanstack/react-query';
export const queryClient = new QueryClient({ defaultOptions: { queries: { retry: (count, e) => e.status !== 401 && e.status !== 403 && count < 1, staleTime: 10000, refetchInterval: 30000 }, mutations: { retry: false } } });
let csrf = '';
export const setCsrf = value => { csrf = value || ''; };
export async function api(path, body, key = crypto.randomUUID()) {
  const response = await fetch(`/api/v1${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', ...(body === undefined ? {} : { 'X-CSRF-Token': csrf, 'Idempotency-Key': key }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json().catch(() => ({ error: { message: 'The server returned an unreadable response.' } }));
  if (!response.ok) { const e = new Error(result.error?.message || 'Request failed. Please try again.'); e.status = response.status; e.code = result.error?.code; if (e.status === 401 && !path.includes('/auth/')) window.dispatchEvent(new Event('session-expired')); throw e; }
  return result;
}
export function useData(key, path, enabled = true) { return useQuery({ queryKey: key, queryFn: () => api(path), enabled, refetchInterval: /^\/(simulation\/runs|forecast-runs)\//.test(path) ? 2000 : 30000 }); }
export function refresh() { return queryClient.invalidateQueries({ predicate: q => q.queryKey[0] !== 'me' }); }
export async function allProducts() {
  const rows = []; let cursor;
  do { const page = await api(`/products?limit=100${cursor ? `&cursor=${cursor}` : ''}`); rows.push(...page.data); cursor = page.nextCursor; } while (cursor && rows.length < 10000);
  return rows;
}
