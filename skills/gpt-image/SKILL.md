---
name: gpt-image
description: Generate and edit images with the gpt-image CLI using OpenAI GPT Image. Use for local GPT image generation, reference-based edits, masks, transparent cutouts, and saving generated assets to disk. This skill operates the CLI; it is not for implementing an image-generation application.
---

# GPT Image CLI

Use the `gpt-image` CLI to produce the image the user requested and return its local path. Node.js 22+ is required. The default model is `gpt-image-2.6-flare`; quality defaults to the API's `auto`. Preserve these defaults unless the user chooses different settings.

## Find the CLI and configuration

Use an installed `gpt-image` command when available. Otherwise run the released CLI directly from the public repository with npm:

```sh
npx --yes --package=github:zsio/openai-image-cli#v1.0.0 gpt-image --help
```

Use the same prefix in place of `gpt-image` in subsequent examples. This also works when the skill was installed on a machine without a separate CLI installation. It does not require a checkout or a machine-specific path.

Check configuration with `gpt-image config show`. Only `OPENAI_API_KEY` is required; size, model, quality, format and output location all have defaults. The CLI reads environment variables first, then the user config at `${XDG_CONFIG_HOME:-$HOME/.config}/gpt-image/.env`. `gpt-image config path` prints the resolved path. Honor an explicitly selected `--config` or `GPT_IMAGE_CONFIG`.

If no key is configured, run `gpt-image config init` if needed and tell the user to fill `OPENAI_API_KEY` in that local file. Keep the key outside source repositories and skill files; do not ask them to paste it into chat, print it, or put it in command arguments. Check presence using `config show`, never by displaying the config file. Do not generate a sample image just to check configuration; use `--dry-run` for a request preview.

## Generate or edit

For a new image, pass the prompt as a single argument. For long or multiline prompts, write a UTF-8 prompt file and use `--prompt-file`.

```sh
gpt-image generate "A watercolor kitten wearing a red scarf" --name kitten --json

gpt-image generate --prompt-file ./prompt.txt --out-dir ./assets --name cover --json
```

For edits or reference-based generation, use `edit` and repeat `--image` for multiple references. Input order matters: the first image is the primary image for a mask or markup layer.

```sh
gpt-image edit "Change the background to snowy mountains; preserve the person's face and clothing" \
  --image ./portrait.png --name snowy-portrait --json

gpt-image edit "Place both products in one white-background product photo" \
  --image ./product-a.png --image ./product-b.jpg --name product-pair --json

gpt-image edit "Replace the transparent masked region with a blue vase" \
  --image ./room.png --mask ./mask.png --name blue-vase --json
```

Use `--background transparent --format png` for a transparent cutout or sticker. For edits to an existing transparent asset, preserve transparency when that is part of the request. `--mask` and `--markup` take PNG files and cannot be combined; their dimensions must match the first image. Up to 16 reference images are supported, including local PNG/JPEG/WebP, image URLs and OpenAI file IDs.

The prompt should preserve the user's subject, exact requested text, style and constraints. For an edit, state both the desired change and the details to preserve. Do not silently change the requested image count, model or quality. Each CLI invocation generates one final image; retries are disabled, so inspect failures before deciding whether another billable request is warranted.

## Output and useful options

- Default output is a unique `name-YYYYMMDD-HHmmss-SSS-suffix` folder in the system temp directory. Use `--name` for a useful short filename.
- Use `--output FILE` for an exact file path, or `--out-dir DIR --name NAME` for a destination directory. These alternatives cannot be combined. Existing output files are preserved.
- Use `--json` to read `image_path`, `metadata_path`, `prompt_path`, `request_id` and API usage. Progress goes to stderr. Return the actual saved image path; preview the image with an available local image viewer when useful.
- `--size WIDTHxHEIGHT`, `--quality auto|low|medium|high|xhigh|max`, `--background auto|opaque|transparent`, and `--format png|jpeg|webp|gif|svg` map to API settings. Model/project support still applies.
- Use `--model gpt-image-2.6-sunburst` when the user chooses the branch intended for detailed visual work. Keep Flare for ordinary requests without a model preference.
- `--stream --partial-images 1` saves a preview plus the final image. Only the completed image is the final result.
- `--params '{"complexity":"medium"}'` or `--params @params.json` passes additional API fields. `n` remains fixed at 1. Read `gpt-image --help` before using uncommon options.
- `--timeout SECONDS` covers the full request. On timeout/cancellation, the service may already have accepted the request. Do not automatically resubmit.

CLI and API details: https://github.com/zsio/openai-image-cli
