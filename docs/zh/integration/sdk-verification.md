# SDK 契约验证

SDK 的单测是 mock 的,而 mock 编码的是**我们对服务端线格式的假设**。假设一旦
漂移,测试套件仍然全绿,而真实调用全部失败。这一页讲的就是拦住这种情况的门禁。

```bash
npm run verify:sdk
```

一条命令:构建 SDK 与 web-server bundle,在一个空闲端口上起一个临时服务器,
用 SDK 的真实客户端通过 HTTP 打它,最后全部清理。退出码 0 表示契约成立。

## 为什么需要它

两次事故,都是 mock 套件结构上看不见的:

1. **IPC 信封。** 四个 collab 客户端从响应信封的顶层读 payload。所有 mock 都
   直接返回裸 payload,于是 410 个测试全绿,而对着真实服务器 `list()` 永远
   返回 `[]`、`add()` 直接抛错。
2. **abort 时泄漏的 Promise。** `SseParser.close()` 调用 `reader.cancel()` 却
   没有处理它返回的 Promise。在真实 socket 上该 Promise 会以 abort 原因
   reject;这个 rejection 无人处理,直接杀掉了探针进程。已有的 hanging-stream
   fixture 复现不了它——它的 `cancel()` 总是 resolve——所以任何 mock 测试都
   不可能发现它。

这两类 bug 离开真实服务器就找不到。这就是这道门禁的全部理由。

## 它跑什么

### `npm run verify:sdk` —— 完整门禁

```
构建 SDK → 打包 web-server → 取空闲端口 → 起服务器
         → 轮询 /api/v1/health → 跑 live-probe.mjs → SIGTERM + 清理
```

| 环境变量 | 作用 |
|---|---|
| `PROBE_SKIP_BUILD=1` | 复用已有 `dist/`,不重新构建 |
| `PROBE_VERBOSE=1` | 把子进程服务器的 stdout/stderr 打出来 |
| `PROBE_KEEP=1` | 保留临时数据目录以便排查 |

构建步骤上限 5 分钟;健康检查最多等 20 秒。

### `npm run probe:live` —— 只跑探针

对**你自己**已经起好的服务器跑 `live-probe.mjs`。默认目标
`http://127.0.0.1:18081`,用 `PROBE_BASE` 覆盖。

```bash
PROBE_BASE=http://127.0.0.1:18081 npm run probe:live -w @genoffice/web-sdk
```

未设置 `PROBE_BEARER` 时,v1 两组(embed、translation)会打印一行 `SKIP` 且
不计入统计。这是刻意的——**被跳过的断言不等于通过的断言**。要纳入它们,需要
一个带 `files:read`、`files:write`、`ai:translate` 的 JWT:

```bash
PROBE_BEARER=<jwt> npm run probe:live -w @genoffice/web-sdk
```

## 覆盖范围

- **collab over IPC** —— cursor、presence、lock、comments,含 `NOT_FOUND` /
  `CONFLICT` 分支。这就是最初的信封回归。
- **静态 SDK 白名单** —— 对 web-server 用硬编码正则提供的条目请求
  `GET /static/sdk/<entry>.mjs`。漏一个条目在本地完全看不出来(SDK 测试直接
  import `dist/`),但在 CDN 部署上是 404,所以探针用 HTTP 真的去取。
- **嵌入闭环** —— 创建真实文件、调用 `openEmbedSession()`,断言返回的 URL;
  断言**同一个 nonce 再次 verify 仍然成功**(证明 verify 不消费);断言
  `cleanup()` 能释放且幂等;断言释放后不再验证通过。
- **translation 走 v1** —— 用一个记录型 `fetch` 证明所有翻译调用都打
  `/api/v1/ai/…`,没有任何一个回落到 legacy `/api/ai/…`。

translation 的断言检查的是**路由看懂了请求**,不是翻译成功。CI 没有 LLM
provider key,批量翻译会以 HTTP 200 返回,每个 unit 是
`status: "failed"` + `"Claude HTTP 401: Missing API key"`。探针只断言这不是
400 `expected { text, from?, to }`,即 v1 路由接受 `units[]`。不要把探针
"修"成断言翻译成功——那会让它依赖环境,并且因为错误的原因失败。

## **不**覆盖什么

**真实的 iframe ↔ `postMessage` 桥。** 探针只会说 REST,从不加载 iframe。
那需要浏览器,而 CI runner 没有。这条边界很重要:一次绿色的 `verify:sdk`
完全不能说明桥的接线、`event.source` / `event.origin` 校验或握手回显是对的。

那部分由别处覆盖:

- `apps/sdk/test/dataflare/iframe-bridge-e2e.test.ts` —— 对真实 iframe 的
  桥握手
- `e2e/` —— Playwright 套件(`npm run test:e2e`),驱动真实渲染进程

## CI

`.github/workflows/ci.yml` 把门禁作为 `sdk-contract` job 在每次 push 与 PR
上运行。该 job **刻意**不放进 `docker` 的 `needs`:它守住整个 workflow 的
状态即可,不必给发布路径增加约 4 分钟。

随它一起落地的两处修复:

- 旧的 `build` job 跑的是 `npm run build -w @genoffice/sdk --if-present`。
  真实包名是 `@genoffice/web-sdk`;`--if-present` 把错误的包名变成了静默
  空操作,所以那个 job 什么都没构建。
- 根 `test` 脚本从未列出 SDK,其测试套件因此从未在 CI 里跑过。现在会跑。

## 门禁失败时

把失败当作真实的契约破坏,方向有三种:

1. **SDK 漂移了** —— 它调用的路径或发送的 body 服务端已不再接受。修 SDK。
2. **服务端漂移了** —— 路由移动、scope 收紧、响应字段改名。修服务端,或者
   有意识地更新 SDK 去匹配。
3. **探针本身错了** —— 仅在排除前两种之后。探针编码的是整个仓库依赖的契约;
   为了让结果变绿而放宽它,等于拆掉门禁。

改动探针之前,先证明门禁还能失败:把 `buildDataflareEmbedUrl` 里的 `nonce`
参数改个名再跑一次,必须有一条断言变红。**不会失败的门禁不是门禁。**
