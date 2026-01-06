export default function AdminLayout({ children }: { children: any }) {
  return (
    <div style={{ border: "2px solid #2563eb", padding: "1rem", borderRadius: "8px" }}>
      <h2 style={{ color: "#2563eb", marginBottom: "1rem" }}>🔐 Admin Area</h2>
      {children}
    </div>
  );
}
