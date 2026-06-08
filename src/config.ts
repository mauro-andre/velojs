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
}

export function defineConfig(config: VeloConfig): VeloConfig {
    return config;
}
