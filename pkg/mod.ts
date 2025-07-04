import { contentType } from "@std/media-types"
import * as jsonc from "@std/jsonc"
import * as path from "@std/path"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { trimTrailingSlash } from "hono/trailing-slash"
import * as git from "isomorphic-git"
import fs from "node:fs/promises"

import { ImportRewriter } from "./imports.ts"

export type RegistryOptions = {
    root: string
}

type DenoConfig = {
    exports?: string | Record<string, string>
    imports?: Record<string, string>
}

export class Registry {
    private server

    constructor(opts: RegistryOptions) {
        this.server = createServer(opts);
    }

    fetch: (req: Request) => Response | Promise<Response> = (req) => {
        return this.server.fetch(req);
    }
}


function createServer(opts: RegistryOptions) {
    const app = new Hono()

    app.get("/", (c) => {
        const url = new URL(c.req.url)
        return c.text(`Usage: ${url.origin}/{app}@{ref}/{filepath}`);
    })

    app.use(trimTrailingSlash())
    app.get("/:app", async (c) => {
        const params = c.req.param()
        let app: string, ref: string
        if (params.app.includes("@")) {
            [app, ref] = params.app.split("@")
        } else {
            app = params.app
            ref = "HEAD"
        }

        const dir = path.join(opts.root, app)
        let oid: string
        try {
            oid = await git.resolveRef({ fs, dir, ref })
        } catch (_e) {
            oid = await git.expandOid({ fs, dir, oid: ref })
        }

        const config = await getConfig({ dir, oid })
        if (config.exports) {
            if (typeof config.exports === "string") {
                return c.redirect(path.join("/", `${app}@${oid.slice(0, 7)}`, config.exports));
            }

            if ("." in config.exports) {
                return c.redirect(path.join("/", `${app}@${oid.slice(0, 7)}`, config.exports["."]));
            }
        }

        const entrypoints = ["mod.js", "mod.ts", "mod.jsx", "mod.tsx", "main.js", "main.ts", "main.jsx", "main.tsx"]
        for (const mainFile of entrypoints) {
            try {
                await findEntryInTree({ dir, fs, oid, filepathParts: [mainFile] })
                return c.redirect(path.join("/", `${app}@${oid.slice(0, 7)}`, mainFile));
            } catch (_e) {
                continue
            }
        }

        throw new HTTPException(404, { message: `No default export found for ${app} at ${ref}` })
    })


    app.get("/:app/:filepath{.+}", async (c) => {
        const params = c.req.param()
        let app: string, ref: string
        if (params.app.includes("@")) {
            [app, ref] = params.app.split("@")
        } else {
            app = params.app
            ref = "HEAD"
        }

        const dir = path.join(opts.root, app)
        let oid: string
        try {
            oid = await git.resolveRef({ fs, dir, ref })
        } catch (_e) {
            oid = await git.expandOid({ fs, dir, oid: ref })
        }

        if (!oid.startsWith(ref)) {
            return c.redirect(`/${app}@${oid.slice(0, 7)}/${params.filepath}`)
        }

        const config = await getConfig({ dir, oid })
        if (config.exports && typeof config.exports === "object") {
            const key = `./${params.filepath}`
            if (key in config.exports) {
                return c.redirect(path.join("/", `${app}@${oid.slice(0, 7)}`, config.exports[key]));
            }
        }
        const blob = await getFileContentAtCommit({
            dir,
            oid,
            filepath: params.filepath
        })


        const extname = path.extname(params.filepath)
        if ([".js", ".ts", ".jsx", ".tsx"].includes(extname)) {
            const code = new TextDecoder().decode(blob)
            const rewriter = new ImportRewriter(config.imports || {})
            return c.text(rewriter.rewriteImports(code, params.filepath))
        }

        return c.body(blob, {
            headers: {
                "Content-Type": contentType(extname) || "application/octet-stream",
            }
        })
    })

    app.onError((err, c) => {
        console.error('Error occurred:', err)

        // Set appropriate status code and response
        return c.json({
            success: false,
            message: err.message || 'Internal Server Error',
            status: 500
        }, 500)
    })

    return app
}

async function getConfig({ dir, oid }: { dir: string, oid: string }): Promise<DenoConfig> {
    for (const filepath of ["deno.json", "deno.jsonc"]) {
        try {
            const blob = await getFileContentAtCommit({ dir, oid, filepath })

            const text = new TextDecoder().decode(blob)
            const manifest = await jsonc.parse(text)
            return manifest as DenoConfig
        } catch (_e) {
            continue
        }
    }

    return {}
}

async function getFileContentAtCommit({ dir, oid, filepath }: { dir: string, oid: string, filepath: string }) {
    // Step 1: Resolve the commit object

    const commit = await git.readCommit({ fs, dir, oid })

    // Step 2: Find the tree entry for the file
    const { tree } = commit.commit
    // Helper function to walk the tree recursively

    const filepathParts = filepath.split('/')
    const entry = await findEntryInTree({ fs, dir, oid: tree, filepathParts })

    // Step 3: Read the blob
    const { blob } = await git.readBlob({ fs, dir, oid: entry.oid })

    return blob
}

async function findEntryInTree({ fs, dir, oid, filepathParts }: { fs: git.FsClient, dir: string, oid: string, filepathParts: string[] }) {
    const { tree } = await git.readTree({ fs, dir, oid })
    const [current, ...rest] = filepathParts
    for (const node of tree) {
        if (node.path === current) {
            if (rest.length === 0) {
                return node
            }
            if (node.type === 'tree') {
                return findEntryInTree({ fs, dir, oid: node.oid, filepathParts: rest })
            }
        }
    }
    throw new Error('File not found in tree')
}
