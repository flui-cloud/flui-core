# Flui branding assets

Assets uploaded to the OIDC provider at bootstrap by `OidcIdentityBranding`. They are applied to the org `LabelPolicy` and activated on the hosted login page.

## Required files

File names are **fixed** — the uploader looks them up by exact path.

| File             | Where it shows up                                                       | Format              | Recommended size       | Background  | Notes                                                                                             |
| ---------------- | ----------------------------------------------------------------------- | ------------------- | ---------------------- | ----------- | ------------------------------------------------------------------------------------------------- |
| `logo-light.png` | Large logo above the login form (light theme)                           | PNG, 24-bit + alpha | 280 × 80 px (≤ 200 KB) | Transparent | Designed for light background (`#F6F7F9`). Bake in any padding you want — the provider adds none. |
| `logo-dark.png`  | Large logo above the login form (dark theme)                            | PNG, 24-bit + alpha | 280 × 80 px (≤ 200 KB) | Transparent | Light/positive variant for dark background (`#080B11`).                                           |
| `icon-light.png` | Browser tab favicon + small icon in some provider screens (light theme) | Square PNG          | 192 × 192 px (≤ 50 KB) | Transparent | Compact mark. Must stay legible at 16 × 16 px.                                                    |
| `icon-dark.png`  | Favicon + small icon (dark theme)                                       | Square PNG          | 192 × 192 px (≤ 50 KB) | Transparent | Dark-theme variant.                                                                               |

> **`favicon.ico`**: not uploaded. The provider derives the browser favicon from `icon-light.png`. You can keep it in this folder for other consumers (e.g. flui.web standalone), but the bootstrap ignores it.

## Provider constraints

- Upload routes (Zitadel v4.15.0, `internal/api/assets/generator/asset.yaml`): `POST /assets/v1/org/policy/label/{logo,icon}` and `.../dark`, multipart field `file`, images only, 512 KB max.
- The provider answers an upload with 404 (`Errors.Org.LabelPolicy.NotFound`) while the organisation has no custom label policy, so the policy is written first, then the assets, then it is activated.
- Missing files are skipped with a warning; they don't fail the bootstrap.

## How they get published

1. At OIDC provider bootstrap, at every API start, or via `POST /auth/branding/resync`, `OidcIdentityBranding` hashes all present bytes plus the colors and compares it against the `flui-branding-version` value stored in org metadata. If it differs it writes the label policy, uploads every asset and activates the policy.
2. The version is recorded only when every step succeeded, so a failed pass is retried at the next start.

## Colors

Aligned with the dashboard theme (`flui-dashboard/src/styles.scss`). Overridable via env:

```
FLUI_BRANDING_PRIMARY_COLOR        # default #225AF1
FLUI_BRANDING_PRIMARY_COLOR_DARK   # default #3369FF
FLUI_BRANDING_BG_COLOR             # default #F6F7F9
FLUI_BRANDING_BG_COLOR_DARK        # default #080B11
FLUI_BRANDING_WARN_COLOR           # default #DC2828
FLUI_BRANDING_WARN_COLOR_DARK      # default #F04242
FLUI_BRANDING_FONT_COLOR           # default #191B1F
FLUI_BRANDING_FONT_COLOR_DARK      # default #E5E9F0
```

`disableWatermark` (the "powered by" footer) and `hideLoginNameSuffix` (the `@organisation` suffix on login names) are forced to `true`.
