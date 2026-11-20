# TypeScript API client types

`schema.d.ts` is generated from [`docs/openapi.yaml`](../../docs/openapi.yaml)
by [openapi-typescript](https://openapi-ts.dev/). Don't edit it by hand:
change the spec, then run

```bash
npm run gen:client
```

and commit both files. CI regenerates the file and fails if the committed copy
differs, so the types can't fall behind the spec.

## Using it from escrow-frontend

Vendor (copy) `schema.d.ts` into the frontend and pair it with
[openapi-fetch](https://openapi-ts.dev/openapi-fetch/):

```ts
import createClient from "openapi-fetch";
import type { paths } from "./escrow-backend-schema";

const api = createClient<paths>({ baseUrl: process.env.NEXT_PUBLIC_API_URL });
const { data, error } = await api.GET("/api/jobs/{contractId}", {
  params: { path: { contractId } },
});
```

Paths, path/query parameters, request bodies and documented response bodies
are all typed from the spec. Response shapes the spec doesn't describe yet
come out as `never`/`Record<string, never>`; fix those in `openapi.yaml`, not
here.
