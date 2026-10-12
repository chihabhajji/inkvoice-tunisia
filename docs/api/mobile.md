# Mobile App

The Inkvoice mobile app signs in with a **device session**: an opaque bearer token
created by a password sign-in. It works against any server that reports
`auth.device_sessions: true` in its public config.

## Server info

```
GET /api/v1/public/config
```

No authentication. Besides the fields the web login page uses, it reports:

```json
{
  "success": true,
  "data": {
    "demo_mode": false,
    "demo_credentials": null,
    "oidc_enabled": false,
    "oidc_provider_name": null,
    "server": { "version": "0.4.0", "api_level": 1 },
    "auth": {
      "password": true,
      "device_sessions": true,
      "oidc": { "enabled": false, "label": null, "mobile": false },
      "oauth": []
    },
    "features": {
      "push": false,
      "attachments": false,
      "idempotency": false,
      "receipt_upload": true,
      "partial_share_links": true
    },
    "mobile": { "min_app_version": null }
  }
}
```

| Field | Meaning |
|-------|---------|
| `server.version` | The server's release version |
| `server.api_level` | API contract level the app checks for compatibility (currently `1`) |
| `auth.oidc` | Whether SSO is configured, its button label, and whether the app can use it (`mobile`) |
| `auth.oauth` | Extra sign-in providers a deployment adds (empty on a self-hosted server) |
| `features` | Optional server features the app can turn on |
| `features.receipt_upload` | Expense receipts can be uploaded, fetched and deleted ([Expenses](/api/expenses#receipt-file)) |
| `features.partial_share_links` | Partly paid invoices can be published and their share links keep working ([Invoices](/api/invoices#publish)) |
| `mobile.min_app_version` | Oldest app version the server accepts, or `null` |

A deployment can add fields with `setPublicConfigExtender(fn)` from
`routes/public.ts`; `fn` receives the data object and returns the extended one.

## Sign in

```
POST /api/v1/auth/device-sessions
```

```json
{
  "username": "admin",
  "password": "your-password",
  "device": {
    "name": "Baris's iPhone",
    "platform": "ios",
    "model": "iPhone 17",
    "os_version": "27.0",
    "app_version": "1.0.0"
  }
}
```

`device.name` (up to 100 characters) and `device.platform` (`ios` or `android`)
are required. Shares the login rate limit with `/auth/login` and never sets a
cookie.

**Response (201):**

```json
{
  "success": true,
  "data": {
    "token": "ink_dev_...",
    "session": {
      "id": "3f2a...",
      "name": "Baris's iPhone",
      "platform": "ios",
      "model": "iPhone 17",
      "os_version": "27.0",
      "app_version": "1.0.0",
      "created_at": "2026-10-11T09:00:00.000Z",
      "last_seen_at": "2026-10-11T09:00:00.000Z",
      "expires_at": "2027-01-09T09:00:00.000Z"
    },
    "user": {
      "id": "abc123",
      "username": "admin",
      "email": "admin@example.com",
      "display_name": "Admin",
      "is_admin": true,
      "role": "Owner",
      "permissions": []
    }
  }
}
```

The token is shown only once; the server stores only its SHA-256 hash. Wrong
password and unknown user both return `401` with
`{ "success": false, "error": "Invalid credentials", "code": "INVALID_CREDENTIALS" }`.
Validation errors return `400`.

Send the token on every request:

```
Authorization: Bearer ink_dev_...
```

A device session acts as its user (no API token scopes apply). It expires
after `DEVICE_SESSION_IDLE_DAYS` (default 90) days without use; each use
extends it. It stops working at once when revoked, when the user is
deactivated, or when the user resets their password.

## List my devices

```
GET /api/v1/auth/device-sessions
```

Returns the caller's active sessions, most recently used first. Each item has
the `session` fields above plus `current: true` for the session making the
request.

## Sign out

```
DELETE /api/v1/auth/device-sessions/current
DELETE /api/v1/auth/device-sessions/:id
```

`current` revokes the session used for the request (`400` if the request is not
using a device session). `:id` revokes one of the caller's own sessions (`404`
otherwise). Both return `{ "success": true }`.

## Admin: sign a user out everywhere

```
DELETE /api/v1/users/:id/device-sessions
```

Admin only. Revokes every device session of that user and returns
`{ "success": true }` (`404` for an unknown user).
