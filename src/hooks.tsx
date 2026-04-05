import {
    signal,
    useSignal,
    type Signal,
} from "@preact/signals";
import { useEffect } from "preact/hooks";
import {
    useParams as wouterUseParams,
    useLocation as wouterUseLocation,
} from "wouter-preact";

/**
 * Força o signal a notificar mudanças após mutação de propriedades aninhadas
 *
 * Uso:
 * ```tsx
 * word.isChecked = !word.isChecked;  // muta
 * touch(pathAppliedData);             // notifica
 * ```
 */
export function touch<T>(sig: Signal<T | null>): void {
    if (sig.value !== null && typeof sig.value === "object") {
        sig.value = { ...sig.value } as T;
    }
}

/**
 * Hidrata dados do loader fora de componentes (SSR only)
 * Apenas lê do __PAGE_DATA__, nunca faz fetch
 *
 * Use para dados globais/compartilhados carregados no Layout.
 * Para dados de página com suporte a navegação SPA, use useLoader() dentro do Component.
 *
 * Uso:
 * ```tsx
 * // No Layout - carrega dados globais
 * export const { data: globalData } = Loader<GlobalType>();
 *
 * // No componente do Layout
 * export const Component = ({ children }) => <div>{globalData.value?.name}{children}</div>;
 *
 * // Em outros módulos - importa o dado do Layout
 * import { globalData } from "./Layout.js";
 * ```
 *
 * @param moduleId - Injetado automaticamente pelo veloPlugin
 */
export function Loader<T>(moduleId?: string): {
    data: Signal<T | null>;
    loading: Signal<boolean>;
} {
    const loading = signal(false);

    // Servidor: getter que sempre lê do AsyncLocalStorage (sem cache)
    if (typeof window === "undefined") {
        const data = {
            get value(): T | null {
                if (!moduleId) return null;
                const storage = (globalThis as any).__veloServerData;
                const serverData = storage?.getStore?.();
                return (serverData?.[moduleId] as T) ?? null;
            },
        };
        return { data: data as Signal<T | null>, loading };
    }

    // Cliente: apenas hidrata do __PAGE_DATA__, nunca faz fetch
    // (Loader roda uma única vez no import do módulo, não é responsável por SPA)
    const pageData = (window as any).__PAGE_DATA__;
    const initialData =
        moduleId && pageData?.[moduleId] ? (pageData[moduleId] as T) : null;

    return { data: signal<T | null>(initialData), loading };
}

/**
 * Hook para acessar dados do loader dentro de componentes
 * Suporta SSR hydration e navegação SPA (faz fetch se necessário)
 *
 * Uso:
 * ```tsx
 * export const Component = () => {
 *     const { data, loading } = useLoader<MyType>();
 *     return <div>{data.value?.name}</div>;
 * };
 *
 * // Com deps (ex: recarregar ao trocar de rota)
 * const params = useParams();
 * const { data } = useLoader<MyType>([params.id]);
 * ```
 *
 * @param moduleId - Injetado automaticamente pelo veloPlugin
 * @param deps - Array de dependências (triggers re-fetch quando mudam)
 */
export function useLoader<T>(): { data: Signal<T | null>; loading: Signal<boolean>; refetch: () => void };
export function useLoader<T>(deps: any[]): { data: Signal<T | null>; loading: Signal<boolean>; refetch: () => void };
export function useLoader<T>(moduleId: string, deps?: any[]): { data: Signal<T | null>; loading: Signal<boolean>; refetch: () => void };
export function useLoader<T>(
    moduleIdOrDeps?: string | any[],
    deps?: any[],
): {
    data: Signal<T | null>;
    loading: Signal<boolean>;
    refetch: () => void;
} {
    // Resolve args: usuário chama useLoader(deps), vite transforma em useLoader(moduleId, deps)
    let moduleId: string | undefined;
    let resolvedDeps: any[] | undefined;
    if (Array.isArray(moduleIdOrDeps)) {
        resolvedDeps = moduleIdOrDeps;
    } else {
        moduleId = moduleIdOrDeps;
        resolvedDeps = deps;
    }

    // Servidor: pega dados do AsyncLocalStorage (isolado por request)
    let initialData: T | null = null;

    if (typeof window === "undefined" && moduleId) {
        const storage = (globalThis as any).__veloServerData;
        const serverData = storage?.getStore?.();
        if (serverData?.[moduleId]) {
            initialData = serverData[moduleId] as T;
        }
    }

    // Cliente: tenta hidratar do __PAGE_DATA__
    if (typeof window !== "undefined" && moduleId) {
        const pageData = (window as any).__PAGE_DATA__;
        if (pageData?.[moduleId]) {
            initialData = pageData[moduleId] as T;
            delete pageData[moduleId];
        }
    }

    const data = useSignal<T | null>(initialData);
    const loading = useSignal(false);

    const fetchData = () => {
        if (typeof window === "undefined" || !moduleId) return;
        const currentPath = window.location.pathname;
        const searchParams = new URLSearchParams(window.location.search);
        searchParams.set("_data", "1");
        loading.value = true;

        fetch(`${currentPath}?${searchParams.toString()}`)
            .then((res) => res.json())
            .then((json: Record<string, unknown>) => {
                data.value = json[moduleId] as T;
                loading.value = false;
            })
            .catch((err) => {
                console.error("Erro ao carregar dados:", err);
                loading.value = false;
            });
    };

    // Se não tem dado, faz fetch (navegação SPA)
    // Na hidratação initialData !== null, então pula o fetch
    // Quando deps mudam (ex: troca de rota), initialData será null e dispara fetch
    useEffect(() => {
        if (initialData !== null) return;
        fetchData();
    }, resolvedDeps ?? []);

    return { data, loading, refetch: fetchData };
}

/**
 * Hook para navegação programática
 *
 * Uso:
 * ```tsx
 * const navigate = useNavigate();
 * navigate("/outra-pagina");
 * ```
 */
export function useNavigate() {
    const [, navigate] = wouterUseLocation();
    return navigate;
}

/**
 * Hook para acessar parâmetros da rota (funciona em SSR e cliente)
 *
 * Uso:
 * ```tsx
 * // Rota: /teste/:pathAppliedId/avaliacao/:assessmentRatingIndex
 * const params = useParams();
 * console.log(params.pathAppliedId, params.assessmentRatingIndex);
 * ```
 */
export function useParams<
    T extends Record<string, string> = Record<string, string>,
>(): T {
    // Servidor: lê do AsyncLocalStorage
    if (typeof window === "undefined") {
        const storage = (globalThis as any).__veloServerData;
        const serverData = storage?.getStore?.();
        return (serverData?.__params as T) ?? ({} as T);
    }

    // Cliente: sempre usa wouter para ter params atualizados durante navegação SPA
    return wouterUseParams() as T;
}

/**
 * Hook para acessar query string da rota (funciona em SSR e cliente)
 *
 * Uso:
 * ```tsx
 * // URL: /teste?foo=bar&baz=123
 * const query = useQuery();
 * console.log(query.foo, query.baz);
 * ```
 */
export function useQuery<
    T extends Record<string, string> = Record<string, string>,
>(): T {
    // Servidor: lê do AsyncLocalStorage
    if (typeof window === "undefined") {
        const storage = (globalThis as any).__veloServerData;
        const serverData = storage?.getStore?.();
        return (serverData?.__query as T) ?? ({} as T);
    }

    // Cliente: lê do __PAGE_DATA__ ou parse da URL
    const pageData = (window as any).__PAGE_DATA__;
    if (pageData?.__query) {
        return pageData.__query as T;
    }

    // Fallback: parse da URL atual
    const searchParams = new URLSearchParams(window.location.search);
    const query: Record<string, string> = {};
    searchParams.forEach((value, key) => {
        query[key] = value;
    });
    return query as T;
}

/**
 * Hook para acessar o pathname completo da URL (funciona em SSR e cliente)
 * Diferente do useLocation do wouter que retorna path relativo ao contexto nest,
 * este hook sempre retorna o pathname absoluto.
 *
 * Uso:
 * ```tsx
 * const pathname = usePathname();
 * // Em /admin/colaboradores sempre retorna "/admin/colaboradores"
 * // (não "/" como useLocation retornaria dentro do contexto /admin)
 * ```
 */
export function usePathname(): string {
    // Servidor: lê do AsyncLocalStorage
    if (typeof window === "undefined") {
        const storage = (globalThis as any).__veloServerData;
        const serverData = storage?.getStore?.();
        return (serverData?.__pathname as string) ?? "/";
    }

    // Cliente: usa useLocation do wouter para reatividade,
    // mas retorna window.location.pathname para o path absoluto
    wouterUseLocation(); // trigger re-render on navigation
    return window.location.pathname;
}
