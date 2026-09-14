# WorkBuddy Anywhere — dsh 插件

[English](README.md) | 中文

把 [dsh](https://github.com/deepseek-ai/deepseek-harness) 的模型请求路由到
**WorkBuddy Anywhere**。它注册 `workbuddy` 与 `workbuddy-intl` 两条 LLM provider
路由，把账号的实时模型目录发布到 dsh 的模型选择器，并把账号管理页嵌进 dsh 的设置面板。

默认把登录信息存在 `~/.workbuddy-anywhere/` —— 与 `wbaw serve` 同一个目录，
因此命令行与 dsh 共用同一批账号。其他宿主并不共用，见[账号存在哪里](#账号存在哪里)。

## 安装

需要 dsh 0.1.5-rc.1 或更高版本。

```bash
dsh plugin --profile <name> add ./wbaw-dsh-workbuddy-0.7.0.tgz
```

`<name>` 是要装入的 profile —— 可以是已有的（如 `web`），也可以是一个新名字，dsh 会在首次使用时创建。`dsh plugin` 是 dsh 自带的插件命令，它会安装依赖**并自动把插件加入该 profile 的 bundle 列表**，不需要手工改任何清单文件。上面 `./` 这样的相对路径是相对**你执行命令的目录**解析的，不是相对 profile 目录。

也可以直接从源码目录安装，不走 tarball：

```bash
dsh plugin --profile <name> add /path/to/repo/packages/dsh
```

**不支持 git 地址安装。** `lib/` 是被 git 忽略的构建产物，而 dsh 的安装器只在发布时才构建包，所以从 git 安装会得到一个没有入口文件的包。请用 tarball 或源码目录。

### 验证安装

```bash
dsh --profile <name> --dump-config
```

应当能看到本插件及其两条 provider 路由：

```
# == @wbaw/dsh-workbuddy
- id: dsh-workbuddy
  name: '@wbaw/dsh-workbuddy'
  config:
    providers:
      - workbuddy
      - workbuddy-intl
```

然后启动 dsh，在模型选择器里挑一个 WorkBuddy 模型即可。

### 卸载

```bash
dsh plugin --profile <name> remove @wbaw/dsh-workbuddy
```

### 出现 peer 依赖警告是正常的

`add` 会打印这样一段警告：

```
 WARN  Issues with peer dependencies found
└─┬ @wbaw/dsh-workbuddy 0.7.0
  ├── ✕ missing peer @deepseek-ai/cordis@^4.0.2
  └── ✕ missing peer @deepseek-ai/dsh-llm@^0.1.5-rc.1
```

这不代表哪里坏了，而且无法避免。这些包由**加载插件的那个 dsh 安装**提供，不在 profile 里，所以安装器没有来源去满足它们 —— dsh 运行时从自己那棵依赖树里解析。声明它们是为了记录插件需要哪些宿主版本，同时它们被刻意排除在普通依赖之外（见[依赖说明](#依赖说明)）。

## 在 dsh 里能得到什么

**模型选择器里的 WorkBuddy 模型。** 两个集群都注册为 provider 路由，所以 dsh 的模型设置页会列出从 `/v3/config` 拉取的实时目录 —— 未登录时也能拿到匿名目录。在 dsh 里把某个模型组标记为禁用，会表现为 provider 报错。

**设置面板里的 Workbuddy 分区。** 嵌入 dsh 设置面板的账号管理页：登录（浏览器或扫码登录）、切换账号、签到、开关要提供哪些模型、调整各账号的设置。第一次登录就在这里。

**输入框右侧的额度组件。** 显示所选模型对应区域下、当前账号的剩余额度；点击它可以切换账号，或把选择权交还给自动分配账号。

设置面板和额度组件都跟随 dsh 的主题与语言，且是实时同步的 —— 切换主题或语言无需重新加载。

### 说明

- 当 dsh 传来原始字节或可读的文件路径时，图片会正常发送；否则请求会降级为纯文本，由内置的视觉辅助模型代替账号去描述图片。
- 思考强度由 dsh 的逐模型配置控制（`modelConfiguration.reasoningEffort`）。

## 账号存在哪里

只有 dsh 与命令行共用登录态。各宿主各自保存自己的凭证：

| 宿主 | 存放位置 |
| --- | --- |
| dsh 插件、`wbaw serve`、`wbaw` CLI | `~/.workbuddy-anywhere/` |
| 桌面端（macOS） | `~/Library/Application Support/workbuddy-desktop/data/` |
| VS Code 扩展 | 该扩展在 VS Code 里的 `globalStorage` 目录 |

在其中一个登录，不会让另一个也登录 —— 你在桌面端或 VS Code 里加的账号不会出现在这里，反之亦然。

桌面端这样设计是**有意为之，不是疏漏**。两个进程同时刷新同一个 token 会相互竞争，而写入虽然原子（临时文件 + rename），却没有跨进程锁 —— 并发刷新可能丢掉轮换后的 token，把账号顶下线。所以桌面端刻意保留自己那份。

如果想把插件的存储换到别处 —— 包括指向桌面端的目录（这样就能共用登录，但要接受上述竞争）—— 在 profile 的 `cordis.patch.yml` 里**按 id 覆盖**它的 config。请用**绝对路径**，`~` 不会被展开：

```yaml
- id: dsh-workbuddy
  config:
    dataDir: /Users/you/Library/Application Support/workbuddy-desktop/data
    providers:
      - workbuddy
      - workbuddy-intl
```

覆盖是整体**替换** `config`，不是逐项合并，所以要保留的键需要一并写出。上面列 `providers` 只是为了明确 —— 不写会回退到 schema 默认值，而默认值本来就是这两条路由。可以用 `dsh --profile <name> --dump-config` 确认，插件那一行会显示 `patched by …/cordis.patch.yml`。

## 开发

需要 Node 20+。

```bash
yarn install
yarn workspace @wbaw/dsh-workbuddy build
```

该命令用 esbuild 把 `src/` 打包成单个 `lib/index.js`，生成类型声明，并把共用的管理界面拷贝进 `ui-dist/`，使包内自带一份。`client.js`（浏览器半边）是原样加载的，不参与构建。`yarn typecheck` 只做类型检查。

### 发布

```bash
yarn release:dsh
```

构建、打包、验证，最终在 `release-<version>/` 下产出一个 tarball。验证那一步是脚本的重点：它会把打好的 tarball 装进一个临时目录并实际加载，因此打包出错会在开发者机器上失败，而不是在用户那里。也可以单独运行：`yarn workspace @wbaw/dsh-workbuddy verify:release`。

### 依赖说明

`@wbaw/core` 是 private 且从不发布，所以 esbuild 会把它**内联**进 `lib/index.js`。它被放在 `devDependencies` 里正是为了不进入安装依赖；一旦它重新出现在 `dependencies`，或者产物里仍引用它，构建就会失败。

`@deepseek-ai/*` 全部保持 external 并声明为 peer 依赖，让插件使用宿主自己那份，而不是再打包一份。Cordis 注册、schemastery schema、`LlmAdapter` / `LlmError` 都是按 identity 比较的，多出一份副本会静默失配。
