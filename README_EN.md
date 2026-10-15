# CLIProxyAPI Provider for DeepSeek Harness

English | [简体中文](./README.md)

Adds a `CLIProxyAPI` model provider based on the OpenAI Responses API to DeepSeek Harness.

The plugin automatically retrieves the model list from CLIProxyAPI, so models do not need to be added or maintained manually.

The list comes from CLIProxyAPI's plain `GET /v1/models`. Each model's context window, output limit,
image input and reasoning levels are taken from the `context_length`, `top_provider.max_completion_tokens`,
`architecture` and `reasoning` fields; models whose declared outputs are not text (embeddings, rerank,
decisions, image generation) are skipped. Anything a model does not declare falls back to the plugin
defaults: text-only input and no reasoning. A CLIProxyAPI build that does not list these fields therefore
still works, but every model is treated as a text-only, non-reasoning model.

## Usage

This version targets DeepSeek Harness `0.2.0-rc.2`. Since 0.2 the configuration lives on each plugin
entry, so this plugin reads and writes the `providers` field of the `llm-pi-ai` entry through
`ctx.settings.describe()` / `ctx.settings.mutate()` and refreshes on `settings/document-updated`.
It no longer supports the 0.1.x line.

Install the plugin:

```powershell
npx @deepseek-ai/dsh plugin --profile web add github:router-for-me/dsh-cliproxyapi-provider
```

Start or restart DeepSeek Harness Web:

```powershell
npx @deepseek-ai/dsh web
```

After opening Harness:

1. Go to **Settings → Plugins → CLIProxyAPI**.
2. Enter the CLIProxyAPI **API URL**, for example
   `http://127.0.0.1:8317/v1`.
3. Enter the **API key**. Leave it empty if the service does not require authentication.
4. Save the configuration. The model list will be retrieved automatically and refreshed periodically.

Uninstall the plugin:

```powershell
npx @deepseek-ai/dsh plugin --profile web remove @router-for-me/dsh-cliproxyapi-provider
```

Restart DeepSeek Harness Web after uninstalling the plugin.
