# CLIProxyAPI Provider for DeepSeek Harness

[English](./README_EN.md) | 简体中文

为 DeepSeek Harness 添加一个基于 OpenAI Responses API 的 `CLIProxyAPI` 模型供应商。

插件会自动从 CLIProxyAPI 获取模型列表，无需手动添加或维护模型。

模型列表来自 CLIProxyAPI 的普通 `GET /v1/models`。每个模型的上下文长度、输出上限、图片输入和思考档位分别取自
`context_length`、`top_provider.max_completion_tokens`、`architecture` 和 `reasoning` 字段；声明的输出
不含文本的模型（embeddings、rerank、decisions、图片生成）会被跳过。模型没声明的信息按插件默认值处理：只接受
文本输入、不思考。所以不输出这些字段的 CLIProxyAPI 版本仍然能用，但所有模型都会被当作纯文本、不思考的模型。

## 使用方式

当前版本适配 DeepSeek Harness `0.2.0-rc.2` 与 `0.2.1`（含 `0.2.1-rc.*`）。0.2 起设置按插件条目（profile entry）保存，本插件通过
`ctx.settings.describe()` / `ctx.settings.mutate()` 读写 `llm-pi-ai` 条目的 `providers`，并跟随
`settings/document-updated` 事件刷新；不再兼容 0.1.x。

安装插件：

```powershell
npx @deepseek-ai/dsh plugin --profile web add github:router-for-me/dsh-cliproxyapi-provider
```

启动或重启 DeepSeek Harness Web：

```powershell
npx @deepseek-ai/dsh web
```

打开 Harness 后：

1. 进入 **设置 → 插件 → CLIProxyAPI**。
2. 填写 CLIProxyAPI 的 **API 地址**，例如
   `http://127.0.0.1:8317/v1`。
3. 填写 **API 密钥**；无鉴权服务可以留空。
4. 保存配置，模型列表会自动获取并定期刷新。

卸载插件：

```powershell
npx @deepseek-ai/dsh plugin --profile web remove @router-for-me/dsh-cliproxyapi-provider
```

卸载后重启 DeepSeek Harness Web 即可。
