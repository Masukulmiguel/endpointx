import { useState, useEffect, useCallback, useRef } from 'react';
import api, { ApiError } from '../services/api';

interface UseApiOptions {
  immediate?: boolean;
  params?: Record<string, any>;
  refreshInterval?: number;
}

interface UseApiResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export function useApi<T = unknown>(
  endpoint: string,
  options: UseApiOptions = {}
): UseApiResult<T> {
  const { immediate = true, params, refreshInterval } = options;
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const paramsKey = JSON.stringify(params ?? {});
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(immediate);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  // Background polling backs off instead of hammering the API while it is
  // answering 429; manual refetches always go through.
  const blockedUntilRef = useRef(0);

  const fetchData = useCallback(async (background = false) => {
    if (background && Date.now() < blockedUntilRef.current) return;
    if (!background) {
      setLoading(true);
      setError(null);
    }
    try {
      const currentParams = paramsRef.current;
      const query = currentParams && Object.keys(currentParams).length > 0
        ? '?' + new URLSearchParams(currentParams).toString()
        : '';
      const response = await api.request<any>(`${endpoint}${query}`);
      if (mountedRef.current) {
        blockedUntilRef.current = 0;
        setData(response?.success !== undefined && response?.data !== undefined ? response.data : response);
        setError(null);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        blockedUntilRef.current =
          Date.now() + Math.max(err.retryAfter, 15) * 1000;
      }
      // A failing background poll is a fact about the screen, not a detail to
      // swallow. The page tells the operator it is refreshing itself, and if
      // the refresh is broken they are looking at a frozen picture with a
      // promise of movement behind it. The data already on screen stays — it
      // is the last truth — but the failure is recorded so the page can say
      // what went wrong instead of claiming it is up to date.
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'An error occurred');
      }
    } finally {
      if (!background && mountedRef.current) {
        setLoading(false);
      }
    }
  }, [endpoint, paramsKey]);

  const refetch = useCallback(() => fetchData(false), [fetchData]);

  // A response belongs to the params that produced it. When those params
  // change — another job detail, another page of a paged list — the previous
  // data must not be shown under the new heading: it is a different set, and
  // its total describes a different query. Clear it while the new request is
  // in flight, so the page shows a loading state instead of stale rows.
  const lastParamsKeyRef = useRef(paramsKey);
  useEffect(() => {
    if (lastParamsKeyRef.current !== paramsKey) {
      lastParamsKeyRef.current = paramsKey;
      setData(null);
    }
  }, [paramsKey]);

  useEffect(() => {
    mountedRef.current = true;
    if (immediate) {
      fetchData();
    }
    return () => {
      mountedRef.current = false;
    };
  }, [fetchData, immediate]);

  useEffect(() => {
    if (!refreshInterval || refreshInterval <= 0) return;
    const id = setInterval(() => {
      // Background tabs skip the request entirely: polling a hidden page
      // spends the server's outbound bandwidth budget on data nobody sees.
      if (!document.hidden) {
        fetchData(true);
      }
    }, refreshInterval);
    // Fetch immediately when the tab comes back so data is not stale.
    const onVisibility = () => {
      if (!document.hidden) {
        fetchData(true);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [fetchData, refreshInterval]);

  return { data, loading, error, refetch: fetchData };
}

export function useApiMutation<TData = unknown, TPayload = unknown>(
  defaultEndpoint: string,
  method: 'POST' | 'PUT' | 'DELETE' = 'POST'
) {
  const [data, setData] = useState<TData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutate = useCallback(
    async (endpointOrPayload?: string | TPayload, payload?: TPayload): Promise<TData | null> => {
      let endpoint = defaultEndpoint;
      let body: TPayload | undefined;

      if (typeof endpointOrPayload === 'string') {
        endpoint = endpointOrPayload;
        body = payload;
      } else {
        body = endpointOrPayload;
      }

      setLoading(true);
      setError(null);
      try {
        const options: RequestInit = {
          method,
          body: body ? JSON.stringify(body) : undefined,
        };
        const response = await api.request<any>(endpoint, options);
        const unwrapped = response?.success !== undefined && response?.data !== undefined ? response.data : response;
        setData(unwrapped);
        return unwrapped;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'An error occurred';
        setError(message);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [defaultEndpoint, method]
  );

  const reset = useCallback(() => {
    setData(null);
    setError(null);
    setLoading(false);
  }, []);

  return { data, loading, error, mutate, reset };
}

export default useApi;
