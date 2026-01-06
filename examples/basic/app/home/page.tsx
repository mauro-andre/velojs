import { useLoaderData } from "velojs/hooks";

export async function loader() {
  return {
    message: "Welcome to VeloJS!",
    features: [
      "File-based routing",
      "Server Actions",
      "SSR + Hydration",
      "Preact Signals",
      "Type-safe",
      "Zero config",
    ],
    timestamp: new Date().toISOString(),
  };
}

export default function HomePage() {
  const { value: data, loading } = useLoaderData<typeof loader>();

  if (loading.value) {
    return <p>Loading...</p>;
  }

  return (
    <div>
      <h2>{data.value?.message}</h2>
      <p style={{ color: "#6b7280", marginBottom: "1rem" }}>
        Loaded at: {data.value?.timestamp}
      </p>
      
      <h3>Features:</h3>
      <ul>
        {data.value?.features.map((feature, i) => (
          <li key={i}>✅ {feature}</li>
        ))}
      </ul>

      <p style={{ marginTop: "2rem" }}>
        Navigate to <a href="/admin/users">Users (Admin)</a> to see Server Actions in action!
      </p>
    </div>
  );
}
