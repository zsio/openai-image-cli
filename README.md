# gpt-image

在本地直接调用 OpenAI Images API 的 CLI。每次请求固定生成一张最终图片，支持文生图、参考图编辑、蒙版、标注层、流式预览和官方参数透传。

默认模型是 `gpt-image-2.6-flare`，可通过配置或 `--model` 指定模型 ID。接口使用 `POST /v1/images/generations` 和 `POST /v1/images/edits`，请求内容遵循 [OpenAI 图像生成指南](https://developers.openai.com/api/docs/guides/image-generation)、[生成接口](https://developers.openai.com/api/reference/resources/images/methods/generate)和[编辑接口](https://developers.openai.com/api/reference/resources/images/methods/edit)。模型及参数的实际可用性由 OpenAI 账号权限和所选模型决定。

## 安装

需要 Node.js 22 或更高版本。

无需克隆项目，也可以直接从 GitHub 运行发布版本：

```sh
npx --yes --package=github:zsio/openai-image-cli#v1.0.0 gpt-image --help
npx --yes --package=github:zsio/openai-image-cli#v1.0.0 gpt-image config init
```

或者克隆并安装本地命令：

```sh
git clone https://github.com/zsio/openai-image-cli.git
cd openai-image-cli
npm ci
npm run install:local
gpt-image --version
```

安装器创建 `~/.local/bin/gpt-image`，链接到此项目，并创建空白配置文件；重复运行会保留现有配置。如果终端找不到命令，请将 `~/.local/bin` 加入 PATH。项目目录需要保留，移动后需重新设置命令链接。

## 安装全局 Skill

仓库内的 `skills/gpt-image` 可通过 [Skills CLI](https://github.com/vercel-labs/skills) 安装和管理。Skill 自带通过 npx 调用 CLI 的方式，其他机器也可直接使用。Skills 安装器要求 Node.js 22.20 或更高版本。

```sh
# 全局安装到 Codex
npx skills add zsio/openai-image-cli --skill gpt-image --global --agent codex --yes

# 或交互选择其他支持的 Agent
npx skills add zsio/openai-image-cli --skill gpt-image --global

# 查看、更新、移除
npx skills list --global
npx skills update gpt-image --global
npx skills remove gpt-image --global --agent codex --yes
```

安装后可在 Agent 中使用 `$gpt-image`，或直接提出匹配的 GPT 生图请求。API Key 仍由本机独立配置，不随 Skill 同步或分发。

## 配置 API Key

编辑本机文件：

```sh
nano ~/.config/gpt-image/.env
```

填写这一项并保存即可，不需要 `source`：

```dotenv
OPENAI_API_KEY=在这里填写你的APIKey
```

可选配置如下，通常只需填写 Key：

```dotenv
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_IMAGE_MODEL=gpt-image-2.6-flare
OPENAI_ORG_ID=
OPENAI_PROJECT_ID=
```

读取优先级：命令参数 > 当前 shell 的环境变量 > 配置文件 > 内置默认值。默认配置文件使用 `$XDG_CONFIG_HOME/gpt-image/.env`，未设置 XDG 时使用 `~/.config/gpt-image/.env`。可用 `GPT_IMAGE_CONFIG` 或 `--config` 指定其他配置文件。CLI 在任意工作目录下读取同一个配置文件。

```sh
gpt-image config path     # 显示实际配置路径
gpt-image config show     # 查看配置状态，不显示 Key
gpt-image config init     # 创建配置模板，不覆盖已有文件
```

安装器创建的配置文件权限为 `600`。Key 只用于 API 认证，不写入图片的调用记录。

## 生成一张图片

```sh
gpt-image "一只戴着红围巾的小猫，水彩插画"

gpt-image generate "海边灯塔，清晨柔和的光线" \
  --name 灯塔 \
  --size 1536x1024 \
  --quality high
```

没有指定目录时，CLI 在系统临时目录中创建“名称＋本地日期时间＋随机后缀”的文件夹，例如：

```text
<系统 tmp>/灯塔-20261109-213000-125-a1b2c3/
  灯塔.png
  灯塔.json
  灯塔.prompt.txt
```

系统临时目录取自 Node.js `os.tmpdir()`，遵循 `TMPDIR` 等系统设置；macOS 通常位于 `/var/folders/.../T`。未指定 `--name` 时，文件名取自提示词的前 32 个有效字符。

`.json` 保存调用参数、输入来源、请求 ID、耗时和 API 返回的用量等信息，不重复保存图片 Base64；`.prompt.txt` 保存原始提示词。

## 指定目录和文件名

```sh
# 在指定目录直接保存，名称可包含扩展名
gpt-image "水彩小猫" --out-dir ~/Pictures/AI --name 小猫

# 指定完整路径；由 .webp 推断格式
gpt-image "旅行海报" --output ~/Pictures/AI/海报.webp --compression 90

# 透明背景
gpt-image "一个可爱的机器人贴纸，背景透明" \
  --background transparent --format png --name robot
```

`--output` 与 `--out-dir` / `--name` 互斥。`--output` 没有扩展名时自动补全；显式 `--format` 与扩展名不一致时会报错。图片及同名附属文件已存在时，在发起请求前退出，保留原文件。

## 编辑、参考图和蒙版

```sh
gpt-image edit "把背景改成雪山，保留人物的脸和衣服" \
  --image ./原图.png --output ./雪山.png

gpt-image edit "把这两件商品放入同一张白底产品照片中" \
  --image ./商品一.png --image ./商品二.jpg \
  --model gpt-image-2.6-sunburst --name 产品组合

gpt-image edit "将蒙版透明区域改成蓝色花瓶" \
  --image ./原图.png --mask ./蒙版.png --name 花瓶

gpt-image edit "把标注圈出的花瓶改成蓝色，并移除标注" \
  --image ./原图.png --markup ./标注层.png --name 标注编辑
```

参考图可重复传入 1–16 次，本地文件支持 PNG/JPEG/WebP，每张小于 50 MB。蒙版使用小于 4 MB 的 PNG；标注层使用透明 PNG。蒙版或标注层须与第一张参考图尺寸一致，几何及透明度要求由 API 检查，二者不能同时使用。

`--image`、`--mask` 和 `--markup` 也接受 HTTP(S) URL、data URL 和 OpenAI `file-...` ID。本地文件通过官方 SDK 上传；包含 URL / file ID 时使用 API 的 JSON 引用格式。

## 流式预览

```sh
gpt-image "一座森林中的城堡" --partial-images 2 --name castle
```

`--partial-images 1–3` 自动启用流式模式。预览图保存为 `castle.partial-1.png` 等，最终仍保存一张 `castle.png`。也可单独使用 `--stream` 只接收最终结果。只有收到完成事件才把结果视为成功。

## 官方 API 参数

### 模型与质量怎么选

`flare` 和 `sunburst` 是模型名称中的不同分支：[Flare](https://developers.openai.com/api/docs/models/gpt-image-2.6-flare) 侧重快速迭代，[Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.6-sunburst) 侧重需要精细细节的视觉工作。二者都能生图和编辑。需要细致排版、文字或复杂参考图编辑时，可以用相同提示词试 Sunburst，再比较结果。

当前 CLI 未指定 `--quality` 时，不发送该字段，沿用 API 的默认 `auto`。GPT Image 2.6 支持以下等级；右侧是使用建议，可根据实际输出调整：

| 质量 | 建议用途 |
| --- | --- |
| `auto` | 由模型决定，适合先试效果 |
| `low` | 快速验证构图、颜色和方向 |
| `medium` | 日常素材和反复迭代 |
| `high` | 正式插图、海报或课件素材的起点 |
| `xhigh` | 细节或小字不够清楚时继续尝试 |
| `max` | 最高质量档，比较提升是否值得额外消耗 |

`quality` 控制渲染细节，`size` 控制像素尺寸，`complexity` 控制渲染前的规划投入。后者有 `low / medium / high`，2.6 不传时为 `high`。质量不同，消耗的输出 token 可能不同，实际用量保存在调用记录里。参数定义见[官方提示词指南](https://developers.openai.com/api/docs/guides/image-prompting)。

```sh
gpt-image "一张带清晰中文标题的科普海报" \
  --model gpt-image-2.6-sunburst --quality high --size 1536x1024
```

### 参数映射

运行 `gpt-image --help` 查看完整命令选项。常用参数直接对应 API 字段：

| CLI 选项 | API 字段 |
| --- | --- |
| `--model` | `model` |
| `--size` | `size` |
| `--quality` | `quality` |
| `--background` | `background` |
| `--output-format` / `--format` | `output_format` |
| `--output-compression` / `--compression` | `output_compression` |
| `--moderation` | `moderation` |
| `--complexity` | `complexity` |
| `--input-fidelity` | `input_fidelity` |
| `--safety-identifier` | `safety_identifier` |
| `--stream` | `stream` |
| `--partial-images` | `partial_images` |
| `--frame-count` | `frame_count` |
| `--frame-duration-ms` | `frame_duration_ms` |

尺寸可以是 `auto` 或 `WIDTHxHEIGHT`，具体分辨率限制按模型要求执行。输出格式支持 PNG、JPEG、WebP、GIF、SVG；GIF / SVG 及复杂度等功能需要模型和项目具备对应权限，GIF / SVG 不支持流式输出。较早模型的 `input_fidelity` 等参数请按对应模型文档使用。

通过 `--params` 传入其他 API 字段及嵌套参数，也可以读取 JSON 文件：

```sh
gpt-image "清晰的矢量图标" --model gpt-image-2.6-flare \
  --format svg --params '{"complexity":"medium"}' --name icon

gpt-image "一只招手的卡通猫，平滑循环动画" \
  --model gpt-image-2.6-flare --format gif --frame-count 9 --name waving-cat

gpt-image "海报" --params @./image-params.json --name poster
```

明确传入的命令选项优先于 `--params` 中的对应字段。`n` 固定为 `1`；提示词和输入图片统一通过对应 CLI 选项提供。

## 提示词文件和脚本调用

```sh
gpt-image --prompt-file ./prompt.txt --name cover
cat ./prompt.txt | gpt-image --prompt-file - --name cover

# 不联网、不需要 Key、不创建输出文件，查看请求和计划路径
gpt-image "水彩小猫" --name 小猫 --dry-run

# stdout 输出完整 JSON，适合由其他脚本读取
gpt-image "水彩小猫" --name 小猫 --json
```

默认 stdout 仅输出最终图片的绝对路径，进度和错误写入 stderr。成功退出码为 `0`，失败为 `1`，收到中断信号后取消为 `130`。默认超时 600 秒，覆盖完整请求和流式接收过程，可用 `--timeout` 调整。请求不自动重试；超时或取消时，服务端可能已受理请求。

## 开发与验证

```sh
npm run check
npm test
npm run check:secrets
```

测试启动本地模拟 HTTP API，检查 SDK 的实际 JSON / multipart / SSE 请求和 CLI 文件行为，不调用真实 OpenAI 服务。覆盖配置与权限、参数透传、生成与编辑、预览、并发文件保护、Key 隐藏、超时、取消和流中断。真实生图需要配置有效 API Key 后运行。

发布包使用 `files` 白名单，打包前自动检查源码中的本机已配置凭据、API Key 模式和私钥。本机 `.env`、配置文件及生成结果不应提交到仓库。

## 许可证

[MIT](LICENSE)。这是独立的社区 CLI 项目。
