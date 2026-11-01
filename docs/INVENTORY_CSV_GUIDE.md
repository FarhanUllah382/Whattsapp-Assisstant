# Inventory CSV onboarding

The importer previews by default and changes the database only when `--apply`
is supplied. It validates every row before starting one transaction, so one
bad row rejects the complete file rather than partially updating inventory.

Required columns, in any order:

| Column | Rule |
|---|---|
| `sku` | Stable 2–64 character identifier using letters, numbers, `.`, `_`, or `-`; compared case-insensitively. |
| `name` | Customer-facing product name. |
| `category` | Product category used for catalog reconciliation. |
| `size` | Optional; `S`, `M`, `L`, `XL` and common equivalents normalize automatically. |
| `color` | Optional color name. |
| `price` | Rupees with at most two decimal places; stored as integer paisas. |
| `stock` | Non-negative whole number. |
| `active` | `true/false`, `yes/no`, `1/0`, or `active/inactive`. |
| `aliases` | Optional `|`-separated search names, for example `shirt|casual tee`. |
| `image_filename` | Optional approved `.png`, `.jpg`, or `.jpeg` basename from `assets/product-images`; paths and URLs are rejected. Size-only variants may share one image. |

Start from `docs/examples/inventory.example.csv`, then preview:

```text
npx tsx scripts/import-inventory.ts path/to/inventory.csv
```

Review inserted/updated counts and the reconciliation report. Apply only after
the business owner approves the file:

```text
npx tsx scripts/import-inventory.ts path/to/inventory.csv --apply
```

Re-importing the same SKU updates that product in place, preserving its ID and
historical order references. Products are discontinued with `active=false`;
they are not deleted. Rows absent from a later CSV are deliberately left
unchanged, preventing an incomplete file from silently deactivating products.

Product images are controlled by the server, not by the AI model. Put only
owner-approved catalog images in `assets/product-images`, then reference their
filename in the CSV. The assistant can send at most three image cards in one
reply. Each caption is generated from the database price, variants, and public
availability status so the model cannot invent or alter those details.
