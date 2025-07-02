import { Hono } from "hono"
import { trimTrailingSlash } from 'hono/trailing-slash'
import { HTTPException } from "hono/http-exception"


import * as path from "@std/path"
import fs from "node:fs/promises"
import { ImportRewriter } from "./imports.ts"

import * as git from 'isomorphic-git'
import * as jsonc from "@std/jsonc";

export type EsmRegistryOptions = {
    root: string
}

type DenoConfig = {
    exports?: string | Record<string, string>
    imports?: Record<string, string>
}

export class EsmRegistry {
    private server

    constructor(opts: EsmRegistryOptions) {
        this.server = createServer(opts);
    }

    fetch: (req: Request) => Response | Promise<Response> = (req) => {
        return this.server.fetch(req);
    }
}


function createServer(opts: EsmRegistryOptions) {
    const app = new Hono()

    app.get("/", (c) => {
        return c.text("Usage: /{app}@{ref}/{filepath}");
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
        if (!config.exports) {
            throw new HTTPException(404, { message: `No exports found for ${app} at ${ref}` })
        }

        if (typeof config.exports === "string") {
            return c.redirect(path.join("/", `${app}@${oid.slice(0, 7)}`, config.exports));
        }

        if ("." in config.exports) {
            return c.redirect(path.join("/", `${app}@${oid.slice(0, 7)}`, config.exports["."]));
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

        const rewriter = new ImportRewriter(config.imports || {})
        const code = await getFileContentAtCommit({
            dir,
            oid,
            filepath: params.filepath
        })

        return c.text(rewriter.rewriteImports(code, params.filepath))
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
    for (const manifestPath of ["deno.json", "deno.jsonc"]) {
        try {
            const manifestText = await getFileContentAtCommit({ dir, oid, filepath: manifestPath })

            const manifest = await jsonc.parse(manifestText)
            return manifest as DenoConfig
        } catch (_e) {
            continue
        }
    }

    return {}
}

async function getFileContentAtCommit({ dir, oid, filepath }: { dir: string, oid: string, filepath: string }): Promise<string> {
    // Step 1: Resolve the commit object

    const commit = await git.readCommit({ fs, dir, oid })

    // Step 2: Find the tree entry for the file
    const { tree } = commit.commit
    // Helper function to walk the tree recursively

    const filepathParts = filepath.split('/')
    const entry = await findEntryInTree({ fs, dir, oid: tree, filepathParts })

    // Step 3: Read the blob
    const { blob } = await git.readBlob({ fs, dir, oid: entry.oid })

    // Step 4: Convert blob to string
    return new TextDecoder().decode(blob)
}

async function findEntryInTree({ fs, dir, oid, filepathParts }: { fs: any, dir: string, oid: string, filepathParts: string[] }): Promise<any> {
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
