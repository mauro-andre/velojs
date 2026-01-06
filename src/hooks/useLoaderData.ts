import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";

/**
 * Cache global de dados de loader
 * Key: pathname
 * Value: dados do loader
 */
const loaderCache = new Map<string, any>();

/**
 * Hook para acessar dados do loader
 *
 * Funciona em dois modos:
 * 1. SSR (primeira carga): Lê de window.__PAGE_DATA__
 * 2. SPA (navegação): Faz fetch ?_data=1
 *
 * @example
 * ```tsx
 * export async function loader() {
 *   return { users: [...] };
 * }
 *
 * export default function Page() {
 *   const { value: data, loading } = useLoaderData<typeof loader>();
 *
 *   if (loading.value) return <p>Loading...</p>;
 *   return <div>{data.value?.users.map(...)}</div>;
 * }
 * ```
 */
export function useLoaderData<T extends (...args: any) => any>() {
  // Inicializa com dados do SSR se disponível (executa antes do useEffect)
  const initialData =
    typeof window !== "undefined" && (window as any).__PAGE_DATA__
      ? (window as any).__PAGE_DATA__.page
      : null;

  const data = signal<Awaited<ReturnType<T>> | null>(initialData);
  const loading = signal(false);
  const error = signal<Error | null>(null);

  useEffect(() => {
    const currentPath = window.location.pathname;

    // Prioridade 1: window.__PAGE_DATA__ (SSR ou navegação inicial)
    if ((window as any).__PAGE_DATA__) {
      data.value = (window as any).__PAGE_DATA__.page;
      loaderCache.set(currentPath, (window as any).__PAGE_DATA__.page);
      delete (window as any).__PAGE_DATA__;
      return;
    }

    // Prioridade 2: Cache (navegação de volta)
    if (loaderCache.has(currentPath)) {
      data.value = loaderCache.get(currentPath);
      return;
    }

    // Prioridade 3: Fetch (primeira navegação SPA)
    loading.value = true;
    error.value = null;

    fetch(currentPath + "?_data=1")
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return response.json();
      })
      .then((result) => {
        data.value = result.page;
        loaderCache.set(currentPath, result.page);
        loading.value = false;
      })
      .catch((err) => {
        error.value = err;
        loading.value = false;
        console.error("[VeloJS] Error loading data:", err);
      });
  }, []);

  return { value: data, loading, error };
}

/**
 * Revalida dados do loader (força novo fetch)
 *
 * @param path - Path para revalidar (default: pathname atual)
 *
 * @example
 * ```tsx
 * const [create] = useAction(action_createUser);
 *
 * const handleCreate = async () => {
 *   await create("John", "john@example.com");
 *   revalidate(); // ← Recarrega dados
 * };
 * ```
 */
export function revalidate(path?: string): void {
  const targetPath = path || window.location.pathname;

  // 1. Limpa cache
  loaderCache.delete(targetPath);

  // 2. Dispara evento customizado para hooks reagirem
  window.dispatchEvent(
    new CustomEvent("velojs:revalidate", {
      detail: { path: targetPath },
    })
  );

  // 3. Se for o path atual, força reload
  if (targetPath === window.location.pathname) {
    window.location.reload();
  }
}

/**
 * Limpa todo o cache de loader data
 */
export function clearLoaderCache(): void {
  loaderCache.clear();
}
