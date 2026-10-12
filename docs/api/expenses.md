# Expenses API

## List, get, create, update, delete

```
GET    /api/v1/expenses
GET    /api/v1/expenses/:id
POST   /api/v1/expenses
PUT    /api/v1/expenses/:id
DELETE /api/v1/expenses/:id
```

List rows carry `has_receipt` (`1` when a receipt file is attached).
`GET /api/v1/expenses/:id` also returns a `receipt` object (or `null`):

```json
{
  "id": "9c1e...",
  "vendor": "Cafe",
  "expense_date": "2026-05-01",
  "total": 12,
  "receipt_reference": "lunch.jpg",
  "has_receipt": 1,
  "receipt": {
    "file_name": "lunch.jpg",
    "content_type": "image/jpeg",
    "size": 482113,
    "created_at": "2026-05-01 12:00:00"
  }
}
```

On `PUT`, leaving `receipt_reference` out of the body keeps the stored value;
an empty string clears it. Deleting an expense also deletes its receipt file.

## Receipt file

Each expense can hold one receipt: a JPEG, PNG, HEIC photo or a PDF, up to
10 MB. The file is stored in the database, so it is part of every database
backup (it is not included in the JSON export). Servers that support this
report `features.receipt_upload: true` in `GET /api/v1/public/config`.

### Upload or replace

```
POST /api/v1/expenses/:id/receipt
Content-Type: multipart/form-data
```

| Field | Description |
|-------|-------------|
| `file` | The receipt file (`receipt` is accepted as an alias) |

The file type is detected from its contents, not from the declared
Content-Type or the file name, so a HEIC photo sent as
`application/octet-stream` is accepted and an HTML file named `.png` is not.
Uploading again replaces the previous file. `receipt_reference` is set to the
uploaded file name.

**Response (201):** the expense, as returned by `GET /api/v1/expenses/:id`,
with the new `receipt` object.

| Status | When |
|--------|------|
| `400` | No file, empty file, not multipart, or not JPEG/PNG/HEIC/PDF |
| `404` | Expense not found |
| `413` | File larger than 10 MB |

### Download

```
GET /api/v1/expenses/:id/receipt
GET /api/v1/expenses/:id/receipt?download=1
```

Returns the file bytes with its `Content-Type` and
`Content-Disposition: inline` (or `attachment` with `?download=1`). `404` when
the expense has no receipt.

### Delete

```
DELETE /api/v1/expenses/:id/receipt
```

**Response (200):** the expense, with `receipt: null`. `receipt_reference` is
cleared when it still names the uploaded file; a reference typed in by hand is
kept. `404` when there is no receipt.

API tokens need `expenses:write` to upload or delete and `expenses:read` to
download.
