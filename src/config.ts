export interface VeloConfig {
    /**
     * Diretório base da aplicação onde estão as rotas
     * @default "./app"
     */
    appDirectory?: string;

    /**
     * Arquivo de rotas com export default AppRoutes
     * @default "routes.tsx"
     */
    routesFile?: string;

    /**
     * Arquivo de inicialização do servidor (custom init, sem velojs imports)
     * @default "server.tsx"
     */
    serverInit?: string;

    /**
     * Arquivo de inicialização do cliente (custom init, sem velojs imports)
     * @default "client.tsx"
     */
    clientInit?: string;

    /**
     * Porta usada tanto pelo dev server quanto pelo servidor de produção.
     * A env `PORT` (injetada pela maioria dos hosts) sempre tem precedência.
     * @default 3000
     */
    port?: number;

    /**
     * Interface de bind do servidor de produção. A env `HOST` tem precedência.
     * Default do Node: todas as interfaces (o que Docker/cloud esperam).
     * Apps locais/sensíveis devem declarar "127.0.0.1".
     */
    hostname?: string;

    /**
     * Padrões adicionais de URL que o dev server deve delegar ao Vite em vez
     * de interceptar como página (ex.: artefatos de geradores build-time como
     * Panda CSS — "/styled-system/**"). Compostos com os defaults do
     * @hono/vite-dev-server, não os substituem.
     */
    devServerExclude?: (string | RegExp)[];
}

export function defineConfig(config: VeloConfig): VeloConfig {
    return config;
}
