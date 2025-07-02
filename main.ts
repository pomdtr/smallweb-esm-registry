import { EsmRegistry } from "./pkg/mod.ts";

const { SMALLWEB_DIR } = Deno.env.toObject()

export default new EsmRegistry({
    root: SMALLWEB_DIR
})
