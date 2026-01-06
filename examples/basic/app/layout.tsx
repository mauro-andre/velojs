export default function RootLayout({ children }: { children: any }) {
  return (
    <html lang="pt-BR">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>VeloJS - Example App</title>
        <style>{`
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: system-ui, -apple-system, sans-serif;
            line-height: 1.6;
            color: #333;
          }
          header {
            background: #2563eb;
            color: white;
            padding: 1rem 2rem;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          header h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
          nav a {
            color: white;
            text-decoration: none;
            margin-right: 1rem;
            padding: 0.25rem 0.5rem;
            border-radius: 4px;
          }
          nav a:hover { background: rgba(255,255,255,0.2); }
          main { max-width: 1200px; margin: 0 auto; padding: 2rem; }
          footer {
            background: #f3f4f6;
            padding: 1rem 2rem;
            text-align: center;
            margin-top: 4rem;
            color: #6b7280;
          }
          button {
            background: #2563eb;
            color: white;
            border: none;
            padding: 0.5rem 1rem;
            border-radius: 4px;
            cursor: pointer;
            font-size: 1rem;
          }
          button:hover { background: #1d4ed8; }
          button:disabled { background: #9ca3af; cursor: not-allowed; }
          ul { list-style: none; }
          li {
            background: white;
            padding: 1rem;
            margin: 0.5rem 0;
            border-radius: 4px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            display: flex;
            justify-content: space-between;
            align-items: center;
          }
        `}</style>
      </head>
      <body>
        <header>
          <h1>🚀 VeloJS Example App</h1>
          <nav>
            <a href="/">Home</a>
            <a href="/admin/users">Users (Admin)</a>
          </nav>
        </header>
        <main>{children}</main>
        <footer>
          <p>Built with VeloJS - Full-stack framework with Server Actions, SSR and Signals</p>
        </footer>
      </body>
    </html>
  );
}
