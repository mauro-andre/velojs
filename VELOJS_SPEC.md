# VeloJS - Framework Specification v1.0

> **Full-stack framework com Server Actions, SSR e Signals**
> _A produtividade do React Router v7 com a flexibilidade do Hono e a leveza do Preact_

---

## 📋 Resumo Executivo para Agentes IA

### Contexto do Projeto

**VeloJS** é um framework full-stack criado após tentativa de migração de Hono+Preact para React Router v7.

**Linha do tempo:**
1. **Projeto original**: `mcp-node` - App com Hono (backend) + Preact (frontend) + SSR manual
2. **Tentativa de migração**: Para React Router v7 visando produtividade
3. **Problema encontrado**: RRv7 muito opinado, modelo mental complexo vindo de micro-frameworks
4. **Decisão pivotal**: Criar framework próprio que combine o melhor dos dois mundos
5. **Resultado**: VeloJS - Convenções do RRv7 com flexibilidade do Hono

### O Que É VeloJS

Framework full-stack TypeScript que oferece:
- ✅ **File-based routing** (inspirado em RRv7)
- ✅ **Server Actions** com convenção `action_*` (inspirado em Next.js)
- ✅ **Loaders** para data fetching server-side
- ✅ **SSR automático** com hydration
- ✅ **Signals** para reatividade (Preact Signals)
- ✅ **Type-safe** com inferência automática
- ✅ **Middlewares nativos** do Hono
- ✅ **Code splitting** automático (server/client)
- ✅ **Zero config** - convenção sobre configuração

### Stack Tecnológico

```
Backend:    Hono 4.x (web framework)
Frontend:   Preact 10.x (React alternative, 3kb)
State:      @preact/signals (reatividade global)
Routing:    wouter-preact (client-side SPA)
SSR:        preact-render-to-string
Build:      Vite 7.x + Plugin customizado
Language:   TypeScript (strict mode)
```

### Arquitetura em 3 Camadas

```
┌─────────────────────────────────────────────────────┐
│ 1. DESENVOLVIMENTO (Developer Experience)          │
└─────────────────────────────────────────────────────┘
         ↓
   Desenvolvedor escreve:
   - routes.ts (configuração de rotas)
   - app/*/page.tsx (páginas com loader + actions + component)

┌─────────────────────────────────────────────────────┐
│ 2. BUILD TIME (Vite Plugin)                        │
└─────────────────────────────────────────────────────┘
         ↓
   Vite Plugin VeloJS:
   ┌──────────────────────────────────────┐
   │ buildStart() hook:                   │
   │ 1. Escaneia routes.ts                │
   │ 2. Para cada page.tsx:               │
   │    - Extrai loader()                 │
   │    - Extrai action_*()               │
   │    - Extrai default export           │
   │ 3. Gera arquivos em .velojs/:        │
   │    - page.server.ts (loader+actions) │
   │    - page.client.tsx (component)     │
   │    - server-routes.ts (Hono routes)  │
   │    - client-routes.tsx (Wouter)      │
   └──────────────────────────────────────┘
         ↓
   Vite faz bundle:
   - Server: .velojs/**/*.server.ts → dist/server/
   - Client: .velojs/**/*.client.tsx → dist/client/

┌─────────────────────────────────────────────────────┐
│ 3. RUNTIME (Execução)                              │
└─────────────────────────────────────────────────────┘
         ↓
   PRIMEIRA CARGA (SSR):
   1. Request → Hono → Middleware → Loader
   2. Loader busca dados
   3. Renderiza component (preact-render-to-string)
   4. Injeta dados em window.__PAGE_DATA__
   5. Retorna HTML completo
   6. Browser: Mostra HTML → Carrega JS → Hydrate

   NAVEGAÇÃO SPA (Client-side):
   1. Click em link → Wouter muda rota
   2. Component renderiza
   3. useLoaderData() faz fetch(?_data=1)
   4. Hono retorna JSON
   5. Signal atualiza → Component re-renderiza

   SERVER ACTION:
   1. User clica botão → useAction(action_createUser)
   2. POST /api/admin/users/action_createUser
   3. Hono → Middleware → Action function
   4. Retorna resultado
   5. Component chama revalidate() se necessário
```

### Convenções Principais

| Convenção | Descrição | Exemplo |
|-----------|-----------|---------|
| **page.tsx** | Página da rota | `app/admin/users/page.tsx` |
| **layout.tsx** | Layout que envolve rotas filhas | `app/admin/layout.tsx` |
| **loader()** | Função que busca dados server-side | `export async function loader()` |
| **action_\*** | Server action (mutação) | `export async function action_createUser()` |
| **default export** | Componente Preact | `export default function UsersPage()` |
| **.velojs/** | Diretório de arquivos gerados | `.velojs/admin/users/page.server.ts` |

### Decisões de Design Importantes

#### 1. Nome: VeloJS
- **Escolha**: `velojs` (velocity + js)
- **Rejeitados**: `honact`, `velo` (npm ocupado), `cubox`, `prism`, `nexus`
- **Razão**: Agnóstico à implementação (caso mude Hono/Preact no futuro)

#### 2. Server Actions: `action_*` ao invés de `"use server"`
- **Escolha**: Convenção por nome (`action_createUser`)
- **Rejeitado**: Diretiva `"use server"` (Next.js style)
- **Razão**: Menos "mágico", mais explícito, fácil de detectar

#### 3. Diretório gerado: `.velojs/` ao invés de `.vite/`
- **Escolha**: `.velojs/` (nome do framework)
- **Rejeitado**: `.vite/` (confuso com cache do Vite)
- **Razão**: Clareza de que é gerado pelo VeloJS

#### 4. Code Splitting: Pre-build
- **Escolha**: Gerar `.velojs/*.server.ts` e `.velojs/*.client.tsx` ANTES do Vite
- **Rejeitado**: Tree-shaking no Vite (muito complexo)
- **Razão**: Vite não reclama de imports server-only, bundles limpos

#### 5. Dados no Component: Signal ao invés de Props
- **Escolha**: `useLoaderData()` retorna signal reativo
- **Rejeitado**: Passar dados via props (RRv7 style, "carimbados")
- **Razão**: Signals são globais, podem ser atualizados, mais flexível

#### 6. Layouts são SEMPRE Nested (sem conceito de "Root" especial)
- **Escolha**: Todo layout é tratado igual, usa `{children}` nativo do Preact
- **Rejeitado**: Ter helper `root()` separado ou componente `<Outlet />` customizado
- **Razão**:
  - Mais simples: usa padrão nativo do Preact
  - Consistente: não tem casos especiais
  - Flexível: prefix é sempre opcional em qualquer nível
  - Natural: renderização nested `<Layout1><Layout2><Page /></Layout2></Layout1>`

#### 7. Prefix é Opcional e Serve APENAS para Construir URLs
- **Escolha**: Layout pode ter ou não ter `prefix`, afeta apenas a URL final
- **Comportamento**: URL final = concatenação de todos os prefixes + path da rota
- **Exemplos**:
  ```typescript
  // Com prefix em todos os níveis
  layout("./app.tsx", {
    prefix: "/app",
    routes: [
      layout("./admin/layout.tsx", {
        prefix: "/admin",
        routes: [
          route("/users", "..."),  // → URL: /app/admin/users
        ],
      }),
    ],
  })

  // Sem prefix no layout externo
  layout("./app.tsx", {
    // Sem prefix!
    routes: [
      layout("./admin/layout.tsx", {
        prefix: "/admin",
        routes: [
          route("/users", "..."),  // → URL: /admin/users
        ],
      }),
    ],
  })
  ```
- **Razão**: Comportamento previsível, sem lógica especial para "root"

#### 8. Componentes Usam `{children}` Padrão do Preact
- **Escolha**: Layouts recebem `children` como prop padrão
- **Rejeitado**: Criar componente customizado `<Outlet />`
- **Exemplo**:
  ```tsx
  // Layout component
  export default function AdminLayout({ children }) {
    return (
      <div className="admin">
        <nav>Menu</nav>
        {children}  {/* ← Rotas filhas renderizam aqui */}
      </div>
    );
  }
  ```
- **Razão**: Usa API nativa do Preact, sem abstrações desnecessárias

### Estrutura de Diretórios

```
velojs/                              # 📦 Repositório do framework
├── src/
│   ├── vite-plugin/
│   │   ├── index.ts                 # Plugin principal
│   │   ├── scanner.ts               # Escaneia routes.ts
│   │   ├── code-splitter.ts         # Separa server/client
│   │   └── generator.ts             # Gera .velojs/*
│   │
│   ├── hooks/
│   │   ├── useLoaderData.ts         # Hook de loader (com cache)
│   │   └── useAction.ts             # Hook de server action
│   │
│   ├── runtime/
│   │   ├── renderPage.ts            # Helper de SSR
│   │   └── getContext.ts            # Acessa Hono context em actions
│   │
│   ├── core/
│   │   ├── route.ts                 # Helper route()
│   │   └── layout.ts                # Helper layout()
│   │
│   ├── types.ts                     # Type definitions
│   └── index.ts                     # Entry point
│
├── examples/
│   └── basic/                       # App de exemplo
│
├── package.json
├── tsconfig.json
└── README.md
```

```
projeto-usuario/                     # 📱 App usando VeloJS
├── app/                             # Código do desenvolvedor
│   ├── admin/
│   │   ├── layout.tsx
│   │   └── users/
│   │       └── page.tsx             # loader + actions + component
│   └── auth/
│       └── login/
│           └── page.tsx
│
├── .velojs/                         # Gerado (git ignore)
│   ├── admin/
│   │   └── users/
│   │       ├── page.server.ts       # loader + actions
│   │       └── page.client.tsx      # component apenas
│   ├── server-routes.ts             # Rotas Hono
│   ├── client-routes.tsx            # Rotas Wouter
│   └── route-manifest.json
│
├── routes.ts                        # Config de rotas
├── velojs.config.ts                 # Config do framework
├── package.json
└── vite.config.ts                   # Registra VeloJS plugin
```

### Fluxo de Dados Completo

#### Exemplo: Página de Usuários

```typescript
// app/admin/users/page.tsx (FONTE - desenvolvedor escreve)

// ============================================
// LOADER: Busca dados (server-side)
// ============================================
export async function loader({ context, params, request }: LoaderArgs) {
  const user = context.get("user");  // De authMiddleware
  const { getUsers } = await import("~/modules/user/user.repository");
  const users = await getUsers({ companyId: user.companyId });
  return { users };
}

// ============================================
// ACTIONS: Mutações (server-side)
// ============================================
export async function action_createUser(name: string, email: string) {
  const { saveUser } = await import("~/modules/user/user.repository");
  return await saveUser({ name, email });
}

export async function action_deleteUser(userId: string) {
  const { deleteUser } = await import("~/modules/user/user.repository");
  await deleteUser(userId);
  return { success: true };
}

// ============================================
// COMPONENT: UI (client-side)
// ============================================
export default function UsersPage() {
  const { value: data, loading } = useLoaderData<typeof loader>();
  const [create, creating] = useAction(action_createUser);
  const [deleteAction, deleting] = useAction(action_deleteUser);

  const handleCreate = async () => {
    await create("João", "joao@email.com");
    revalidate();  // Recarrega dados
  };

  if (loading.value) return <p>Carregando...</p>;

  return (
    <div>
      <button onClick={handleCreate} disabled={creating.value}>
        {creating.value ? "Criando..." : "Criar Usuário"}
      </button>

      <ul>
        {data.value?.users.map(user => (
          <li key={user.id}>
            {user.name}
            <button onClick={() => deleteAction(user.id)}>Deletar</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

**O que acontece no build:**

```typescript
// .velojs/admin/users/page.server.ts (GERADO)
export async function loader({ context, params, request }) {
  const user = context.get("user");
  const { getUsers } = await import("~/modules/user/user.repository");
  const users = await getUsers({ companyId: user.companyId });
  return { users };
}

export async function action_createUser(name, email) {
  const { saveUser } = await import("~/modules/user/user.repository");
  return await saveUser({ name, email });
}

export async function action_deleteUser(userId) {
  const { deleteUser } = await import("~/modules/user/user.repository");
  await deleteUser(userId);
  return { success: true };
}
```

```typescript
// .velojs/admin/users/page.client.tsx (GERADO)
import { useLoaderData, useAction } from "velojs/hooks";
import { revalidate } from "velojs/runtime";

export default function UsersPage() {
  const { value: data, loading } = useLoaderData();
  const [create, creating] = useAction(action_createUser);
  const [deleteAction, deleting] = useAction(action_deleteUser);

  const handleCreate = async () => {
    await create("João", "joao@email.com");
    revalidate();
  };

  if (loading.value) return <p>Carregando...</p>;

  return (
    <div>
      <button onClick={handleCreate} disabled={creating.value}>
        {creating.value ? "Criando..." : "Criar Usuário"}
      </button>

      <ul>
        {data.value?.users.map(user => (
          <li key={user.id}>
            {user.name}
            <button onClick={() => deleteAction(user.id)}>Deletar</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

```typescript
// .velojs/server-routes.ts (GERADO - rotas Hono)
import { Hono } from "hono";
import { authMiddleware } from "~/middlewares/auth";
import * as usersPage from "./admin/users/page.server";

const app = new Hono();

// Rota SSR (primeira carga)
app.get("/admin/users", authMiddleware, async (c) => {
  const data = await usersPage.loader({
    context: c,
    params: c.req.param(),
    request: c.req.raw,
  });

  const html = renderPage(c, <UsersPage />, data);
  return c.html(html);
});

// Rota de dados (navegação SPA)
app.get("/admin/users", async (c) => {
  if (c.req.query("_data") === "1") {
    const data = await usersPage.loader({
      context: c,
      params: c.req.param(),
      request: c.req.raw,
    });
    return c.json(data);
  }
  // ... SSR acima
});

// Server Actions
app.post("/api/admin/users/action_createUser", authMiddleware, async (c) => {
  const { args } = await c.req.json();
  const result = await usersPage.action_createUser(...args);
  return c.json(result);
});

app.post("/api/admin/users/action_deleteUser", authMiddleware, async (c) => {
  const { args } = await c.req.json();
  const result = await usersPage.action_deleteUser(...args);
  return c.json(result);
});

export default app;
```

### Roadmap de Implementação

**Fase 1: Setup Inicial** (1-2 dias)
- [ ] Criar repo `velojs` no GitHub
- [ ] Setup package.json, tsconfig.json
- [ ] Estrutura de pastas (src/vite-plugin, src/hooks, etc)
- [ ] Configurar build (tsup ou tsc)

**Fase 2: Core Types** (1 dia)
- [ ] Definir types em `src/types.ts`
- [ ] RouteConfig, LoaderArgs, etc
- [ ] Helpers `route()` e `layout()` em `src/core/`

**Fase 3: Vite Plugin - Scanner** (2-3 dias)
- [ ] Implementar `scanner.ts` que lê routes.ts
- [ ] Resolver paths de arquivos
- [ ] Extrair middlewares
- [ ] Calcular URLs finais com prefixes

**Fase 4: Vite Plugin - Code Splitter** (3-4 dias)
- [ ] Parser AST (usar SWC ou Babel)
- [ ] Detectar `loader()` function
- [ ] Detectar `action_*` functions
- [ ] Extrair default export
- [ ] Gerar `.velojs/*.server.ts`
- [ ] Gerar `.velojs/*.client.tsx`

**Fase 5: Vite Plugin - Generator** (2-3 dias)
- [ ] Gerar `.velojs/server-routes.ts` (Hono)
- [ ] Gerar `.velojs/client-routes.tsx` (Wouter)
- [ ] Aplicar middlewares corretamente
- [ ] Gerar route manifest

**Fase 6: Runtime Hooks** (2-3 dias)
- [ ] Implementar `useLoaderData()` com cache
- [ ] Implementar `useAction()`
- [ ] Implementar `revalidate()`

**Fase 7: Runtime Helpers** (1-2 dias)
- [ ] Implementar `renderPage()`
- [ ] Implementar `getContext()`

**Fase 8: Exemplo Básico** (2-3 dias)
- [ ] Criar `examples/basic/`
- [ ] App simples com login + CRUD
- [ ] Testar SSR, SPA navigation, actions

**Fase 9: Docs e Publish** (2-3 dias)
- [ ] README.md completo
- [ ] Documentação de API
- [ ] Publicar no npm
- [ ] Site de docs (velojs.dev)

**Total estimado**: 15-25 dias de desenvolvimento

### Perguntas Frequentes (para IA Agents)

**Q: Por que não usar React Router v7 diretamente?**
A: RRv7 é muito opinado. Força padrões específicos (FormData, useFetcher) e tem modelo mental complexo para quem vem de micro-frameworks. VeloJS oferece mesma produtividade com mais flexibilidade.

**Q: Por que Preact e não React?**
A: Bundle 3kb vs 42kb. Preact Signals oferece reatividade global sem Context API. Compatível com React (preact/compat).

**Q: Como funciona o code splitting?**
A: Vite plugin separa código ANTES do Vite fazer bundle. Gera `.velojs/*.server.ts` (loader + actions) e `.velojs/*.client.tsx` (component). Vite bundla cada um separadamente, evitando imports server-only no client.

**Q: Como loaders são diferentes de RRv7?**
A: Em RRv7, dados vêm como props (carimbados). Em VeloJS, `useLoaderData()` retorna signal reativo que pode ser atualizado. Cache manual via Map.

**Q: Server Actions funcionam como em Next.js?**
A: Similar, mas ao invés de `"use server"` usamos convenção `action_*`. Menos mágico, mais explícito. Build detecta por regex.

**Q: Middlewares são compatíveis com Hono?**
A: Sim, 100% compatíveis. Usamos `createMiddleware()` do Hono. Sem abstrações.

**Q: Type-safety funciona?**
A: Sim. TypeScript infere tipos de `loader()` e `action_*` automaticamente. `useLoaderData<typeof loader>()` oferece autocomplete perfeito.

**Q: Como funciona SSR?**
A: Primeira carga: Hono executa loader → renderiza component com preact-render-to-string → injeta dados em `window.__PAGE_DATA__` → retorna HTML. Client hydrata e pega dados de `window.__PAGE_DATA__`. Navegações SPA: fetch `?_data=1`.

**Q: Qual o diferencial real?**
A: Produtividade de framework opinado (RRv7/Next.js) + Flexibilidade de micro-framework (Hono) + Bundle pequeno (Preact) + Reatividade simples (Signals). É o "sweet spot".

### Checklist de Início

Para um agente IA começar a implementação:

- [ ] Ler esta especificação completa
- [ ] Entender arquitetura em 3 camadas (Dev → Build → Runtime)
- [ ] Revisar decisões de design
- [ ] Criar repo `velojs` no GitHub
- [ ] Seguir roadmap de implementação
- [ ] Começar por Fase 1 (Setup) e Fase 2 (Types)
- [ ] Implementar Vite Plugin progressivamente (Fases 3-5)
- [ ] Implementar Runtime (Fases 6-7)
- [ ] Testar com exemplo (Fase 8)

### Recursos de Referência

**Inspirações (estudar):**
- React Router v7: https://reactrouter.com/
- Next.js Server Actions: https://nextjs.org/docs/app/building-your-application/data-fetching/server-actions-and-mutations
- Hono: https://hono.dev/
- Preact Signals: https://preactjs.com/guide/v10/signals/

**Ferramentas necessárias:**
- SWC ou Babel (AST parsing)
- Vite Plugin API: https://vitejs.dev/guide/api-plugin.html
- wouter-preact: https://github.com/molefrog/wouter

---

## Motivação

### Por que VeloJS?

**VeloJS** nasceu da necessidade de um framework full-stack que combine o melhor de dois mundos:
- A **simplicidade e flexibilidade** de micro-frameworks como Hono
- A **produtividade** de frameworks opinados como React Router v7

### Problemas que Resolve

1. **Frameworks muito opinados** (ex: React Router v7)
   - Modelo mental complexo para quem vem de micro-frameworks
   - Forçam padrões específicos (FormData, useFetcher, etc)
   - Difícil entender o que acontece "por baixo dos panos"

2. **Micro-frameworks muito manuais** (ex: Hono puro)
   - Muito código boilerplate para SSR
   - Sem convenções: cada projeto é diferente
   - Difícil manter consistência em projetos grandes

3. **Frameworks pesados** (ex: Next.js)
   - Bundle grande (React + dependências)
   - Vendor lock-in
   - Difícil customizar

### Inspirações

**VeloJS** foi inspirado principalmente por:

- **React Router v7**: File-based routing, loaders, actions, SSR
- **Hono**: API minimalista, middlewares nativos, performance
- **Preact Signals**: Reatividade simples e performática
- **Next.js Server Actions**: Funções server-side chamadas do client

### Diferencial

O que torna **VeloJS** único:

| Aspecto | VeloJS | React Router v7 | Hono Puro |
|---------|--------|-----------------|-----------|
| **Bundle Size** | ~10kb (Preact) | ~42kb (React) | N/A (backend) |
| **Server Actions** | ✅ `"use server"` | ❌ Só `action()` | ❌ Manual |
| **Type-safe** | ✅ Inferido | ⚠️ Manual | ⚠️ Manual |
| **Reatividade** | ✅ Signals globais | ❌ Props/Context | ❌ N/A |
| **Middlewares** | ✅ Hono nativo | ⚠️ Próprio | ✅ Hono nativo |
| **Flexibilidade** | ✅ Alta | ⚠️ Média | ✅ Total |
| **Produtividade** | ✅ Alta | ✅ Alta | ⚠️ Média |

**Em resumo**: VeloJS oferece a **produtividade do RRv7** com a **flexibilidade do Hono** e a **leveza do Preact**.

---

## Visão Geral

Framework full-stack para aplicações web modernas com SSR, file-based routing e server actions.

### Stack Core

- **Backend**: Hono 4.x
- **Frontend**: Preact 10.x
- **SSR**: preact-render-to-string
- **Routing**: wouter-preact (client-side)
- **Build**: Vite 7.x
- **Language**: TypeScript

### Filosofia

1. **Zero Config**: Convenção sobre configuração
2. **Type-Safe**: TypeScript em todo lugar
3. **File-Based**: Estrutura de pastas = rotas
4. **Server Actions**: Funções que viram APIs automaticamente
5. **Middleware First**: Middlewares Hono nativos

---

## 1. Configuração de Rotas

### 1.1. Estrutura Base

```typescript
// routes.ts (na raiz do projeto)
import { route, layout, type RouteConfig } from "./framework";

export default [
  layout("./auth/layout.tsx", {
    prefix: "/auth",
    middleware: [unauthMiddleware],
    routes: [
      route("/login", "./auth/login/page.tsx"),
      route("/esqueci-senha", "./auth/reset/page.tsx"),
    ],
  }),

  layout("./admin/layout.tsx", {
    prefix: "/admin",
    middleware: [authMiddleware, loggerMiddleware],
    routes: [
      route("/users", "./admin/users/page.tsx", {
        middleware: [requirePermission("users.view")],
      }),
      route("/companies", "./admin/companies/page.tsx"),
    ],
  }),

  route("/", "./home/page.tsx"),
  route("*", "./404.tsx"),
] satisfies RouteConfig;
```

### 1.2. Working Directory

O `workDir` é configurável e define onde estão os arquivos da aplicação.

```typescript
// framework.config.ts
export default {
  workDir: "./app",  // Pode ser: "./app", "./src", "./pages", etc
  // Todos os caminhos em routes.ts são relativos a workDir
};
```

### 1.3. API de Rotas

#### `layout(file, options)`

Cria um layout que envolve rotas filhas.

**Parâmetros**:
- `file` (string, required): Caminho relativo ao workDir
- `options` (object, optional):
  - `prefix` (string): Prefixo de URL para todas rotas filhas
  - `middleware` (Middleware[]): Array de middlewares Hono
  - `routes` (RouteConfig[]): Array de rotas filhas

**Retorna**: `LayoutConfig`

**Comportamento**:
- Layout renderiza as rotas filhas via `<Outlet />` (ou equivalente Preact)
- Middlewares do layout executam ANTES dos middlewares das rotas filhas
- Prefix é concatenado com o path das rotas filhas

**Exemplo**:
```typescript
layout("./admin/layout.tsx", {
  prefix: "/admin",
  middleware: [authMiddleware],
  routes: [
    route("/users", "./admin/users/page.tsx"),     // URL final: /admin/users
    route("/companies", "./admin/companies/page.tsx"), // URL final: /admin/companies
  ],
})
```

#### `route(path, file, options)`

Cria uma rota individual.

**Parâmetros**:
- `path` (string, required): Caminho da URL
- `file` (string, required): Caminho relativo ao workDir
- `options` (object, optional):
  - `middleware` (Middleware[]): Array de middlewares Hono

**Retorna**: `RouteConfig`

**Comportamento**:
- Path aceita parâmetros dinâmicos: `/users/:id`
- Path aceita wildcards: `/docs/*`
- Middlewares executam na ordem: layout → route → handler

**Exemplo**:
```typescript
route("/users/:id", "./admin/users/detail/page.tsx", {
  middleware: [requirePermission("users.view")],
})
```

### 1.4. Type Definitions

```typescript
// framework/types.ts

import type { MiddlewareHandler } from "hono";

/**
 * Configuração de uma rota individual
 */
export interface RouteDefinition {
  path: string;
  file: string;
  middleware?: MiddlewareHandler[];
}

/**
 * Configuração de um layout com rotas filhas
 */
export interface LayoutDefinition {
  file: string;
  prefix?: string;
  middleware?: MiddlewareHandler[];
  routes: RouteConfig[];
}

/**
 * Union type para route ou layout
 */
export type RouteConfig = RouteDefinition | LayoutDefinition;

/**
 * Helper para criar rotas (type-safe)
 */
export function route(
  path: string,
  file: string,
  options?: { middleware?: MiddlewareHandler[] }
): RouteDefinition;

/**
 * Helper para criar layouts (type-safe)
 */
export function layout(
  file: string,
  options: {
    prefix?: string;
    middleware?: MiddlewareHandler[];
    routes: RouteConfig[];
  }
): LayoutDefinition;
```

---

## 2. Middlewares

### 2.1. Middleware Hono Nativo

Usamos middlewares do Hono nativamente, sem abstrações.

```typescript
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";

// Middleware simples
export const loggerMiddleware = createMiddleware(async (c, next) => {
  console.log(`[${new Date().toISOString()}] ${c.req.method} ${c.req.url}`);
  await next();
});

// Middleware com lógica
export const authMiddleware = createMiddleware(async (c, next) => {
  const cookie = c.req.header("Cookie");
  const token = extractToken(cookie);

  if (!token) {
    return c.redirect("/login");
  }

  const user = await validateToken(token);

  if (!user) {
    return c.redirect("/login");
  }

  // Injeta user no contexto do Hono
  c.set("user", user);

  await next();
});

// Middleware com parâmetros (factory)
export const requirePermission = (permission: string) => {
  return createMiddleware(async (c, next) => {
    const user = c.get("user");

    if (!user.permissions.includes(permission)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    await next();
  });
};
```

### 2.2. Ordem de Execução

```
Request
  ↓
Layout Middleware 1
  ↓
Layout Middleware 2
  ↓
Route Middleware 1
  ↓
Route Middleware 2
  ↓
Route Handler (SSR ou API)
  ↓
Response
```

**Exemplo**:
```typescript
layout("./admin/layout.tsx", {
  middleware: [authMiddleware, loggerMiddleware],  // Executam primeiro
  routes: [
    route("/users", "./admin/users/page.tsx", {
      middleware: [requirePermission("users.view")],  // Executa depois
    }),
  ],
})

// Ordem final: authMiddleware → loggerMiddleware → requirePermission → handler
```

### 2.3. Context Sharing

Middlewares podem compartilhar dados via `c.set()` e `c.get()`:

```typescript
// middleware-auth.ts
export const authMiddleware = createMiddleware(async (c, next) => {
  const user = await validateToken(token);
  c.set("user", user);  // ← Injeta
  await next();
});

// middleware-permission.ts
export const requirePermission = (perm: string) => {
  return createMiddleware(async (c, next) => {
    const user = c.get("user");  // ← Acessa
    if (!user.permissions.includes(perm)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    await next();
  });
};
```

---

## 3. Estrutura de Arquivos

### 3.1. Estrutura Mínima

```
projeto/
├── routes.ts                    # Definição de rotas
├── framework.config.ts          # Configuração do framework
│
├── app/                         # workDir (configurável)
│   ├── auth/
│   │   ├── layout.tsx           # Layout de auth
│   │   ├── login/
│   │   │   └── page.tsx         # Página de login
│   │   └── reset/
│   │       └── page.tsx
│   │
│   ├── admin/
│   │   ├── layout.tsx
│   │   ├── users/
│   │   │   └── page.tsx
│   │   └── companies/
│   │       └── page.tsx
│   │
│   ├── home/
│   │   └── page.tsx
│   │
│   └── 404.tsx
│
├── middlewares/                 # Middlewares compartilhados
│   ├── auth.ts
│   ├── logger.ts
│   └── permission.ts
│
└── vite.config.ts
```

### 3.2. Convenções de Nomenclatura

- **Layout**: `layout.tsx` (nome fixo)
- **Página**: `page.tsx` (nome fixo)
- **404**: `404.tsx` (nome fixo)
- **Middlewares**: `*.ts` ou `*.middleware.ts`

---

## 4. Rotas Geradas pelo Builder

O builder percorre as rotas definidas e gera:

### 4.1. Rotas Hono (Server-Side)

Para cada rota, o builder gera:

1. **Rota SSR** (primeira carga)
2. **Rota de Dados** (navegação client-side)
3. **Rotas de Actions** (server actions)

**Exemplo de entrada**:
```typescript
route("/users", "./admin/users/page.tsx", {
  middleware: [authMiddleware],
})
```

**Saída gerada** (`.velojs/server-routes.ts`):
```typescript
import { Hono } from "hono";
import { authMiddleware } from "../middlewares/auth";

const app = new Hono();

// SSR (primeira carga)
app.get(
  "/users",
  authMiddleware,  // ← Middleware aplicado
  async (c) => {
    const { default: UsersPage, getServerSideProps } =
      await import("../app/admin/users/page.server.js");

    const props = await getServerSideProps({ context: c });
    const html = renderToString(<UsersPage {...props} />);

    return c.html(htmlTemplate(html, props));
  }
);

// Dados (navegação client-side)
app.get(
  "/api/users/data",
  authMiddleware,  // ← Mesmo middleware
  async (c) => {
    const { getServerSideProps } =
      await import("../app/admin/users/page.server.js");

    const data = await getServerSideProps({ context: c });
    return c.json(data);
  }
);

// Server Actions (se existirem)
app.post(
  "/api/users/createUser",
  authMiddleware,  // ← Mesmo middleware
  async (c) => {
    const { createUser } =
      await import("../app/admin/users/page.server.js");

    const { args } = await c.req.json();
    const result = await createUser(...args);
    return c.json(result);
  }
);

export default app;
```

### 4.2. Rotas Wouter (Client-Side)

**Saída gerada** (`.velojs/client-routes.tsx`):
```typescript
import { Route, Switch } from "wouter-preact";
import { lazy } from "preact/compat";

const UsersPage = lazy(() => import("../app/admin/users/page.client.js"));

export function Routes() {
  return (
    <Switch>
      <Route path="/users" component={UsersPage} />
      {/* Outras rotas... */}
    </Switch>
  );
}
```

### 4.3. Aplicação de Middlewares

**Regras**:
1. Middlewares de layout executam ANTES de middlewares de route
2. Middlewares executam na ordem do array
3. Se um middleware retorna Response, a cadeia é interrompida
4. Middlewares são aplicados em TODAS as rotas geradas (SSR, data, actions)

**Exemplo**:
```typescript
layout("./admin/layout.tsx", {
  middleware: [A, B],
  routes: [
    route("/users", "./admin/users/page.tsx", {
      middleware: [C, D],
    }),
  ],
})

// Ordem final em TODAS as rotas (/users, /api/users/data, /api/users/*):
// A → B → C → D → handler
```

---

## 5. Exemplos Práticos

### 5.1. Estrutura de Autenticação

```typescript
// routes.ts
export default [
  layout("./auth/layout.tsx", {
    prefix: "/auth",
    middleware: [unauthMiddleware],  // Redireciona se JÁ autenticado
    routes: [
      route("/login", "./auth/login/page.tsx"),
      route("/esqueci-senha", "./auth/reset/page.tsx"),
      route("/redefinir-senha/:token", "./auth/set-password/page.tsx"),
    ],
  }),
] satisfies RouteConfig;
```

**URLs finais**:
- `/auth/login`
- `/auth/esqueci-senha`
- `/auth/redefinir-senha/:token`

### 5.2. Estrutura Admin com Permissões

```typescript
// routes.ts
export default [
  layout("./admin/layout.tsx", {
    prefix: "/admin",
    middleware: [authMiddleware],  // Protege todas rotas
    routes: [
      route("/", "./admin/home/page.tsx"),

      route("/users", "./admin/users/page.tsx", {
        middleware: [requirePermission("users.view")],
      }),

      route("/users/:id", "./admin/users/detail/page.tsx", {
        middleware: [requirePermission("users.view")],
      }),

      route("/companies", "./admin/companies/page.tsx", {
        middleware: [requirePermission("companies.view")],
      }),
    ],
  }),
] satisfies RouteConfig;
```

**URLs finais**:
- `/admin/` (só authMiddleware)
- `/admin/users` (authMiddleware + requirePermission)
- `/admin/users/:id` (authMiddleware + requirePermission)
- `/admin/companies` (authMiddleware + requirePermission)

### 5.3. Rotas Públicas + Privadas

```typescript
// routes.ts
export default [
  // Públicas
  route("/", "./home/page.tsx"),
  route("/sobre", "./about/page.tsx"),

  // Auth (público mas redireciona se autenticado)
  layout("./auth/layout.tsx", {
    prefix: "/auth",
    middleware: [unauthMiddleware],
    routes: [
      route("/login", "./auth/login/page.tsx"),
    ],
  }),

  // Admin (privado)
  layout("./admin/layout.tsx", {
    prefix: "/admin",
    middleware: [authMiddleware, loggerMiddleware],
    routes: [
      route("/users", "./admin/users/page.tsx"),
    ],
  }),

  // 404
  route("*", "./404.tsx"),
] satisfies RouteConfig;
```

### 5.4. Nested Layouts com `{children}`

**Conceito**: Layouts são SEMPRE nested e usam `{children}` nativo do Preact (sem `<Outlet />` customizado).

#### Configuração de Rotas
```typescript
// routes.ts
export default [
  layout("./app/layout.tsx", {  // Layout global (sem prefix)
    middleware: [corsMiddleware],
    routes: [
      layout("./admin/layout.tsx", {  // Layout admin (nested)
        prefix: "/admin",
        middleware: [authMiddleware],
        routes: [
          route("/users", "./admin/users/page.tsx"),  // URL: /admin/users
        ],
      }),
    ],
  }),
] satisfies RouteConfig;
```

#### Componentes

```tsx
// app/layout.tsx - Layout global
export default function AppLayout({ children }) {
  return (
    <html lang="pt-BR">
      <head>
        <meta charSet="utf-8" />
        <title>My App</title>
      </head>
      <body>
        <header>Global Header</header>
        <main>
          {children}  {/* ← Layouts/rotas filhas renderizam aqui */}
        </main>
        <footer>Global Footer</footer>
      </body>
    </html>
  );
}

// app/admin/layout.tsx - Layout nested
export default function AdminLayout({ children }) {
  return (
    <div className="admin-container">
      <aside>
        <nav>Admin Menu</nav>
      </aside>
      <div className="admin-content">
        {children}  {/* ← Páginas admin renderizam aqui */}
      </div>
    </div>
  );
}

// app/admin/users/page.tsx - Página
export default function UsersPage() {
  return (
    <div>
      <h1>Users</h1>
      <p>List of users...</p>
    </div>
  );
}
```

#### Renderização Final (SSR)

Para a URL `/admin/users`, o framework renderiza nested (de dentro para fora):

```tsx
// Renderização nested
<AppLayout>
  <AdminLayout>
    <UsersPage />
  </AdminLayout>
</AppLayout>

// HTML final
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <title>My App</title>
  </head>
  <body>
    <header>Global Header</header>
    <main>
      <div class="admin-container">
        <aside>
          <nav>Admin Menu</nav>
        </aside>
        <div class="admin-content">
          <div>
            <h1>Users</h1>
            <p>List of users...</p>
          </div>
        </div>
      </div>
    </main>
    <footer>Global Footer</footer>
  </body>
</html>
```

#### Cálculo de URL

- Layout global: **sem prefix** → não adiciona nada à URL
- Layout admin: `prefix: "/admin"` → adiciona `/admin`
- Route users: `path: "/users"` → adiciona `/users`
- **URL final**: ` ` + `/admin` + `/users` = `/admin/users`

#### Ordem de Execução

1. **Middlewares**: `corsMiddleware` → `authMiddleware` → handler
2. **Loaders** (se existirem): `AppLayout.loader()` → `AdminLayout.loader()` → `UsersPage.loader()`
3. **Renderização**: `<UsersPage />` → `<AdminLayout>{page}</AdminLayout>` → `<AppLayout>{admin}</AppLayout>`

---

## 6. Fluxo de Build

### 6.1. Análise de Rotas

```
1. Lê routes.ts
2. Resolve workDir (framework.config.ts)
3. Percorre RouteConfig recursivamente
4. Para cada route/layout:
   - Resolve file path absoluto
   - Extrai middlewares
   - Calcula URL final (prefix + path)
   - Encontra server actions ("use server")
```

### 6.2. Geração de Código

```
1. Gera .velojs/server-routes.ts
   - Rotas Hono com middlewares
   - SSR + Data + Actions

2. Gera .velojs/client-routes.tsx
   - Rotas Wouter
   - Lazy load components

3. Gera .velojs/route-manifest.json
   - Metadata para debugging
```

### 6.3. Code Splitting

```
Original:
  app/admin/users/page.tsx

Build gera:
  app/admin/users/page.server.js   ← Server-only (SSR + Actions)
  app/admin/users/page.client.js   ← Client-only (Component hydratado)
```

---

## 7. TypeScript Support

### 7.1. Autocomplete de Rotas

```typescript
import { route, layout, type RouteConfig } from "./framework";

// ✅ Type-safe
export default [
  route("/users", "./admin/users/page.tsx"),
] satisfies RouteConfig;

// ❌ Erro de tipo
export default [
  route(123, "./admin/users/page.tsx"),  // path deve ser string
] satisfies RouteConfig;
```

### 7.2. Autocomplete de Middlewares

```typescript
import type { MiddlewareHandler } from "hono";

const authMiddleware: MiddlewareHandler = async (c, next) => {
  // Autocomplete de c.req, c.set, etc
};
```

---

## 8. Loaders (Data Fetching)

### 8.1. Conceito

Loader é uma função que **busca dados no servidor** antes de renderizar a página.

**Características**:
- Executa apenas no servidor
- Primeira carga: SSR com dados em `window.__PAGE_DATA__`
- Navegação SPA: Fetch automático da rota de dados
- Cache automático: Não refetch desnecessário

### 8.2. API do Loader

```typescript
// app/admin/users/page.tsx

/**
 * Loader - busca dados no servidor
 */
export async function loader(args: LoaderArgs) {
  const { context, params, request } = args;

  // Acessa contexto Hono (ex: user injetado por middleware)
  const user = context.get("user");

  // Acessa params da URL (ex: /users/:id)
  const userId = params.id;

  // Busca dados do banco
  const { getUsers } = await import("~/modules/user/user.repository");
  const users = await getUsers({ companyId: user.companyId });

  return { users };
}

/**
 * Component - usa os dados
 */
export default function UsersPage() {
  const loaderData = useLoaderData<typeof loader>();

  return (
    <div>
      <h1>Usuários</h1>
      <ul>
        {loaderData.value?.users.map(user => (
          <li key={user.id}>{user.name}</li>
        ))}
      </ul>
    </div>
  );
}
```

### 8.3. Type Definition

```typescript
// framework/types.ts

import type { Context } from "hono";

/**
 * Argumentos passados para o loader
 */
export interface LoaderArgs {
  /**
   * Contexto do Hono (c)
   * - Acessa dados injetados por middlewares: c.get("user")
   * - Acessa request: c.req
   */
  context: Context;

  /**
   * Parâmetros da URL
   * /users/:id → { id: "123" }
   */
  params: Record<string, string>;

  /**
   * Request original
   */
  request: Request;
}

/**
 * Tipo do loader
 */
export type LoaderFunction<T = any> = (args: LoaderArgs) => Promise<T>;
```

### 8.4. Rotas Geradas pelo Builder

Para cada página com loader, o builder gera **2 rotas Hono**:

#### Rota 1: SSR (primeira carga)

```typescript
// GET /users
app.get("/users", async (c) => {
  const { default: UsersPage, loader } =
    await import("./app/admin/users/page.server.js");

  // Executa loader
  const data = await loader({
    context: c,
    params: c.req.param(),
    request: c.req.raw,
  });

  // Renderiza component
  const html = renderToString(<UsersPage />);

  // Injeta dados no HTML
  const script = `<script>window.__PAGE_DATA__=${JSON.stringify(data)}</script>`;

  return c.html(`
    <!DOCTYPE html>
    <html>
      <head>
        <script type="module" src="/assets/client.js"></script>
      </head>
      <body>
        <div id="app">${html}</div>
        ${script}
      </body>
    </html>
  `);
});
```

#### Rota 2: Data API (navegação SPA)

```typescript
// GET /users?_data=1
app.get("/users", async (c) => {
  const isDataRequest = c.req.query("_data") === "1";

  if (isDataRequest) {
    const { loader } = await import("./app/admin/users/page.server.js");

    const data = await loader({
      context: c,
      params: c.req.param(),
      request: c.req.raw,
    });

    return c.json(data);
  }

  // ... SSR (código acima)
});
```

### 8.5. Hook useLoaderData

```typescript
// hooks/useLoaderData.ts
import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";

/**
 * Hook para acessar dados do loader
 *
 * Fluxo:
 * 1. Primeira carga (SSR): Lê de window.__PAGE_DATA__
 * 2. Navegação (SPA): Faz fetch se não tiver cache
 * 3. Retorna signal reativo
 */
export function useLoaderData<T extends (...args: any) => any>() {
  const data = signal<Awaited<ReturnType<T>> | null>(null);
  const loading = signal(false);

  useEffect(() => {
    // Prioridade 1: window.__PAGE_DATA__ (SSR ou cache)
    if (window.__PAGE_DATA__) {
      data.value = window.__PAGE_DATA__;
      delete window.__PAGE_DATA__;  // Limpa cache
      return;
    }

    // Prioridade 2: Fetch (navegação SPA)
    loading.value = true;

    fetch(window.location.pathname + "?_data=1")
      .then(r => r.json())
      .then(d => {
        data.value = d;
        loading.value = false;
      })
      .catch(err => {
        console.error("Erro ao carregar dados:", err);
        loading.value = false;
      });
  }, []);

  return { value: data, loading };
}
```

### 8.6. Render Simplificado

```typescript
// framework/render.ts
import { render as preactRender } from "preact-render-to-string";
import type { VNode } from "preact";
import type { Context } from "hono";

/**
 * Renderiza página com SSR
 *
 * @param c - Contexto Hono
 * @param Component - Componente Preact
 * @param data - Dados do loader (opcional)
 */
export function renderPage(c: Context, Component: VNode, data?: any) {
  const html = preactRender(Component);

  // Se tem dados, injeta em window.__PAGE_DATA__
  const script = data
    ? `<script>window.__PAGE_DATA__=${JSON.stringify(data)}</script>`
    : "";

  return c.html(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <script type="module" src="/assets/client.js"></script>
      </head>
      <body>
        <div id="app">${html}</div>
        ${script}
      </body>
    </html>
  `);
}
```

### 8.7. Fluxo Completo

#### Cenário 1: Primeira Carga (SSR)

```
1. User acessa: http://example.com/users
2. Hono:
   ├─ Executa middlewares (auth, etc)
   ├─ Executa loader({ context, params, request })
   ├─ Renderiza <UsersPage /> (preact-render-to-string)
   ├─ Injeta dados em window.__PAGE_DATA__
   └─ Retorna HTML
3. Browser:
   ├─ Mostra HTML (rápido!)
   ├─ Carrega /assets/client.js
   ├─ Preact hidrata <UsersPage />
   ├─ useLoaderData() lê window.__PAGE_DATA__
   └─ Component renderiza com dados
```

#### Cenário 2: Navegação SPA

```
1. User clica: <Link to="/companies">
2. Wouter:
   ├─ Previne reload
   ├─ Muda URL para /companies
   └─ Renderiza <CompaniesPage />
3. Component:
   ├─ useLoaderData() executa
   ├─ Não tem window.__PAGE_DATA__
   ├─ Faz fetch("/companies?_data=1")
   └─ Atualiza signal quando dados chegam
4. Hono:
   ├─ Detecta ?_data=1
   ├─ Executa loader
   └─ Retorna JSON
5. Browser:
   └─ useLoaderData recebe dados e re-renderiza
```

### 8.8. Cache e Performance

#### Cache Automático

```typescript
// hooks/useLoaderData.ts (versão com cache)
import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";

const dataCache = new Map<string, any>();

export function useLoaderData<T extends (...args: any) => any>() {
  const data = signal<Awaited<ReturnType<T>> | null>(null);
  const loading = signal(false);
  const currentPath = window.location.pathname;

  useEffect(() => {
    // Prioridade 1: window.__PAGE_DATA__ (SSR)
    if (window.__PAGE_DATA__) {
      data.value = window.__PAGE_DATA__;
      dataCache.set(currentPath, window.__PAGE_DATA__);
      delete window.__PAGE_DATA__;
      return;
    }

    // Prioridade 2: Cache (navegação de volta)
    if (dataCache.has(currentPath)) {
      data.value = dataCache.get(currentPath);
      return;
    }

    // Prioridade 3: Fetch (primeira navegação SPA)
    loading.value = true;

    fetch(currentPath + "?_data=1")
      .then(r => r.json())
      .then(d => {
        data.value = d;
        dataCache.set(currentPath, d);
        loading.value = false;
      });
  }, [currentPath]);

  return { value: data, loading };
}
```

#### Invalidação de Cache

```typescript
// hooks/useLoaderData.ts

/**
 * Revalida dados (força novo fetch)
 */
export function revalidate(path?: string) {
  const targetPath = path || window.location.pathname;
  dataCache.delete(targetPath);

  // Dispara evento para hooks reagirem
  window.dispatchEvent(new CustomEvent("revalidate", { detail: { path: targetPath } }));
}

// Uso:
import { revalidate } from "~/hooks/useLoaderData";

const [create] = useAction(createUser);

const handleCreate = async () => {
  await create({ name: "João" });
  revalidate();  // ← Força reload dos dados
};
```

### 8.9. Exemplo Completo

```typescript
// app/admin/users/page.tsx
import { signal } from "@preact/signals";
import { useLoaderData } from "~/hooks/useLoaderData";
import { useAction } from "~/hooks/useAction";

// ============================================
// LOADER: Busca dados (server-side)
// ============================================
export async function loader({ context }: LoaderArgs) {
  const user = context.get("user");  // Do authMiddleware

  const { getUsers } = await import("~/modules/user/user.repository");

  const users = await getUsers({
    companyId: user.companyId,
  });

  return { users, currentUser: user };
}

// ============================================
// SERVER ACTION: Cria usuário
// ============================================
export async function createUser(name: string, email: string) {
  "use server";

  const { saveUser } = await import("~/modules/user/user.repository");
  return await saveUser({ name, email });
}

// ============================================
// COMPONENT: UI
// ============================================
export default function UsersPage() {
  // Dados do loader (reativo!)
  const { value: loaderData, loading } = useLoaderData<typeof loader>();

  // Action
  const [create, creating] = useAction(createUser);

  const handleCreate = async () => {
    await create("João", "joao@email.com");
    revalidate();  // Recarrega lista
  };

  if (loading.value) {
    return <p>Carregando...</p>;
  }

  return (
    <div>
      <h1>Usuários de {loaderData.value?.currentUser.email}</h1>

      <button onClick={handleCreate} disabled={creating.value}>
        {creating.value ? "Criando..." : "Criar Usuário"}
      </button>

      <ul>
        {loaderData.value?.users.map(user => (
          <li key={user.id}>{user.name}</li>
        ))}
      </ul>
    </div>
  );
}
```

### 8.10. Comparação com React Router v7

| | React Router v7 | Nosso Framework |
|---|---|---|
| **Loader** | `export async function loader()` | ✅ Mesmo |
| **Dados no Component** | `loaderData` prop (carimbado) | `useLoaderData()` hook (signal) |
| **SSR** | Automático | ✅ Automático |
| **Cache** | Gerenciado pelo RR | Signal + Map (controle total) |
| **Revalidação** | `useRevalidator()` | `revalidate()` (mais simples) |
| **Type-safe** | `Route.LoaderData` | `typeof loader` (inferido) |

**Vantagem**: Dados **não ficam carimbados** no component. Signal é reativo e pode ser atualizado!

---

## 9. Server Actions (Mutações)

### 9.1. Conceito

Server Actions são **funções que executam no servidor** e podem ser chamadas diretamente do client-side.

**Características**:
- Marcadas com diretiva `"use server"`
- Executam apenas no servidor (nunca no bundle client)
- Retornam dados via JSON
- Type-safe: tipos inferidos automaticamente
- Roteamento automático: não precisa declarar rota explícita

### 9.2. Definição de Server Action

```typescript
// app/admin/users/page.tsx

/**
 * Server Action - cria usuário
 *
 * A diretiva "use server" indica que esta função:
 * 1. Deve ser extraída do bundle client
 * 2. Deve gerar uma rota API automaticamente
 * 3. Pode acessar recursos server-side (DB, FS, etc)
 */
export async function createUser(name: string, email: string) {
  "use server";

  // Import server-side (não vai pro bundle client)
  const { saveUser } = await import("~/modules/user/user.repository");
  const { hashPassword } = await import("~/utils/crypto");

  // Lógica server-side
  const user = await saveUser({
    name,
    email,
    password: await hashPassword("default123"),
  });

  return { success: true, userId: user.id };
}

/**
 * Server Action com contexto Hono
 *
 * Se precisar acessar o contexto (user, request, etc),
 * use o helper getContext()
 */
export async function deleteUser(userId: string) {
  "use server";

  const { context } = await import("~/framework/server-context");
  const currentUser = context.get("user");

  // Verifica permissão
  if (!currentUser.permissions.includes("users.delete")) {
    throw new Error("Forbidden");
  }

  const { deleteUser: deleteUserRepo } = await import("~/modules/user/user.repository");
  await deleteUserRepo(userId);

  return { success: true };
}
```

### 9.3. Type Definitions

```typescript
// framework/types.ts

/**
 * Tipo genérico de Server Action
 */
export type ServerAction<TArgs extends any[] = any[], TReturn = any> =
  (...args: TArgs) => Promise<TReturn>;

/**
 * Contexto disponível para Server Actions
 */
export interface ServerActionContext {
  /**
   * Request original
   */
  request: Request;

  /**
   * Contexto Hono (dados injetados por middlewares)
   */
  context: Context;

  /**
   * Headers da request
   */
  headers: Headers;
}

/**
 * Helper para acessar contexto dentro de Server Action
 */
export function getContext(): ServerActionContext;
```

### 9.4. Rotas Geradas pelo Builder

Para cada Server Action encontrada, o builder gera uma **rota POST** no Hono.

#### Exemplo de Entrada

```typescript
// app/admin/users/page.tsx

export async function createUser(name: string, email: string) {
  "use server";
  // ... implementação
}

export async function deleteUser(userId: string) {
  "use server";
  // ... implementação
}
```

#### Saída Gerada

```typescript
// .velojs/server-routes.ts

import { Hono } from "hono";

const app = new Hono();

// Rota gerada automaticamente
app.post(
  "/api/admin/users/createUser",  // ← Path automático baseado no file
  authMiddleware,  // ← Middlewares da rota page.tsx
  async (c) => {
    const { createUser } = await import("../app/admin/users/page.server.js");

    // Parse dos argumentos
    const { args } = await c.req.json();

    // Executa action com argumentos
    const result = await createUser(...args);

    return c.json(result);
  }
);

app.post(
  "/api/admin/users/deleteUser",
  authMiddleware,
  async (c) => {
    const { deleteUser } = await import("../app/admin/users/page.server.js");
    const { args } = await c.req.json();
    const result = await deleteUser(...args);
    return c.json(result);
  }
);

export default app;
```

### 9.5. Hook useAction

```typescript
// hooks/useAction.ts
import { signal } from "@preact/signals";

/**
 * Hook para executar Server Actions
 *
 * @example
 * const [create, creating] = useAction(createUser);
 *
 * await create("João", "joao@email.com");
 */
export function useAction<T extends (...args: any) => any>(
  action: T
): [
  (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>>,
  { value: boolean }  // loading signal
] {
  const loading = signal(false);

  const execute = async (...args: Parameters<T>): Promise<Awaited<ReturnType<T>>> => {
    loading.value = true;

    try {
      // Extrai nome da action e path atual
      const actionName = action.name;
      const currentPath = window.location.pathname;

      // Monta URL da API
      // /admin/users → /api/admin/users/createUser
      const apiPath = `/api${currentPath}/${actionName}`;

      // Faz POST com argumentos
      const response = await fetch(apiPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Action failed");
      }

      const result = await response.json();
      return result;
    } finally {
      loading.value = false;
    }
  };

  return [execute, loading];
}
```

### 9.6. Integração com Loaders

Após executar uma action, você geralmente quer recarregar os dados da página.

```typescript
// app/admin/users/page.tsx

export async function loader({ context }: LoaderArgs) {
  const user = context.get("user");
  const { getUsers } = await import("~/modules/user/user.repository");
  const users = await getUsers({ companyId: user.companyId });
  return { users };
}

export async function createUser(name: string, email: string) {
  "use server";
  const { saveUser } = await import("~/modules/user/user.repository");
  return await saveUser({ name, email });
}

export default function UsersPage() {
  const { value: loaderData } = useLoaderData<typeof loader>();
  const [create, creating] = useAction(createUser);

  const handleCreate = async () => {
    await create("João", "joao@email.com");

    // Revalida dados do loader
    revalidate();
  };

  return (
    <div>
      <button onClick={handleCreate} disabled={creating.value}>
        {creating.value ? "Criando..." : "Criar"}
      </button>

      <ul>
        {loaderData.value?.users.map(user => (
          <li key={user.id}>{user.name}</li>
        ))}
      </ul>
    </div>
  );
}
```

### 9.7. Actions com Formulários

```typescript
// app/admin/users/page.tsx

export async function createUser(formData: FormData) {
  "use server";

  const name = formData.get("name") as string;
  const email = formData.get("email") as string;

  // Validação com Zod
  const { userSchema } = await import("~/modules/user/user.schema");
  const validated = userSchema.parse({ name, email });

  const { saveUser } = await import("~/modules/user/user.repository");
  return await saveUser(validated);
}

export default function UsersPage() {
  const [create, creating] = useAction(createUser);

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    const formData = new FormData(e.target as HTMLFormElement);
    create(formData);
    revalidate();
  };

  return (
    <form onSubmit={handleSubmit}>
      <input name="name" required />
      <input name="email" type="email" required />
      <button type="submit" disabled={creating.value}>
        {creating.value ? "Criando..." : "Criar"}
      </button>
    </form>
  );
}
```

### 9.8. Error Handling

```typescript
// app/admin/users/page.tsx

export async function createUser(name: string, email: string) {
  "use server";

  // Validação
  if (!name || !email) {
    throw new Error("Nome e email são obrigatórios");
  }

  // Verifica duplicação
  const { getUserByEmail } = await import("~/modules/user/user.repository");
  const existing = await getUserByEmail(email);

  if (existing) {
    throw new Error("Email já cadastrado");
  }

  const { saveUser } = await import("~/modules/user/user.repository");
  return await saveUser({ name, email });
}

// Component com tratamento de erro
export default function UsersPage() {
  const [create, creating] = useAction(createUser);
  const error = signal<string | null>(null);

  const handleCreate = async () => {
    try {
      error.value = null;
      await create("João", "joao@email.com");
      revalidate();
    } catch (err) {
      error.value = err.message;
    }
  };

  return (
    <div>
      {error.value && <p style={{ color: "red" }}>{error.value}</p>}

      <button onClick={handleCreate} disabled={creating.value}>
        Criar
      </button>
    </div>
  );
}
```

### 9.9. Múltiplas Actions na Mesma Página

```typescript
// app/admin/users/page.tsx

export async function createUser(name: string) {
  "use server";
  // ... implementação
}

export async function deleteUser(id: string) {
  "use server";
  // ... implementação
}

export async function updateUser(id: string, name: string) {
  "use server";
  // ... implementação
}

export default function UsersPage() {
  const [create, creating] = useAction(createUser);
  const [deleteAction, deleting] = useAction(deleteUser);
  const [update, updating] = useAction(updateUser);

  return (
    <div>
      <button onClick={() => create("João")}>Criar</button>
      <button onClick={() => deleteAction("123")}>Deletar</button>
      <button onClick={() => update("123", "João Silva")}>Atualizar</button>
    </div>
  );
}
```

### 9.10. Optimistic Updates

```typescript
// app/admin/users/page.tsx

export async function deleteUser(userId: string) {
  "use server";
  const { deleteUser: deleteRepo } = await import("~/modules/user/user.repository");
  await deleteRepo(userId);
  return { success: true };
}

export default function UsersPage() {
  const { value: loaderData } = useLoaderData<typeof loader>();
  const [deleteAction] = useAction(deleteUser);

  // Signal local para UI otimista
  const users = signal(loaderData.value?.users || []);

  const handleDelete = async (userId: string) => {
    // 1. Atualiza UI imediatamente (otimista)
    users.value = users.value.filter(u => u.id !== userId);

    try {
      // 2. Executa action no servidor
      await deleteAction(userId);

      // 3. Revalida para garantir sincronia
      revalidate();
    } catch (err) {
      // 4. Reverte UI em caso de erro
      users.value = loaderData.value?.users || [];
      alert("Erro ao deletar: " + err.message);
    }
  };

  return (
    <ul>
      {users.value.map(user => (
        <li key={user.id}>
          {user.name}
          <button onClick={() => handleDelete(user.id)}>Deletar</button>
        </li>
      ))}
    </ul>
  );
}
```

### 9.11. Autenticação e Middlewares

Server Actions **herdam os middlewares** da rota onde estão definidas.

```typescript
// routes.ts
route("/admin/users", "./admin/users/page.tsx", {
  middleware: [authMiddleware, requirePermission("users.manage")],
})

// app/admin/users/page.tsx
export async function createUser(name: string) {
  "use server";
  // ← authMiddleware e requirePermission JÁ executaram
  // ← context.get("user") está disponível

  const { context } = await import("~/framework/server-context");
  const currentUser = context.get("user");

  console.log("Action executada por:", currentUser.email);

  // ... resto da implementação
}
```

### 9.12. Fluxo Completo

```
1. User clica em botão
2. Component chama: create("João", "joao@email.com")
3. useAction:
   ├─ loading.value = true
   ├─ POST /api/admin/users/createUser
   └─ body: { args: ["João", "joao@email.com"] }
4. Hono:
   ├─ Executa middlewares (auth, etc)
   ├─ Importa createUser do .server.js
   ├─ Executa: createUser(...args)
   └─ Retorna: c.json(result)
5. useAction:
   ├─ Recebe response
   ├─ loading.value = false
   └─ Retorna result
6. Component:
   └─ Opcionalmente chama revalidate()
```

### 9.13. Code Splitting Automático

O builder garante que Server Actions **nunca vão pro bundle client**.

```typescript
// Original: app/admin/users/page.tsx

export async function createUser(name: string) {
  "use server";
  const bcrypt = require("bcrypt");  // ← Lib pesada
  // ... código server-only
}

export default function UsersPage() {
  return <div>...</div>;
}
```

```typescript
// Build gera:

// app/admin/users/page.server.js (server-only)
export async function createUser(name: string) {
  const bcrypt = require("bcrypt");  // ✅ Fica no server
  // ...
}

export async function loader() { ... }

// app/admin/users/page.client.js (client bundle)
export default function UsersPage() {
  return <div>...</div>;
}
// ✅ createUser NÃO está aqui!
```

### 9.14. Type Safety

```typescript
// app/admin/users/page.tsx

export async function createUser(name: string, email: string) {
  "use server";
  return { userId: "123", success: true };
}

// Component
export default function UsersPage() {
  const [create] = useAction(createUser);

  const handleCreate = async () => {
    // ✅ TypeScript infere tipos automaticamente
    const result = await create("João", "joao@email.com");

    // result.userId   ✅ string
    // result.success  ✅ boolean
    // result.foo      ❌ Error: Property 'foo' does not exist

    // ❌ Error: Expected 2 arguments, but got 1
    await create("João");

    // ❌ Error: Argument of type 'number' is not assignable to 'string'
    await create(123, "email");
  };

  return <button onClick={handleCreate}>Criar</button>;
}
```

### 9.15. Convenção action_* vs "use server"

VeloJS usa **convenção por nome** (`action_*`) ao invés de diretiva `"use server"`:

**Por quê?**
- ✅ Mais explícito no código
- ✅ Menos "mágico" que strings especiais
- ✅ Fácil de detectar no build (regex simples)
- ✅ Type-safe sem configuração extra

**Comparação:**
```typescript
// Next.js (use server)
export async function createUser(name: string) {
  "use server";
  // ...
}

// VeloJS (action_*)
export async function action_createUser(name: string) {
  // Sem diretiva necessária
  // ...
}
```

### 9.16. Comparação com React Router v7

| | React Router v7 | VeloJS |
|---|---|---|
| **Actions** | `export async function action()` | ❌ Recebe `{ request }`, precisa parsear FormData |
| **Server Actions** | ❌ Não suporta | ✅ Convenção `action_*` |
| **Chamada no Component** | `useFetcher().submit()` | `useAction(fn)` (mais simples) |
| **Type-safe** | ❌ Precisa castings | ✅ Inferido automaticamente |
| **Argumentos** | FormData ou JSON manual | ✅ Argumentos tipados diretamente |
| **Roteamento** | Manual (`action="/users"`) | ✅ Automático |
| **Code Splitting** | Manual | ✅ Automático (.server.js) |

**Vantagem**: Chamada de funções server-side **como se fossem client-side**, mas com execução no servidor!

---

## 10. Próximos Passos

Após finalizar as especificações de rotas, loaders e server actions, implementaremos:

1. **Vite Plugin** (implementação do builder)
2. **Hooks completos** (`useLoaderData`, `useAction`)
3. **Runtime helpers** (`getContext`, `renderPage`)

---

**Framework**: VeloJS
**Versão**: 1.0.0
**Data**: 2026-01-05
**Status**: Specification Complete
**Próximo**: Implementação do Vite Plugin
