# Capability: embed-open-performance(嵌入打开性能管线 — 完整目标规格)

GenOffice 以 iframe 嵌入 Dataflarework SaaS 后,「打开一个文档」这条端到端管线的目标行为。规格覆盖静态资源服务、字体加载、渲染器启动、宿主会话建立、文档字节交付、包体结构与进度反馈七个子行为。协议与安全语义不变,只规定性能与可感知性行为。

## 1. 静态资源服务(web-server)

- 对所有静态资源(JS/CSS/字体/图片/SDK 产物),按请求 `Accept-Encoding` 协商返回 `gzip`(必须)或 `brotli`(可用时优先)压缩响应,带正确 `Content-Encoding` 与 `Vary: Accept-Encoding`;优先使用构建期预压缩产物,无预压缩产物时可运行时压缩。
- 内容 hash 寻址的资源(`assets/*.[hash].*`、hash 化 SDK 产物)返回 `Cache-Control: public, max-age=31536000, immutable`。
- HTML(含 WEB_TOKEN 注入分支)返回 `Cache-Control: no-cache`,凭据永不进入可缓存响应。
- 静态资源响应携带 `ETag`(内容 hash)或 `Last-Modified`;条件请求命中时返回 304,无响应体。
- 未命中缓存的冷请求仍走现有认证语义;失败关闭行为不变。

## 2. 字体加载

- 全部 web 字体以 woff2 提供(Liberation/Carlito/Caladea 系由 TTF 转换);构建产物不含这些字体的 TTF 副本。
- 全部 @font-face 声明 `font-display: swap`(或 optional):字体下载期间正文以回退字体渲染可见,不存在 block 隐形期。
- 当前 locale 的 CJK 主字体由首屏 HTML/CSS 发起 preload,请求不晚于首帧。
- 文档内嵌字体(adoptEmbeddedFonts)与字体子集机制行为不变;主题规则不变(字体属文档数据,不走 chrome token)。

## 3. 渲染器启动

- `createRoot`/首帧不等待 `getLanguage`/`getTheme`:语言与主题初值从同步来源(localStorage/HTML 注入)取得,IPC 结果异步校准,语言/主题切换行为不变。
- 启动期 IPC 调用彼此并行或合并,不存在串行链阻塞交互就绪。
- embed 入口 HTML 包含内联 CSS 编辑器轮廓骨架,在主 bundle 执行前可见;禁用 JavaScript 时骨架仍渲染。
- 桌面(Electron)构建的启动与打开/保存行为不变。

## 4. 宿主会话建立(dataflarework)

- 代理(`/office-engine/**`)对非 SSE 上游响应与请求体均流式转发,不在 JVM 堆内缓冲完整报文;SSE 行为保持现状。
- `target`/`webToken` 解析带进程内缓存(TTL ≤30s),单次被代理请求对二者合计 ≤1 次 Redis 查询;配置变更 ≤30s 内生效。
- mint(embed-session)上游串行往返 ≤2:verify-nonce 串行自检跳移除,以 nonce 创建响应即证明写入的本地等价保证替代;iframe 连接时的 nonce 真实验证语义不变(伪造 nonce 仍被拒)。
- 宿主在发起 mint 前已并行发起 SDK UMD 加载;二者任一失败仍走既有失败关闭路径(不静默降级到手写信封)。
- office workspace 路由保活:切走不销毁 iframe、不清 session;切回不重新 mint,内容 <500ms 恢复。显式关闭/登出路径仍完整清理。
- mint 与加载期间展示纯 CSS 编辑器轮廓骨架(语义 token 着色);连接超时(8s)转为明确失败态并提供重试,重试复用既有失败关闭路径。

## 5. 包体结构(docs renderer web 构建)

- 首屏关键 JS(初始加载、主路径可交互所需)≤3MB;AiPanel、agent 运行时、translation、导出链位于按需 chunk,首屏不请求。
- i18n 词典按 locale 动态加载:初始仅含当前 locale;切换语言时按需加载目标 locale,加载期间 UI 不崩溃(回退键或短暂等待均可)。
- docx 解压与解析在 Worker 线程执行;解析期间主线程无 >200ms 长任务;解析结果进入渲染器的路径与现有 parseDocx 契约一致。
- `@genoffice/web-sdk` exports 条件顺序保持(`browser` 不移回 `import`/`require` 之前)。

## 6. 文档字节交付

- 文档字节从宿主 API 到编辑器可解析状态的网络传输总量 ≤1.2× 文件体积:全程二进制(octet-stream/blob)承载,JSON base64 膨胀消除,guest 已持有字节时不再上传-回读临时文件往返。
- `docs:open` 的完整性校验以 mtime+size 快路径缓存,同一文件二次打开不重算全量 sha256;文件内容变化时缓存失效,校验强度不降低(首次仍全量)。
- 保存路径的字节流同理不受本规格回退影响(保存闭环仍 LOOP OK)。

## 7. 进度反馈(SDK + 宿主)

- SDK guest 对「静态资源加载」「文档下载/解析」阶段发出 progress 事件(既有 postMessage 通道,协议向后兼容:宿主可忽略)。
- 宿主按阶段展示进度:mint → 编辑器加载 → 文档加载 → 就绪;进度缺失时(旧 guest)回退到骨架 + 既有文案,不报错。
- 全链路分层计时探针(mint/资源/握手/文档/可编辑)纳入 e2e 工具链,每次验收输出五层数字,作为性能回归基线。

## 8. 不变约束(归档后持续有效)

- 嵌入闭环协议、SDK 单一事实源、宿主 sessionId 严格校验、失败关闭姿态不变。
- WEB_TOKEN 401 门禁、JWT 嵌入判定、SSRF sanitize、fetch-URL 收口等既有安全防线测试全绿。
- 文档内容渲染与主题解耦;loading 骨架属 UI chrome,走语义 token,主题门禁绿。
- 两仓各自门禁通过(genoffice: vitest/typecheck/theme 门禁/embed probe;dataflarework: mvn 定向测试,注意 JDK 26 ByteBuddy 环境标志)。
