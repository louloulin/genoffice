# Outcome

用户通过 Dataflarework SaaS 嵌入打开 GenOffice 文档时,打开速度达到可用级:

- 首开静态传输从实测 21MB 降至 ≤6MB(gzip/brotli + 字体 woff2 化),重复打开编辑器壳资源零重传(immutable 缓存);
- mint 认证链、SDK 加载、文档字节链路的串行开销消除(串行上游往返 ≤2、文档网络传输 ≤1.2× 文件体积);
- 首屏无白屏无隐形文字:宿主与 iframe 内骨架即时可见,阶段化进度(mint → 编辑器 → 文档 → 就绪)全程可感知;
- 切走再切回 office workspace 秒开(keep-alive);
- 以上全部在不回归嵌入闭环(LOOP OK)、认证/SSRF 防线与主题门禁的前提下交付。

依据:2026-10-05 实测归因(真实 web-server + Playwright 采集)——主 JS 6.7MB 零压缩零缓存(重复打开仍全量重传)、145 条 @font-face 中 119 条 `font-display: block`、13 个启动 IPC、文档三跳 ~3.7× 字节膨胀、宿主代理整体缓冲 + 每请求 4 次 Redis + mint 3 串行跳 + 无 keep-alive。

# Scope

两个仓库、四层改造,单 change 按 B1→B5 批次交付(每批独立验收,同 enterprise-office-ai 的 D12 批次模式):

- **B1 genoffice 传输层**:web-server 静态资源预压缩(gzip/brotli 协商)+ hashed 资源 immutable 缓存 + ETag;字体 TTF→woff2、`font-display: swap`、CJK preload;getLanguage/getTheme 脱离 createRoot 关键路径。
- **B2 dataflarework 宿主层**:代理非 SSE 响应/请求体流式化;target/webToken 进程内缓存;verify-nonce 串行自检移除;SDK UMD 加载与 mint 并行;office workspace keep-alive;宿主加载骨架。
- **B3 genoffice 包体层**:renderer 代码分割(manualChunks + React.lazy:AiPanel/agent-runtime/translation/导出链);i18n 按 locale 动态 import(沿用 sheets/Univer 先例);JSZip 解析进 Worker;embed 页内联 CSS 骨架。
- **B4 genoffice 文档链路**:文档字节二进制通道(octet-stream 替代 JSON base64)、消除 guest→server→guest 临时文件往返、open 全量 sha256 改 mtime+size 快路径。
- **B5 感知层(双仓)**:SDK progress 事件(资源加载/文档解析阶段)+ 宿主阶段化进度展示 + 超时可重试;全链路分层计时探针固化为回归基线。

# Non-goals

- CDN/边缘缓存、HTTP/2/3、服务器与网络拓扑调优(部署侧事项,本地不可验);
- Electron 桌面端启动性能(字体 swap 等改动顺带生效,不为其设验收);
- ProseMirror/Univer 渲染引擎重排版算法优化(setContentPhased 渐进挂载已存在,不重做);
- markdown/html 面板性能(沿用独立 change 先例);
- dataflarework 非 office 嵌入链路的性能问题;
- 认证模型/nonce 语义变更(只消除冗余自检跳,不改变安全语义)。

# Acceptance examples

判定口径:传输量指标以字节绝对值为准(本地同机测量,不依赖网络条件);行为指标以代码路径 + 浏览器 Performance API/网络面板或 curl 头为准。

**批次 B1(genoffice 传输层)**

- A1 静态压缩:对 docs 渲染器任意静态资源请求带 `Accept-Encoding: gzip`,响应含 `Content-Encoding: gzip` 且传输字节 ≤ 未压缩体积的 30%(brotli 可用时优先 br)。
- A2 缓存头:内容 hash 类静态资源(assets/index-*.js、*.woff2、hash 化 SDK 产物)响应含 `Cache-Control: public, max-age=31536000, immutable`;HTML 响应含 `Cache-Control: no-cache`。
- A3 重复打开零重传:同一浏览器会话第二次打开编辑器,主 JS/CSS/字体 transferSize 总和为 0(命中缓存,Performance API 可证)。
- A4 条件请求:静态资源响应含 ETag 或 Last-Modified,带条件头的重复请求返回 304。
- A5 字体 woff2 化:Liberation/Carlito/Caladea 系字体以 woff2 格式提供,该组总体积 ≤3MB,构建产物中不再出现对应 TTF。
- A6 字体 swap:fonts.css 全部 @font-face 为 `font-display: swap`(或 optional),无 `block`;字体下载期间正文以回退字体可见。
- A7 CJK preload:首屏对当前 locale 的 CJK 主字体发出 preload,字体请求发起不晚于首帧(网络面板序可证)。
- A8 启动不被 IPC 阻塞:createRoot/首帧不 await getLanguage/getTheme(代码路径可证);首帧时间在两 IPC 完成前出现。

**批次 B2(dataflarework 宿主层)**

- A9 响应流式:非 SSE 上游响应流式转发(管道/分块),6.4MB 资源转发期间代理 JVM 堆增量显著小于响应体大小(代码路径 + 大文件转发行为测试)。
- A10 请求体流式:代理请求体不再整体读入堆(流式 publisher),大 multipart 写回不整段缓冲。
- A11 Redis 收敛:同一被代理请求对 target/webToken 的解析合计 ≤1 次 Redis 查询(进程内缓存 TTL ≤30s,配置变更 ≤30s 可见)。
- A12 mint 提速:embed-session mint 的上游串行往返 ≤2(verify-nonce 串行跳移除);本地同机 mint 耗时 ≤ 原 3 跳实现的 2/3。
- A13 SDK∥mint 并行:宿主在 mint 请求发出前已发起 SDK UMD 加载,两者并发(SDK 就绪时刻不晚于 mint 完成时刻,计时/代码路径可证)。
- A14 keep-alive:office workspace 切走再切回(不刷新整页),不重新 mint、不销毁重建 iframe,内容恢复可见 <500ms。
- A15 宿主骨架:mint 与加载期间展示编辑器轮廓骨架(纯 CSS,非纯文字占位),视图挂载后 <100ms 内出现。

**批次 B3(genoffice 包体层)**

- A16 主 chunk 分割:docs web 构建首屏关键 JS ≤3MB;AiPanel/agent-runtime/translation/导出链位于独立 chunk 且首屏不加载(网络面板可证)。
- A17 i18n 动态化:主 chunk 仅含当前 locale 翻译;切换语言时动态加载目标 locale(其余 19 locale 不在初始传输中)。
- A18 解析入 Worker:docx 解压+解析在 Worker 线程执行,解析期间主线程无 >200ms 长任务。
- A19 iframe 内骨架:`/embed/` 返回的 HTML 含内联 CSS 骨架,主 JS 执行前可见(禁用 JS 仍显示骨架)。

**批次 B4(genoffice 文档链路)**

- A20 文档传输 ≤1.2×:文档字节从宿主 API 到编辑器可解析状态的网络传输总量 ≤1.2× 文件体积(现状 ~3.7×;以探针计数为准)。
- A21 hash 快路径:同一文件二次 open 不重算全量 sha256(mtime+size 缓存,日志/计时可证)。

**批次 B5(感知层)**

- A22 progress 事件:guest 对资源加载与文档解析阶段发出 progress 事件,宿主 UI 展示阶段化进度(mint→编辑器→文档→就绪)。
- A23 超时可重试:连接超时(8s)后宿主展示明确失败态与重试操作,重试走既有失败关闭路径。
- A24 分层计时基线:嵌入打开分层计时探针(mint/资源/握手/文档/可编辑)纳入 e2e 工具链,输出五层数字;与本 change 基线相比端到端(本地同机)耗时下降 ≥1/3。

**每批必验不变量**

- A25 嵌入闭环:e2e/embed-loop-probe.mjs 全绿(LOOP OK 11/11)。
- A26 安全不回归:WEB_TOKEN 401 门禁、JWT 嵌入判定、SSRF sanitize 既有测试套件全绿;伪造 nonce 在 iframe 连接时仍被拒(verify-nonce 移除后真实校验语义不变)。
- A27 主题门禁:check-theme-colors 门禁绿(新增 renderer CSS 行全走 token)。
- A28 桌面模式不回归:Electron 构建(非 web)文档打开/保存行为不变,字体 swap 后正文可见。

# Constraints and invariants

- 嵌入闭环协议与「SDK 单一事实源」不改变;宿主 sessionId 严格校验、失败关闭姿态不放宽(承接嵌入闭环 change 的既定约束)。
- 认证/SSRF 防线不弱化:WEB_TOKEN 门禁、JWT 嵌入判定、settings 消毒、fetch-URL 收口全部保持。
- `@genoffice/web-sdk` exports 中 `browser` 条件不得移回 `import`/`require` 之前(陈旧 bundle 陷阱)。
- 文档内容渲染不受主题影响(CLAUDE.md theming 规则);loading 骨架属 UI chrome,必须走语义 token。
- dataflarework 侧改动在其仓库过其门禁(注意 JDK 26 需 `-Dnet.bytebuddy.experimental=true` 的已知环境问题);genoffice 侧改动过本仓门禁。
- 缓存策略不得泄漏凭据:含 WEB_TOKEN 注入的 HTML 响应必须保持 no-cache 语义。

# Decisions

- D1 工作区:独立 worktree(Runtime 强制——同目录已存在 active change enterprise-office-ai),分支 comet/embed-open-performance,基于 release0919。
- D2 仓库范围:两仓都改(genoffice + /Users/louloulin/appx/dataflarework);dataflarework 侧提交其自身仓库,验收由本 change 统一覆盖(先例:嵌入闭环 change)。
- D3 交付结构:单 change、B1→B5 批次交付,不变量(A25-A28)每轮必验;不做 Supervisor 拆分(同路径紧耦合,验证共享同一测量基线)。
- D4 verify-nonce:移除 mint 期串行自检跳,以「nonce 创建 2xx 即已入进程内存储」的本地等价保证替代;iframe 连接时的 nonce 真实验证保持不变(安全语义不变,只删冗余 RTT)。
- D5 字体策略:全量 `font-display: swap`,接受字体加载期短暂回退字体闪烁,换取文字立即可见(消除 block 隐形期)。
- D6 keep-alive:宿主对 office workspace 保活,接受后台 iframe 内存占用,换取切回秒开。
- D7 文档链路路线:优先 guest 直开已持有字节 + 二进制(octet-stream)通道;服务端到服务端直拉仅在不引入跨服务凭据新协议时考虑(默认不做)。
- D8 测量口径:验收以本地同机测量为准;传输量用字节绝对值,行为用代码路径 + 浏览器性能面板/curl 头;端到端提升以分层计时探针对照。

# Open questions

(无 —— 用户已于 2026-10-05 确认最终共享理解:目标、B1-B5 双仓批次范围、D1-D8 决定、A1-A28 验收与非目标全部确认,进入 Build。)

# Verification expectations

- 每批交付后由独立只读 Verifier 逐项判定该批验收项 + 全部不变量;未交付批次如实判 failed/blocked(同 enterprise-office-ai 批次节奏)。
- 工具:curl 响应头检查(压缩/缓存/304)、Playwright Performance API(transferSize/首帧/长任务)、分层计时探针、既有测试套件(embed-loop probe、认证/SSRF 套件、theme 门禁)、dataflarework 侧 mvn 定向测试。
- 每批提交前 Builder 自验:本批验收项 + A25-A28 不变量;构建陷阱防范:被测产物 mtime 必须晚于源码改动(SDK 改动先 build 再跑 docs 测试)。
