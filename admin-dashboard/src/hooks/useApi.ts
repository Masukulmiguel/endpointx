import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../services/api';

interface UseApiOptions {
  immediate?: boolean;
  params?: Record<string, any>;
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
  const { immediate = true, params } = options;
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const paramsKey = JSON.stringify(params ?? {});
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(immediate);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const currentParams = paramsRef.current;
      const query = currentParams && Object.keys(currentParams).length > 0
        ? '?' + new URLSearchParams(currentParams).toString()
        : '';
      const response = await api.request<any>(`${endpoint}${query}`);
      if (mountedRef.current) {
        setData(response?.success !== undefined && response?.data !== undefined ? response.data : response);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'An error occurred');
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [endpoint, paramsKey]);

  useEffect(() => {
    mountedRef.current = true;
    if (immediate) {
      fetchData();
    }
    return () => {
      mountedRef.current = false;
    };
  }, [fetchData, immediate]);

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
