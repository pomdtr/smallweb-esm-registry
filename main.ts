import { Registry } from "./pkg/mod.ts";

const { SMALLWEB_DIR } = Deno.env.toObject()

export default new Registry({
    root: SMALLWEB_DIR
})
