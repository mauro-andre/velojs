import { useLoaderData, useAction, revalidate } from "velojs/hooks";
import { signal } from "@preact/signals";

// Simula banco de dados em memória
const usersDB = [
  { id: 1, name: "John Doe", email: "john@example.com" },
  { id: 2, name: "Jane Smith", email: "jane@example.com" },
  { id: 3, name: "Bob Johnson", email: "bob@example.com" },
];

export async function loader() {
  // Simula delay de rede
  await new Promise(resolve => setTimeout(resolve, 300));
  
  return {
    users: usersDB,
    total: usersDB.length,
  };
}

export async function action_createUser(name: string, email: string) {
  // Simula validação
  if (!name || !email) {
    throw new Error("Name and email are required");
  }

  // Simula delay de rede
  await new Promise(resolve => setTimeout(resolve, 500));

  const newUser = {
    id: Date.now(),
    name,
    email,
  };

  usersDB.push(newUser);

  return { success: true, user: newUser };
}

export async function action_deleteUser(id: number) {
  // Simula delay de rede
  await new Promise(resolve => setTimeout(resolve, 300));

  const index = usersDB.findIndex(u => u.id === id);
  
  if (index === -1) {
    throw new Error("User not found");
  }

  usersDB.splice(index, 1);

  return { success: true };
}

export default function UsersPage() {
  const { value: data, loading, error } = useLoaderData<typeof loader>();
  const [createUser, creating] = useAction(action_createUser);
  const [deleteUser, deleting] = useAction(action_deleteUser);

  // Form state
  const nameInput = signal("");
  const emailInput = signal("");
  const formError = signal<string | null>(null);

  const handleCreate = async (e: Event) => {
    e.preventDefault();
    formError.value = null;

    try {
      await createUser(nameInput.value, emailInput.value);
      
      // Reset form
      nameInput.value = "";
      emailInput.value = "";
      
      // Reload data
      revalidate();
    } catch (err) {
      formError.value = err instanceof Error ? err.message : "Failed to create user";
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Are you sure?")) return;

    try {
      await deleteUser(id);
      revalidate();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete user");
    }
  };

  if (loading.value) {
    return <p>Loading users...</p>;
  }

  if (error.value) {
    return <p style={{ color: "red" }}>Error: {error.value.message}</p>;
  }

  return (
    <div>
      <h3>Users Management ({data.value?.total} total)</h3>

      {/* Create Form */}
      <form onSubmit={handleCreate} style={{ margin: "1rem 0", padding: "1rem", background: "#f3f4f6", borderRadius: "4px" }}>
        <h4>Add New User</h4>
        {formError.value && (
          <p style={{ color: "red", margin: "0.5rem 0" }}>{formError.value}</p>
        )}
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
          <input
            type="text"
            placeholder="Name"
            value={nameInput.value}
            onInput={(e) => nameInput.value = (e.target as HTMLInputElement).value}
            style={{ flex: 1, padding: "0.5rem", border: "1px solid #d1d5db", borderRadius: "4px" }}
            disabled={creating.value}
          />
          <input
            type="email"
            placeholder="Email"
            value={emailInput.value}
            onInput={(e) => emailInput.value = (e.target as HTMLInputElement).value}
            style={{ flex: 1, padding: "0.5rem", border: "1px solid #d1d5db", borderRadius: "4px" }}
            disabled={creating.value}
          />
          <button type="submit" disabled={creating.value}>
            {creating.value ? "Creating..." : "Add User"}
          </button>
        </div>
      </form>

      {/* Users List */}
      <ul>
        {data.value?.users.map(user => (
          <li key={user.id}>
            <div>
              <strong>{user.name}</strong>
              <br />
              <small style={{ color: "#6b7280" }}>{user.email}</small>
            </div>
            <button 
              onClick={() => handleDelete(user.id)}
              disabled={deleting.value}
              style={{ background: "#dc2626" }}
            >
              {deleting.value ? "..." : "Delete"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
