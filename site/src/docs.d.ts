declare module "virtual:docs-manifest" {
    interface DocEntry {
        slug: string;
        title: string;
        order: number;
        filename: string;
    }
    const manifest: DocEntry[];
    export default manifest;
}

declare module "virtual:docs-content" {
    const content: Record<string, { html: string; rawMd: string }>;
    export default content;
}
