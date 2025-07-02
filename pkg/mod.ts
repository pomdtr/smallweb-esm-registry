import { Hono } from "npm:hono"
import { trimTrailingSlash } from 'npm:hono/trailing-slash'
import { HTTPException } from "npm:hono/http-exception"

import * as path from "jsr:@std/path"
import fs from "node:fs/promises"
import { ImportRewriter } from "./imports.ts"

import * as git from 'npm:isomorphic-git@1.32.1'
import * as jsonc from "jsr:@std/jsonc";

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
    const entry = await git.readTree({ fs, dir, oid: tree }).then(({ tree }) => {
        // Recursively walk the tree to find the entry
        for (const node of tree) {
            if (node.path === filepath) {
                return node
            }
        }
        throw new Error('File not found in tree')
    })

    // Step 3: Read the blob
    const { blob } = await git.readBlob({ fs, dir, oid: entry.oid })

    // Step 4: Convert blob to string
    return new TextDecoder().decode(blob)
}

