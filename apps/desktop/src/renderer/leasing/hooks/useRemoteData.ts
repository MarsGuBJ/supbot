import { useCallback, useEffect, useState } from "react";

export interface RemoteData<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => void;
}

export function useRemoteData<T>(loader: (signal: AbortSignal) => Promise<T>): RemoteData<T> {
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    loader(controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) {
          setData(next);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason : new Error("数据加载失败"));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [loader, revision]);

  const reload = useCallback(() => setRevision((value) => value + 1), []);
  return { data, error, loading, reload };
}
