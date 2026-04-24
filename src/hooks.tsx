declare const __VELO_STATIC__: boolean;
declare const __VELO_BUILD_HASH__: string;

import {
    signal,
    useSignal,
    type Signal,
} from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import {
    useParams as wouterUseParams,
    useLocation as wouterUseLocation,
} from "wouter-preact";
import type { EventStream } from "./events.js";
import type { SocketHandler, SocketStub } from "./sockets.js";

// Flag: true when a newer build has been deployed
export const __veloUpdatePending = signal(false);

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
        loading.value = true;

        // Static mode: fetch pre-generated JSON file
        // Dynamic mode: fetch from server with _data query param
        const isStatic = typeof __VELO_STATIC__ !== "undefined" && __VELO_STATIC__;
        const dataUrl = isStatic
            ? `${currentPath === "/" ? "" : currentPath}/index.json`
            : (() => {
                const searchParams = new URLSearchParams(window.location.search);
                searchParams.set("_data", "1");
                return `${currentPath}?${searchParams.toString()}`;
            })();

        fetch(dataUrl, { cache: "no-cache" })
            .then((res) => res.json())
            .then((json: Record<string, unknown>) => {
                // Detect newer deploy by comparing build hashes
                if (
                    typeof __VELO_BUILD_HASH__ !== "undefined" &&
                    json.__buildHash &&
                    json.__buildHash !== __VELO_BUILD_HASH__
                ) {
                    __veloUpdatePending.value = true;
                }

                data.value = json[moduleId] as T;
                loading.value = false;
            })
            .catch(() => {
                loading.value = false;
            });
    };

    // Skip fetch on first render if hydrated from __PAGE_DATA__
    // On subsequent dep changes (SPA navigation), always fetch
    const isHydrated = useRef(initialData !== null);
    useEffect(() => {
        if (isHydrated.current) {
            isHydrated.current = false;
            return;
        }
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

/**
 * Subscribes to a server event stream (SSE) created with createEventStream.
 *
 * Returns:
 * - `data`: Signal with the latest event received (null until first event)
 * - `snapshot`: Signal with the initial snapshot if the server provided one
 * - `closed`: Signal that becomes true when the stream is closed by the server
 * - `error`: Signal with the connection error, if any
 *
 * Usage:
 * ```tsx
 * // Per-page stream (stream_* convention)
 * const { data, snapshot } = useEventStream(stream_progress, { channel: deployId });
 *
 * // Standalone stream (no channel)
 * const { data } = useEventStream(metricsStream);
 * ```
 *
 * The connection closes automatically when the component unmounts or when
 * the channel changes (re-opens with new channel).
 */
export function useEventStream<TEvent, TSnapshot = TEvent>(
    stream: EventStream<TEvent, TSnapshot>,
    options: { channel?: string; enabled?: boolean } = {}
): {
    data: Signal<TEvent | null>;
    snapshot: Signal<TSnapshot | null>;
    closed: Signal<boolean>;
    error: Signal<Error | null>;
} {
    const data = useSignal<TEvent | null>(null);
    const snapshot = useSignal<TSnapshot | null>(null);
    const closed = useSignal(false);
    const error = useSignal<Error | null>(null);

    const { channel, enabled = true } = options;

    useEffect(() => {
        if (typeof window === "undefined") return;
        if (!enabled) return;
        if (!stream.__path) {
            console.warn("[velojs] useEventStream: stream has no __path");
            return;
        }

        // Reset signals when channel changes
        data.value = null;
        snapshot.value = null;
        closed.value = false;
        error.value = null;

        const url = channel
            ? `${stream.__path}?channel=${encodeURIComponent(channel)}`
            : stream.__path;

        const es = new EventSource(url);

        es.addEventListener("snapshot", (e) => {
            try {
                snapshot.value = JSON.parse((e as MessageEvent).data) as TSnapshot;
            } catch (err) {
                error.value = err as Error;
            }
        });

        es.addEventListener("message", (e) => {
            try {
                data.value = JSON.parse(e.data) as TEvent;
            } catch (err) {
                error.value = err as Error;
            }
        });

        // Heartbeats are no-op on the client — they just keep the connection alive
        es.addEventListener("heartbeat", () => {});

        // Server signaled an explicit close (via stream.close(channel))
        es.addEventListener("close", () => {
            closed.value = true;
            es.close();
        });

        es.addEventListener("error", () => {
            // EventSource auto-reconnects on errors. If readyState becomes CLOSED,
            // the server closed the stream intentionally.
            if (es.readyState === EventSource.CLOSED) {
                closed.value = true;
            }
        });

        return () => {
            es.close();
        };
    }, [stream, channel, enabled]);

    return { data, snapshot, closed, error };
}

// ============================================
// useSocket — WebSocket hook
// ============================================

type SocketStatus = "connecting" | "open" | "closed";

export interface UseSocketOptions {
    /** Optional channel; appended as `?channel=...` to the socket URL. */
    channel?: string;
    /** Called for every incoming message (text frame = string, binary frame = `Uint8Array`). */
    onMessage?: (msg: string | Uint8Array) => void;
    /** Called on successful connection. */
    onOpen?: () => void;
    /** Called on close (client or server). */
    onClose?: (evt: CloseEvent) => void;
    /** Called on socket error. */
    onError?: (err: Event) => void;
    /** When false, the connection is not opened. Flip to true to connect later. Default: true. */
    enabled?: boolean;
}

export interface UseSocketApi {
    /**
     * Send a message. Strings and `Uint8Array` are sent as-is;
     * objects are auto-serialized with `JSON.stringify`.
     *
     * Buffered if called before the socket is open — dropped once closed.
     */
    send: (msg: string | Uint8Array | object) => void;
    /** Close the socket (client-initiated). */
    close: (code?: number, reason?: string) => void;
    /** `"connecting" | "open" | "closed"`. Reactive. */
    status: Signal<SocketStatus>;
    /** Last received message. Reactive. */
    lastMessage: Signal<string | Uint8Array | null>;
    /** Last socket error, if any. Reactive. */
    error: Signal<Event | null>;
}

/**
 * Subscribes to a WebSocket declared via the `socket_*` convention.
 *
 * The hook opens the connection on mount (when `enabled !== false`) and closes
 * it on unmount or when `channel` / `stub` / `enabled` change.
 *
 * **No auto-reconnect.** If the server closes the socket, `status.value`
 * becomes `"closed"` and stays that way — user flow decides whether to
 * reconnect (typically by re-mounting or toggling `enabled`).
 *
 * ```tsx
 * const { send, status, lastMessage } = useSocket(socket_terminal, {
 *     channel: workerId,
 *     onMessage: (msg) => { ... },
 * });
 *
 * send({ type: "resize", cols: 80, rows: 24 });
 * ```
 */
export function useSocket(
    stub: SocketHandler | SocketStub | { __path: string },
    options: UseSocketOptions = {}
): UseSocketApi {
    const status = useSignal<SocketStatus>("connecting");
    const lastMessage = useSignal<string | Uint8Array | null>(null);
    const error = useSignal<Event | null>(null);

    const wsRef = useRef<WebSocket | null>(null);
    const pendingRef = useRef<(string | ArrayBufferLike | Uint8Array)[]>([]);

    const { channel, onMessage, onOpen, onClose, onError, enabled = true } = options;

    useEffect(() => {
        if (typeof window === "undefined") return;
        if (!enabled) return;
        if (!stub.__path) {
            console.warn("[velojs] useSocket: stub has no __path");
            return;
        }

        // Reset state for a fresh connection
        status.value = "connecting";
        lastMessage.value = null;
        error.value = null;

        // Build ws:// or wss:// URL relative to origin
        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const base = `${proto}//${window.location.host}`;
        const url = channel
            ? `${base}${stub.__path}?channel=${encodeURIComponent(channel)}`
            : `${base}${stub.__path}`;

        const ws = new WebSocket(url);
        ws.binaryType = "arraybuffer";
        wsRef.current = ws;

        ws.addEventListener("open", () => {
            status.value = "open";
            // Flush anything queued while connecting
            const pending = pendingRef.current;
            pendingRef.current = [];
            for (const msg of pending) {
                try { ws.send(msg as any); } catch {}
            }
            onOpen?.();
        });

        ws.addEventListener("message", (evt) => {
            let msg: string | Uint8Array;
            if (typeof evt.data === "string") {
                msg = evt.data;
            } else if (evt.data instanceof ArrayBuffer) {
                msg = new Uint8Array(evt.data);
            } else {
                // Blob or other — skip (we configured binaryType=arraybuffer so this shouldn't hit)
                return;
            }
            lastMessage.value = msg;
            onMessage?.(msg);
        });

        ws.addEventListener("close", (evt) => {
            status.value = "closed";
            wsRef.current = null;
            onClose?.(evt);
        });

        ws.addEventListener("error", (evt) => {
            error.value = evt;
            onError?.(evt);
        });

        return () => {
            wsRef.current = null;
            try {
                if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                    ws.close();
                }
            } catch {}
        };
    }, [stub.__path, channel, enabled]);

    const send: UseSocketApi["send"] = (msg) => {
        let payload: string | ArrayBufferLike | Uint8Array;
        if (typeof msg === "string" || msg instanceof Uint8Array) {
            payload = msg;
        } else {
            payload = JSON.stringify(msg);
        }

        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
            try { ws.send(payload as any); } catch {}
        } else if (ws && ws.readyState === WebSocket.CONNECTING) {
            // Queue until open
            pendingRef.current.push(payload);
        }
        // Otherwise dropped (closed)
    };

    const close: UseSocketApi["close"] = (code, reason) => {
        const ws = wsRef.current;
        if (!ws) return;
        try { ws.close(code, reason); } catch {}
    };

    return { send, close, status, lastMessage, error };
}
