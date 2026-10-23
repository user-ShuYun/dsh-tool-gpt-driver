# dsh-tool-gpt-driver

把「接管浏览器里的 ChatGPT」做成 DSH 插件的五个工具。

它解决的是**串图问题**：浏览器里的模型一份要画 1~3 分钟，如果你连发几条，
提示词会排队、旧图会重渲染（blob URL 每次都变），结果就是"海口鱼画成奇虾"。
这个插件把纪律写进代码：**单通道 + 基线 + 哈希**。

## 工具

| 工具 | 作用 | 关键约束 |
|---|---|---|
| `gpt_status` | 页面状态：在不在生成、几张图、输入框是否可用 | 只读 |
| `gpt_send` | 发**一条**提示词 | 页面在生成 / 已有请求在途 → 直接报错，不排队 |
| `gpt_wait_image` | 等这条画完并取回原图 | 停止按钮消失 **且** 张数 > 基线；返回 sha256，命中 `knownHashes` 判重复 |
| `gpt_ask` | 问一条文字问题，等回答稳定 | 复用同一条单通道 |
| `gpt_export_latest` | 立刻取回最新一张图 | 补取用，不等待 |

## 前置

浏览器必须以调试端口启动并已登录：

```powershell
msedge.exe --remote-debugging-port=9222 --user-data-dir=D:\deepseek\edge-cgpt https://chatgpt.com/
```

插件只连 `127.0.0.1:9222`，不碰账号密码。

## 安装

```powershell
dsh plugin --profile web add D:\deepseek\dsh-gpt-driver
```

或者手动（等于 `pnpm add file:`）：

1. 把本目录复制到 `%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-tool-gpt-driver`；
2. 在 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` 里加：

```yaml
- insert:
    - id: dsh-tool-gpt-driver
      name: dsh-tool-gpt-driver
      config:
        port: 9222
        minWidth: 1000
```

3. 重启 DSH。

## 典型用法（出图流水线）

```text
gpt_status        → busy=false, images=7
gpt_send          → baseline=7
gpt_wait_image    → out.png, sha256=…, seconds=96
（哈希和已有素材重复就报错，不会写脏数据）
```

## 测试

```powershell
node test/shape.mjs     # 不联网：确认 5 个工具都注册、字段完整
node test/smoke.mjs     # 只读：连上浏览器读页面状态（不发提示词）
```

## 已知限制

- 需要浏览器保持登录且窗口存在（headless 也能用，但登录态要预热）；
- 模型可以手动在页面里切换，插件不感知模型名；
- 页面 DOM 变了（按钮 aria-label）可能要跟着改 `cdp.js` 里的选择器。
