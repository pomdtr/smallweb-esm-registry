# ESM Registry for Smallweb

## Installation

To install the ESM Registry, you'll first need to create a single file in your smallweb directory.

```ts
// $SMALLWEB_DIR/esm/main.ts
import { Registry } from '@smallweb/esm'

const { SMALLWEB_DIR } = Deno.env.toObject()

const registry = new Registry({
  root: SMALLWEB_DIR
})

export default registry
```

Then add admin permission to the `esm` app by modifying the global configuration file:

```jsonc
// $SMALLWEB_DIR/.smallweb/config.json
{
    "apps": {
        "esm": {
            "admin": true
        }
    }
}
```

## Usage

To add one app to the registry, just run `git init -b main` in the app directory, then commit your files. The ESM Registry will automatically discover the app and make it available at `https://esm.<your-domain>/<app-name>`.

Each revision of a file will be available at `https://esm.<your-domain>/<app-name>@<commit-hash>/<file-path>`.

`@smallweb/esm` automatically resolves the `imports` / `exports` fields from your `deno.json` file, so you can keep your app's dependencies organized.
