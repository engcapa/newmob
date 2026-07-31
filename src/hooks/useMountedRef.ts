import { useEffect, useRef, type MutableRefObject } from "react";

/**
 * A ref that is `true` while the component is mounted, for guarding `setState`
 * (and other post-await work) in async callbacks.
 *
 * Why a hook instead of the two-line inline version: the obvious spelling
 *
 * ```ts
 * const mountedRef = useRef(true);
 * useEffect(() => () => { mountedRef.current = false; }, []);
 * ```
 *
 * is broken under `React.StrictMode`, which in development runs
 * mount → effects → **cleanups** → effects again. The cleanup fires once during
 * that double-invoke and nothing sets the ref back to `true`, so it stays
 * `false` for the component's whole life and every `if (!mountedRef.current)
 * return` becomes a silent no-op — features that guard async steps this way then
 * do nothing at all, in dev builds only, with no error to go on. Re-arming on
 * mount (below) is what makes the guard correct.
 */
export function useMountedRef(): MutableRefObject<boolean> {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return mountedRef;
}
