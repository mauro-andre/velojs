import { signal } from "@preact/signals";

/**
 * Hook para executar Server Actions
 *
 * Faz POST para /api/{currentPath}/{actionName}
 * Retorna função executora e signal de loading
 *
 * @param action - Função server action (será chamada via API)
 * @returns [executora, loading signal]
 *
 * @example
 * ```tsx
 * export async function action_createUser(name: string, email: string) {
 *   // ... implementação server-side
 * }
 *
 * export default function Page() {
 *   const [create, creating] = useAction(action_createUser);
 *
 *   const handleCreate = async () => {
 *     const result = await create("John", "john@example.com");
 *     console.log(result);
 *   };
 *
 *   return (
 *     <button onClick={handleCreate} disabled={creating.value}>
 *       {creating.value ? "Creating..." : "Create"}
 *     </button>
 *   );
 * }
 * ```
 */
export function useAction<T extends (...args: any) => any>(
  action: T
): [
  (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>>,
  { value: boolean; error: Error | null }
] {
  const loading = signal(false);
  const error = signal<Error | null>(null);

  const execute = async (
    ...args: Parameters<T>
  ): Promise<Awaited<ReturnType<T>>> => {
    loading.value = true;
    error.value = null;

    try {
      // Extrai nome da action
      const actionName = action.name;

      if (!actionName.startsWith("action_")) {
        throw new Error(
          `[VeloJS] Invalid action name: ${actionName}. Server actions must start with "action_"`
        );
      }

      // Monta URL da API
      // /admin/users → /api/admin/users/action_createUser
      const currentPath = window.location.pathname;
      const apiPath = `/api${currentPath}/${actionName}`;

      // Faz POST com argumentos
      const response = await fetch(apiPath, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ args }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.message ||
            `HTTP ${response.status}: ${response.statusText}`
        );
      }

      const result = await response.json();
      return result as Awaited<ReturnType<T>>;
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err));
      throw err;
    } finally {
      loading.value = false;
    }
  };

  return [execute, { value: loading.value, error: error.value }];
}
