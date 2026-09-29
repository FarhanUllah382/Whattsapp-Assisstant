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
