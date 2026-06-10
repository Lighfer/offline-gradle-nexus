# Offline Gradle Nexus Tool

一个零 npm 依赖的 Node.js 小工具，用于在内网开发环境中：

1. 识别 Gradle 多模块工程；
2. 基于 Gradle 自身解析最终依赖图；
3. 导出 `runtimeClasspath`、测试依赖、annotation processor、buildscript classpath、Gradle plugin marker 依赖、Gradle wrapper distribution；
4. 将外部 Maven 依赖整理成本地 Maven 仓库目录；
5. 尝试将 project dependency 的 jar 也整理成 Maven 坐标目录；
6. 将本地 Maven 仓库目录通过 Nexus 3 Maven layout PUT 上传到目标仓库；
7. 校验下载下来的依赖与构建产物 fatjar 内部 `BOOT-INF/lib/*.jar` 是否一致。

## 运行

Windows：

```bat[01KRZ2KSNZ5H3M5QMR4DH8NG16](../../01KRZ2KSNZ5H3M5QMR4DH8NG16)
cd offline-gradle-nexus
node server.js
```

然后浏览器打开：

```text
http://127.0.0.1:39173/
```

可通过环境变量修改端口：

```bat
set PORT=39999
node server.js
```

## 源码结构

```text
offline-gradle-nexus/
  server.js                       入口，仅做 HTTP 监听与请求分发
  lib/
    util.js                       基础工具（文件、哈希、URL、Maven 路径、classifier 解析、流式多算法 hash、受限并发 map、isRegularFile）
    http-client.js                HTTP 缓冲 + 流式下载 + PUT 上传
    jdk.js                        JDK 扫描与默认 JDK 选择
    gradle-init-scripts.js        注入 Gradle 的 init script Groovy 模板；v3.6 起额外源仓库为追加语义并按 URL 去重
    gradle-runner.js              Gradle 执行器（默认 daemon+parallel+build-cache）、环境变量、JSON 提取、耗时回传
    inspect-resolve.js            inspect / resolve 高层封装与汇总；resolve 自带 cacheToken + 参数指纹的进程级缓存
    maven-metadata.js             POM / .module 生成、GA 级 maven-metadata.xml 生成（v3.7，动态版本可解析前提）、校验和（流式多算法 hash）、Gradle 缓存查找、源仓库下载；POM 父链属性域遍历器（v3.8）
    bundle.js                     一键拉取并整理本地 Maven 仓库目录；保留 project artifact classifier，POM/.module 主 artifact 单点生成；目录型 artifact 跳过 + 同源文件 artifact 去重（v3.6）；POM 闭包 BFS 递归补齐 + 写出 GA 级 maven-metadata.xml（v3.7）；BFS 父链属性感知 + pending 重扫（v3.8）
    wrapper-export.js             Gradle wrapper distribution 导出
    bundle-upload.js              扫描本地 bundle 与 Nexus 3 PUT 上传
    zip-reader.js                 零依赖最小 ZIP/JAR 读取器（含 ZIP64）
    fatjar-verify.js              fatjar 与 bundle 一致性比对（按 G:A:V:classifier 精确匹配，fileName 回退）
    static-server.js              静态资源服务
    api-router.js                 HTTP API 分发
  public/
    index.html                    现代卡片式骨架（顶部 toolbar / 折叠配置 / step tabs / 日志抽屉）
    style.css                     视觉系统：颜色变量、字体、表格、result tabs、依赖树、抽屉
    js/
      main.js                     入口，绑定 step tabs / resolve / download
      api.js                      fetch 包装，统一抛错
      dom.js                      $/$$/createEl/escapeHtml/formatBytes/copy 等
      state.js                    inspect/resolve/scan/verify/upload 全局状态
      progress.js                 长任务按钮的秒表 + 阶段标签
      ui/header.js                顶部状态条与 JDK 徽章
      ui/config.js                基础配置 / 额外源仓库（追加语义，v3.6） / JDK 扫描
      ui/inspect.js               识别 Gradle 工程；仓库表格
      ui/tree.js                  依赖树视图：result tabs + 折叠搜索 + 节点详情
      ui/verify.js                fatjar 验证：摘要卡 + 结果 tabs + 表格化
      ui/upload.js                扫描本地 bundle / 上传 Nexus / 计划与结果表格
      ui/log.js                   底部日志抽屉
```

## 重要行为说明

### 依赖解析

工具不会手写解析 `build.gradle` / `settings.gradle`。它会注入临时 Gradle init script，让 Gradle 自己完成：

- 多模块识别；
- Maven repositories 识别；
- dependency constraints / BOM / platform；
- 版本冲突选择；
- excludes；
- variant-aware resolution；
- resolved artifacts 获取。

默认主配置是：

```text
runtimeClasspath
```

可以额外勾选：

```text
testRuntimeClasspath
annotationProcessor
testAnnotationProcessor
buildscript classpath
Gradle plugin marker dependencies
Spring Boot 内置 jar (layertools / tools)   # v3.4 新增，默认勾选
Version Catalog imports(from/notation)       # v3.5 新增，默认勾选
所有子模块的 canBeResolved 配置              # v3.5 新增，默认勾选
```

#### Spring Boot 内置 jar 自动拉取（v3.4）

Spring Boot Gradle plugin 在 `bootJar` 任务里会把以下 jar 直接拍进 fatjar 的 `BOOT-INF/lib/`，但它们**不在用户的 `runtimeClasspath` / `buildscript classpath` / plugin marker 之内**：

- Spring Boot 3.0~3.2.x：`org.springframework.boot:spring-boot-jarmode-layertools`
- Spring Boot 3.3+：`org.springframework.boot:spring-boot-jarmode-tools`

工具会在解析阶段：

1. 从 settings 期 `pluginRequests` 里查 `org.springframework.boot` 的版本；
2. 如果 settings 阶段查不到，退回扫描所有项目 `buildscript.classpath` 找 `org.springframework.boot:spring-boot-gradle-plugin`；
3. 拿到版本后，构造 detached configuration 同时尝试 `spring-boot-jarmode-layertools` 与 `spring-boot-jarmode-tools`（lenient 解析，能拉到几个就拉几个），label 为 `__springBootBundled:<version>`。

这样 fatjar 一致性验证里 `BOOT-INF/lib/spring-boot-jarmode-layertools-<v>.jar` 会和 bundle 中的同 GAV jar 1:1 对齐，不再被误判为 only-in-fatjar。

#### 构建期依赖补齐（v3.5）

针对“fatjar 对齐没问题，但把项目仓库切到新 Nexus 后依然编译失败（如 `incomingCatalogForLibs0`、`jacocoAnt`）”场景，v3.5 在 resolve 阶段新增三条补齐链路：

1. **Version Catalog imports**：在 `settingsEvaluated` 反射读取 `dependencyResolutionManagement.versionCatalogs` 的 `importedCatalog.notation`，把 `from("g:a:v")` 的坐标落到 `versionCatalogImports`，并在 resolve 时额外生成 `__versionCatalogImports` 结果，确保 `com.thtf.base:management:0.0.98` 这类 catalog 源工件进入 bundle。
2. **全子模块可解析配置**：遍历所有子模块 `canBeResolved=true` 的 configuration，不再只限 `compile/runtime/test`，因此 `jacocoAnt`、代码生成、质量插件等构建期配置也会被采集。
3. **POM 递归补齐**：对已落盘的 POM 递归解析 `parent` 与 `dependencyManagement import BOM`，并把发现的坐标继续拉取 metadata。像 `spring-boot-dependencies` → `metrics-bom` 这类二级 BOM 依赖会自动补齐。

这三步叠加后，工具导出的离线仓库可覆盖“运行期 + 构建期”双场景，而不再只覆盖 fatjar 运行依赖。

### 额外源仓库（v3.6 起为追加语义）

页面「额外源仓库」字段填写 Maven 仓库 URL 后，工具会通过 Gradle init script **前置追加**到下列 4 个 RepositoryHandler，**不再清空**用户工程已经声明的仓库：

- `settings.pluginManagement.repositories`
- `settings.dependencyResolutionManagement.repositories`
- `project.buildscript.repositories`
- `project.repositories`

注入按 URL 去重，且只对本工具自家的 inspect/resolve 任务生效，不会改写用户的 `settings.gradle` / `build.gradle`。Gradle 会优先在额外源仓库里查找依赖，命不中再回退到工程原仓库，因此典型场景为：

> 用户已经把项目 `repositories { ... }` 改成只指目标 Nexus（如刚建好的 `hjk-test-delete-after-20260531`），但目标仓库还没有这些依赖；这里填上原 Nexus group（如 `http://nexus/repository/maven-public/`）即可一次性补齐。

只填写账号密码时，工具会把凭据应用到所有 HTTP(S) Maven 仓库（含原仓库和额外仓库）；若插件 DSL 或 version catalog 在 `settings.gradle` 评估阶段就解析依赖，工具也会尽量在 `beforeSettings` 阶段提前注入凭据。

如果项目脚本里存在 `credentials { username = findProperty(...) }` 但属性为空，Gradle 可能抛出 `Username must not be null`。工具默认会把 HTTP(S) Maven 仓库的空用户名修正为空字符串，避免该异常；如果仓库实际需要认证，仍必须在页面填写源仓库账号密码。

> 兼容说明：旧版的「源仓库覆盖（清空+替换）」语义已经下线。环境变量 `OGN_REPO_OVERRIDE_JSON` 现在等价于 `OGN_EXTRA_REPOS_JSON`，按追加语义生效，历史调用方无需改代码即可平滑迁移；想强行替换原仓库可直接编辑用户工程脚本。

### Project dependency 打包

Gradle 解析 `runtimeClasspath` 时，如果 project dependency 需要产物，Gradle 可能会执行被依赖模块的 `jar` 相关任务。这是为了满足“把 project dependency 也作为 jar 导出”的要求。

对 project dependency，工具会读取：

- `project.group`
- `project.version`
- `base.archivesName` / `archivesBaseName` / `project.name`

如果 group/version 缺失，工具不会猜坐标并放进 Maven repo，而是复制到：

```text
<bundle>/project-artifacts-unresolved/
```

这样可以避免把项目依赖上传到错误坐标。页面提供 `Project 依赖兜底 group/version`，只有你明确填写后才会用于缺失坐标。

#### Classifier 处理

工具会按源 artifact 文件名保留 classifier：

- 源 `engine-server-0.0.93.1-plain.jar` 在 bundle 中保存为 `engine-server-0.0.93.1-plain.jar`，与 Spring Boot fatjar 的 `BOOT-INF/lib/engine-server-0.0.93.1-plain.jar` 一一对齐。
- 同 GAV 多 classifier（plain / sources / javadoc 等）共用同一目录。`*.pom` 与 `*.module` 由该 GAV 的 leader artifact 一次性生成（leader 优先选无 classifier 的主 jar，缺失时退化为列表中第一个）。
- 当某个 GAV 只有 classifier jar（典型即 Spring Boot 子模块的 plain.jar）时，工具会把该 jar 内容**额外**复制一份成无 classifier 的主 jar，以满足下游 Maven/Gradle 通过主坐标拉取的场景。manifest 中以 `kind: 'project-artifact-primary-fallback'` 标记。

### 导出目录结构

默认导出到：

```text
<Gradle工程目录>/.offline-nexus-bundle/
```

核心结构：

```text
.offline-nexus-bundle/
  manifest.json
  repo/
    com/example/foo/1.0.0/foo-1.0.0.jar
    com/example/foo/1.0.0/foo-1.0.0.pom
    com/example/foo/1.0.0/foo-1.0.0.module
    com/example/foo/1.0.0/foo-1.0.0.jar.sha1
    com/example/foo/1.0.0/foo-1.0.0.jar.md5
  reports/
    dependency-tree.json
    upload-report-*.json
  wrapper-distribution/
    gradle-*.zip
  local-files/
```

`manifest.json` 会包含 `summary` 字段，供 “扫描本地导出目录” 页面与脚本快速读出统计数据。

### 上传 Nexus

上传使用 Nexus 3 Maven hosted repository 支持的 layout PUT 方式：

```text
PUT <nexus-base-url>/repository/<repo-id>/<maven-relative-path>
```

支持两种模式：

1. 单一目标 Repository：所有文件上传到一个 hosted/mixed 仓库；
2. Release/Snapshot 分流：根据版本目录是否以 `-SNAPSHOT` 结尾自动选择 release 或 snapshot repository。

PUT 请求会按文件扩展名设置合理的 `Content-Type`（`.jar` → `application/java-archive`，`.pom`/`.xml` → `application/xml`，`.module` → `application/json`，校验文件 → `text/plain`，其他 → `application/octet-stream`）。

默认勾选 dry-run，只生成上传计划，不实际上传。

#### 失败详情与仅重试失败项（v3.4）

- 上传过程中的每一项失败会带回完整诊断字段：`statusCode`、`error`、`bodySnippet`（响应正文前 1KB）、`contentType`、`url`、`size`，并合成 `detail` 字段（如 `HTTP 400 | <Nexus 错误简述>`）写入上传报告 JSON。
- 前端「上传 Nexus」结果表格的失败行左侧带 `+/-` 切换按钮，点开后可看到上述全部字段；同时支持「只看失败」与「展开全部失败详情」两个快捷按钮，搜索框也支持按错误关键字过滤。
- 上传完成后会向底部日志抽屉写入结构化摘要（mode / total / success / failed / skipped / reportPath / 前 20 条失败样本），即使关掉浏览器也能在 `<bundle>/reports/upload-report-*.json` 里翻历史。
- 「仅重试失败项」按钮：上传完成且仍有失败时启用，点击后只对上一次报告里 `status === 'failed'` 的 item 重新发起 PUT，原报告中的成功项以 `previously-uploaded` 状态原样写入新报告，避免全量重传。生成的新报告通过 `baseReportPath` 字段指回原报告。

API 调用方式（自动化场景可直接用）：

```http
POST /api/upload
{
  "workDir": "...",
  "targetBaseUrl": "http://nexus:8081",
  "targetRepository": "your-repo",
  "retryFailedOnly": true,
  "retryReportPath": "C:/path/to/reports/upload-report-1700000000000.json"
}
```

### 验证 fatjar 一致性

第 2 个标签页 “验证 fatjar 一致性” 用于回答：「我下载下来的依赖，是否能 1:1 对得上 Spring Boot fatjar 里实际运行用的 `BOOT-INF/lib/*.jar`？」

工作流程：

1. 用工具内置的零依赖 ZIP 读取器打开 fatjar；
2. 遍历 `BOOT-INF/lib/` 下所有 `*.jar`，按需对每个内嵌 jar 流式计算 SHA1，并尝试从内嵌 `META-INF/maven/<g>/<a>/pom.properties` 推断准确的 GAV，再从 fileName 解析出 classifier；
3. 扫描 `<bundle>/repo/` 下所有 `*.jar`，按 Maven 布局推断 group/artifact/version，并按 fileName 减去 `artifact-version` 前缀解析出 classifier，建立 `byKey`（`group:artifact:version[:classifier]`）与 `byFileName` 双重索引；
4. 匹配优先级：先按 `byKey` 精确命中，再回退到 `byFileName`；这样 `engine-server-0.0.93.1-plain.jar` 等 Spring Boot 子模块 plain.jar 能正确对齐；
5. 输出 4 类结果：
   - `matched`：坐标 + SHA1 全部一致；
   - `shaMismatch`：坐标对得上但 SHA1 不同；
   - `onlyInFatjar`：fatjar 用到的 jar 在 bundle 中缺失，**必须关注**；
   - `onlyInBundle`：bundle 中存在但 fatjar 没有（一般是 testRuntime、annotationProcessor、buildscript classpath、plugin marker 等不会进入 fatjar 的依赖）。

页面会给出 4 张数字摘要卡 + 结果 tab 表格，`summary.consistent` 为 true 表示 fatjar 所有运行时依赖在 bundle 中均能 SHA1 对齐。

## 自签证书

页面上有两个相关选项：

- 下载侧“忽略 HTTPS 自签证书校验”；
- 上传侧“上传时忽略 HTTPS 自签证书校验”。

Node.js 下载/上传会按该选项关闭证书校验。Gradle 侧也会注入一个 best-effort 的 trust-all SSL 逻辑，但部分 Gradle/HTTP client 场景仍可能要求把自签 CA 正式导入 JDK truststore。

## 已知边界

1. Spring Boot `bootJar` / 普通 Java `jar` 的运行依赖通常以 `runtimeClasspath` 为准。
2. 如果你们使用 Shadow plugin 的 `minimize()`、relocation、自定义 include/exclude，最终 fatjar 内容可能不等于 `runtimeClasspath`，需要按项目定制；验证页面的 `shaMismatch`/`onlyInFatjar` 通常会直接暴露这种差异。
3. Gradle plugin DSL 的依赖导出是 best-effort：工具会捕获带版本号的 plugin request，并解析 `<plugin-id>:<plugin-id>.gradle.plugin:<version>` marker 依赖。通过复杂 resolutionStrategy 动态替换的插件，需要在源仓库覆盖中确保仓库可访问。
4. 本地 `files(...)` / `fileTree(...)` 依赖不会伪造成 Maven 坐标，会放入 `local-files/` 并写入 manifest。
5. 外部依赖的 `.module` 文件并非所有仓库都有；缺失时记录 warning。POM 缺失会记录 error，因为离线 Maven/Gradle 解析通常需要 POM。
6. fatjar 验证目前只识别 Spring Boot 默认布局（`BOOT-INF/lib/`）。如果用 shadowJar relocate 把依赖类直接拍进根 jar，则没有 `BOOT-INF/lib/`，验证模块会显示 `fatjarLibCount = 0`，需要另行人工对比。
7. v3.3 起 project artifact 保留 classifier：旧版本生成的 bundle（不带 classifier）在重新跑「一键拉取并整理」时仍会保留旧文件，建议勾选「下载前清空导出目录」获得干净的 layout，避免新旧命名共存。
8. 前端使用原生 ES Module（`<script type="module">`），需要现代浏览器（Chrome 87+ / Edge 87+ / Firefox 78+ / Safari 14+）。零外部依赖、零 CDN，完全可在内网环境离线运行。
9. v3.5 默认会遍历所有 `canBeResolved` configuration，覆盖范围显著扩大，`manifest.summary.metadataFiles` 与 `warnings/errors` 数量会比 v3.4 明显增加；这通常代表“采集到了更多构建期链路”，不等同于失败。
10. 若源仓库本身缺失某些 POM（尤其 parent/BOM），工具会在 `manifest.errors` 中显式给出坐标与尝试 URL；此类缺口需要先在源仓库补齐，目标仓库才能做到完整可构建。

## 安全提示

本工具会在本机执行你指定目录下的 Gradle wrapper 或系统 Gradle。只在可信源码目录中使用。

## v3 修复说明

- 修复 v2 在某些 Gradle 8.14 / version catalog 场景中把 authentication/credentials 误作用到 `file://` Maven 仓库，导致 `Authentication scheme 'all'(Authentication) is not supported by protocol 'file'` 的问题。
- 页面源仓库 URL 中如包含 `file://` 或本地路径，程序会保留为仓库但不会注入账号密码，也不会设置 `allowInsecureProtocol`。
- 对项目脚本后续追加的非 HTTP(S) Maven 仓库，会尽力清理 authentication 容器，避免 file 协议认证异常。

## 本次（v3.1）变更

- 把 60KB 的 `server.js` 拆成 `lib/` 下 14 个高内聚低耦合模块，单文件不再超大；入口 `server.js` 仅 22 行。
- 修复 `repoUrlsFromResolution` 把页面账号密码塞进 `file://` 仓库的回归。
- 修复 `file://` 仓库与 wrapper distributionUrl 在 Windows 下 `new URL().pathname` 形如 `/D:/...` 导致复制失败的问题，统一改用 `url.fileURLToPath`。
- `isFileUrl` 同时兼容 Java URI toString 输出的 `file:/C:/...` 单斜杠形式；`mavenLocal()` 不再被误判为「不识别的协议」。
- Gradle wrapper distribution 改为流式落盘，避免大文件 (100MB+) 整体读到内存。
- HTTP 下载与 metadata 请求支持 30x 重定向（services.gradle.org 默认 307 跳转到 downloads.gradle.org）。
- `runGradle` 在 spawn 失败 (`child.on('error')`) 或超时路径下也清理临时 init script 目录，杜绝 `%TEMP%/ogn-init-*` 残留。
- `extractJsonFromGradle` 改为 `lastIndexOf`，避免被项目自身 println 中可能出现的 `@@OGN_JSON_*` 标记干扰。
- 修复 resolve init script 中 task `doLast` 闭包直接调用 `project(path)` 在 Gradle 8.x 上报 `Could not find method project()` 的问题，改为 `gradle.rootProject.project(path)`。
- `~/.jdks` 扫描跳过 IntelliJ IDEA 写入的 `.<jdk>.intellij` 隐藏配置目录，不再误判为 JDK。
- `manifest.json` 写入时附带 `summary` 字段，前端“扫描本地导出目录”不再永远 fallback。
- PUT 上传按文件扩展名设置合理的 `Content-Type`（`.jar`/`.pom`/`.module` 等）。
- 新增 “验证 fatjar 一致性” 标签页与 `/api/verify-fatjar` 接口，及零依赖最小 ZIP/JAR 读取器（含 ZIP64 支持）。

## 本次（v3.2）变更

### v3.3 Bug 修复

- 彻底修复 `__ognResolve` 任务在 Gradle 8.x 上报 `Could not find method project() for arguments [:xxx] on task ':__ognResolve' of type org.gradle.api.DefaultTask` 的问题。
  - 根因：在 `doLast {}` 闭包里 `def rootProj = gradle.rootProject` 是局部变量，被嵌套 `each {}` 闭包引用时，Groovy 8.x 走 OWNER_FIRST 解析失败、落回 delegate（Task）查 `project(String)` 找不到方法。
  - 解决：把 `__ognResolve` 与 `__ognInspect` 的 task 体拆成脚本顶层 `def ogn...()` 函数，内部一律用 `gradle.rootProject` 直接寻址，不再依赖 doLast 的局部变量被嵌套闭包捕获。

### 性能优化

- 默认启用 Gradle daemon（去掉 `--no-daemon`）。原先每次调用都会冷启动 JVM 导致 inspect/resolve/download 单次都要 1 分钟以上；启用 daemon 后第二次起 5~15 秒。
- 默认追加 `--parallel`、`--build-cache`，关闭 `configuration-cache`（本工具的 init script 不兼容 cc，强制关闭避免缓存命中旧 JSON）。
- `/api/resolve` 返回 `cacheToken`，前端把它带回 `/api/download`，服务端命中后跳过整轮 Gradle 解析；同时通过参数指纹（`workDir`/`targetProject`/`configurations`/`sourceRepos` 等）做二次校验，参数一变就 miss，杜绝 stale。缓存 TTL 默认 10 分钟，进程级最多 32 条。
- bundle 阶段拷贝 jar、生成 POM/.module/校验文件、下载 metadata 全部用 `pMapWithLimit` 受限并行（拷贝/元数据各 8 路并发）。
- `writeChecksums` 与 `generateGradleModuleMetadata` 改为单次流式读取算 sha1+md5（或 sha512/256/1/md5）一次性写出，对同一个 jar 的 I/O 从 4 次缩减为 1 次。
- API 响应、`manifest.summary` 都带上 `elapsedMs`，前端按钮显示实时计时（"识别 Gradle 工程（12s）"），并标注 `fromCache` 信息。

### 体验改进

- 前端长任务按钮（识别 / 分析 / 一键拉取 / 验证 / 上传 / 扫描）统一改为带秒表的 `startTimer`，用户能直观看到等了多久而不是停留在 "执行中..."。
- `/api/inspect` 返回 `elapsedMs`，`/api/resolve` 返回 `elapsedMs` 与 `cacheToken`，`createBundle` 在 `manifest.summary` 里写入 `elapsedMs` 与 `resolveFromCache`。

### 可调参数（POST body 可选项）

- `useDaemon: false`：禁用 daemon，强制走单次 JVM；默认 true。
- `parallel: false`：禁用 `--parallel`；默认 true。
- `buildCache: false`：禁用 `--build-cache`；默认 true。
- `gradleQuiet: true`：附加 `-q`；默认不带。
- `cacheToken: "xxx"`：从最近一次 `/api/resolve` 拿来传给 `/api/download`，命中且参数指纹一致时跳过 Gradle 阶段。

## 本次（v3.3）变更

### Bug 修复

- **依赖树展示错位**：旧版前端只取「第一个 configuration === runtimeClasspath 且未 skipped 的 result」，当目标模块的 runtimeClasspath 被 skipped 或解析失败时，会静默 fallback 到 root 项目的 buildscript classpath，导致选了 `:engine-spring-boot-test` 却显示根项目的空树。新版按 `(ownerProject, configuration)` 分组生成 result tabs，目标模块的 runtimeClasspath / testRuntimeClasspath / annotationProcessor / testAnnotationProcessor 永远在最前；当所选 tab 被 skipped 或 graphFailure 时直接给出错误提示，不再 fallback。buildscript classpath 与 `__gradlePluginMarkers` 各自独立成 tab，让用户能完整看到所有 result。
- **fatjar 验证 9 个 only-in-fatjar 误报**：旧版 `bundle.js#copyProjectArtifact` 把源 `engine-server-0.0.93.1-plain.jar` 重命名为 `engine-server-0.0.93.1.jar`（丢掉 classifier），fatjar 一致性比对按 fileName 找不到而误判为 only-in-fatjar。新增 `util.js#parseClassifiedJarFileName`，bundle 一侧严格保留 classifier；fatjar 验证一侧 `indexBundleJars` + `readFatjarLibs` 同时解析 classifier，匹配优先级改为 `(group, artifact, version, classifier)` 精确命中、fileName 回退。

### 体验改进（UI 整体重做，零外部依赖）

- 全新视觉系统：清晰层级、足够留白、稳定栅格；卡片式现代布局取代旧 `.card + grid + pre` 的简陋样式。
- **顶部 toolbar**：工程目录与「识别 Gradle 工程」按钮置顶，识别成功后即时回填工程信息（Gradle 版本 / JDK / 模块数 / Wrapper 状态 / Distribution URL）。
- **配置面板可折叠**：基础配置默认展开，源仓库覆盖默认收起，避免长表单挤占主工作区。
- **依赖树视图**：result tabs + 左侧可折叠搜索树 + 右侧节点详情面板（GAV / displayName / selectionReason / repositoryName / artifact 文件路径）；搜索自动展开命中节点的祖先链；提供「展开全部 / 收起全部」按钮。
- **fatjar 验证**：4 张数字摘要卡 + 结论横条 + 4 个结果 tab，`onlyInFatjar` 默认置首并标红；每个 tab 是真正的 `<table>`，支持搜索、按行展开详情、复制路径，不再原样 dump JSON。
- **上传 Nexus**：状态列用色块 pill（uploaded / failed / dry-run）替代纯文本；URL 与报告路径附带复制按钮；可按路径 / repository / 状态 / 错误过滤。
- **底部日志抽屉**：默认收起，提供顶部计数徽章；展开后查看流水日志，再点击关闭按钮回收，永远不挤占主内容。
- **长任务阶段标签**：按钮在任务执行时显示 `${baseLabel}（${当前阶段} · ${秒数}s）`，例如 `分析依赖树（解析 ResolutionResult · 18s）`、`一键拉取并整理（拷贝 module artifact · 30s）`。

### v3.3 文件结构

- `public/app.js` 拆成 `public/js/{main,api,dom,state,progress}.js` 与 `public/js/ui/{header,config,inspect,tree,verify,upload,log}.js`，每个模块小于 300 行；前端用原生 `<script type="module">` 加载。
- `lib/util.js` 新增 `parseClassifiedJarFileName`；`lib/bundle.js` 新增 `planProjectArtifacts` 并重写 `copyProjectArtifact` 为 leader-aware 调度；`lib/fatjar-verify.js` 新增 `classifierFromFileName` / `buildBundleKey` 与 `byKey` 索引。

## 本次（v3.4）变更

### v3.4 Bug 修复

- **fatjar 验证里仅 `spring-boot-jarmode-layertools` 误报为 only-in-fatjar**：根因不是 classifier 命名，而是该 jar 完全不在用户 `runtimeClasspath` / buildscript / plugin marker 中——它由 `spring-boot-gradle-plugin` 在打 fatjar 阶段额外注入到 `BOOT-INF/lib/`。修复：在 `lib/gradle-init-scripts.js` 中新增 `ognDetectSpringBootVersion` 与 `ognBuildSpringBootBundled`，用 detached configuration 同时尝试 `spring-boot-jarmode-layertools`（≤3.2.x）与 `spring-boot-jarmode-tools`（≥3.3）；对外通过 `OGN_INCLUDE_SPRING_BOOT_BUNDLED` 环境变量 + 前端「包含 Spring Boot 内置 jar」开关控制，默认开启。

### v3.4 体验改进

- **上传失败必有详情**：`lib/bundle-upload.js` 把每个失败 item 补全 `statusCode` / `error` / `bodySnippet` / `contentType` / `url` / `detail`；前端 `ui/upload.js` 在失败行左侧增加展开按钮，点开后用 `<dl class="upload-detail">` 列出全部诊断字段并提供「只看失败」/「展开全部失败详情」快捷操作；上传完成会向日志抽屉写入结构化摘要（含前 20 条失败样本）。
- **仅重试失败项**：`lib/bundle-upload.js` 增加 `retryFailedOnly` + `retryReportPath` 模式，仅重传上一次报告中 `failed` 的项；其它原样落入新报告并标注 `previously-uploaded`，新报告以 `baseReportPath` 指向旧报告，便于追溯。前端在上传操作行加「仅重试失败项」按钮（无失败或无报告时禁用）。

### v3.4 文件结构

- `lib/gradle-init-scripts.js`：新增 `ognDetectSpringBootVersion` / `ognBuildSpringBootBundled`，并在 `ognBuildResolveResults` 末尾附加 `__springBootBundled` result。
- `lib/bundle-upload.js`：抽出 `performUpload` / `pickRepository` / `describeFailure` / `uploadFull` / `uploadRetryFailed`，主入口 `uploadBundle` 路由到全量或重试模式。
- `public/js/ui/upload.js`：增加 `expanded` 集合管理失败行展开状态；新增 `renderFailureDetail` / `runRetryFailed` / `refreshRetryButton` / `logUploadResult`。
- `public/style.css`：新增 `.btn-warn`、`.status-pill.previously`、`.row-toggle`、`.upload-detail` 等样式。

### 已知边界（补充）

- 自动注入的 Spring Boot 内置 jar 只覆盖目前可见的两个 jarmode 模块；如果某天 Spring Boot 的 `bootJar` 在 `BOOT-INF/lib/` 中又新增其他自动注入 jar，需要在 `ognBuildSpringBootBundled` 的列表里追加坐标。
- 「仅重试失败项」依赖前端持有的最近一次 `reportPath`；如果刷新页面或换台机器，可以直接通过 `POST /api/upload` 带 `retryFailedOnly` + `retryReportPath` 复用磁盘上的报告 JSON。

## 本次（v3.5）变更

### v3.5 Bug 修复

- **`incomingCatalogForLibs0` 缺失 BOM 导致构建失败**：新增 `versionCatalogImports` 采集与 `__versionCatalogImports` 解析链路。实现方式是在 `settingsEvaluated` 反射读取 `DefaultVersionCatalogBuilder#importedCatalog.notation`，把 `from("g:a:v")` 的真实坐标注入 detached resolve（典型为 `com.thtf.base:management:0.0.98`），不再遗漏 version catalog 源工件。
- **二级 BOM 继续缺失（如 `spring-boot-dependencies` → `metrics-bom`）**：新增 POM 递归补齐，自动解析 `parent` + `dependencyManagement import BOM`，并逐轮拉取元数据，直到没有新增坐标或达到轮次上限。
- **仅覆盖目标模块导致子模块编译配置缺失（如 `:engine-core:jacocoAnt`）**：新增“全子模块可解析配置”采集路径，遍历每个项目 `canBeResolved=true` 的配置，补齐 jacoco/codegen/质量插件等构建期依赖。

### v3.5 文件结构

- `lib/gradle-init-scripts.js`
  - 新增 `ext.ognVersionCatalogImports` 与 `ognReadField`；
  - 在 `settingsEvaluated` 采集 version catalog import 坐标；
  - 新增 `ognBuildVersionCatalogImports`；
  - `ognBuildAllProjectClasspaths` 从“固定配置名列表”升级为“遍历所有 canBeResolved 配置”；
  - `__ognResolve` 输出追加 `versionCatalogImports`。
- `lib/inspect-resolve.js`
  - 新增 `includeVersionCatalogImports`、`includeAllProjectClasspaths` 指纹项；
  - 透传 `OGN_INCLUDE_VERSION_CATALOG_IMPORTS` 与 `OGN_INCLUDE_ALL_PROJECT_CLASSPATHS` 环境变量。
- `lib/maven-metadata.js`
  - 新增 `parsePomExtraModules`，支持解析 parent/import BOM；
  - 新增属性占位符解析（`${...}`），支持 BOM 版本由 `<properties>` 提供的场景。
- `lib/bundle.js`
  - 新增 `collectPomDerivedModules`；
  - 在 metadata 阶段追加“POM 递归补齐”循环，持续拉取二级 parent/BOM 依赖。

### 实测结果（workflow-engine）

- `help` 任务从 `incomingCatalogForLibs0` 失败恢复为成功；
- `:engine-spring-boot-test:build -x test` 在仅使用目标仓库 `hjk-test-delete-after-20260531` 的情况下可成功完成；
- 全仓 `build -x test` 不再出现“依赖找不到”类错误，失败点变为业务侧 `jacoco` 覆盖率阈值规则（属于项目质量门禁，不是仓库依赖缺失）。

## 本次（v3.6）变更

### v3.6 Bug 修复

- **「项目仓库切到只读目标 Nexus」场景仍缺依赖（如 5 个 `base-futool-*-SNAPSHOT-plain.jar`、`guava`、`reflections`）**：根因是用户已把项目 `repositories { ... }` 改为只指目标 Nexus，旧版「源仓库覆盖」会进一步**清空**工程仓库再以输入项替换，反而把工程内必要的 plugin/wrapper 仓库也一起抹掉了，导致 resolve 完全失败或回到空目标 Nexus 找不到 SNAPSHOT。修复：把 `lib/gradle-init-scripts.js` 内 `ognConfigureRepoHandler` 改写为 `ognMergeExtraRepos`，按 URL 去重后**前置追加**到所有 4 个 RepositoryHandler，保留工程原仓库实例不动；环境变量改名为 `OGN_EXTRA_REPOS_JSON`（保留 `OGN_REPO_OVERRIDE_JSON` 作为兼容别名）。
- **fatjar 验证里 `guava-31.1-jre.jar` 显示 GAV 为 `com.google.guava:guava:31.1-jre:jre` 等错位**：根因是 `lib/fatjar-verify.js#parseJarFileNameToGav` 用正则 `/-[A-Za-z]/` 划分 version/classifier，把 `31.1-jre`、`2.0.0-SNAPSHOT-plain` 等版本尾部当成了 classifier；当 pom.properties 给出权威 version 后又用 `|| lib.gav.classifier` 把朴素切分得到的错误 classifier 回灌到最终 GAV，导致 byKey 不命中。修复：新增已知 classifier 白名单（plain/sources/javadoc/tests/native/jdk\* 等），文件名解析只在最后一个连字符段命中已知 classifier 时才认定；同时去掉 inferGavFromInnerJar 之后那段错误 fallback，让权威 GAV + `classifierFromFileName` 单一可信。
- **`compileClasspath` 暴露的项目 classes 目录被当 jar 复制引发 60 条 EPERM**：根因是 `bundle.js` 直接 `fs.copyFile(a.file, ...)`，但部分 configuration 暴露的 variant 是目录路径（如 `engine-server/build/classes/java/main`）。修复：`lib/util.js` 新增 `isRegularFile`，`lib/bundle.js` 在收集 artifact 阶段过滤非常规文件，并在 `manifest.warnings` 留下一条 `artifact-not-regular-file`，不再触发 copyFile。
- **同一 project plain.jar 被多 configuration 并发复制引发 EBUSY 文件锁**：根因是 `runtimeClasspath / testRuntimeClasspath / annotationProcessor` 等都会暴露同一份 `engine-util-0.0.93.1-plain.jar`。修复：`lib/bundle.js` 把项目 artifact 与本地 file artifact 收集容器改为 `Map<srcPath, artifact>`，按源文件路径去重后再喂给 `pMapWithLimit`。

### v3.6 文件结构

- `lib/gradle-init-scripts.js`
  - `ognReadRepoSpecs` → `ognReadExtraRepoSpecs`（同时兼容 `OGN_EXTRA_REPOS_JSON` 与历史 `OGN_REPO_OVERRIDE_JSON`）；
  - `ognConfigureRepoHandler` → `ognMergeExtraRepos`：清空 + 重建为「extras 优先 + 原 repo 实例原样接回」，并新增 `ognNormalizeRepoUrl` 做 URL 去重；
  - 删除 `if (ognHasRepoOverride) ognConfigureRepoHandler ... else ognApplyCredentialsToHandler`分支，统一改为「先注入凭据，再追加额外仓库」两步走，在 `beforeSettings` / `settingsEvaluated` / `gradle.beforeProject` 三处都生效。
- `lib/gradle-runner.js`
  - `makeGradleEnv` 同时写出 `OGN_EXTRA_REPOS_JSON` 与 `OGN_REPO_OVERRIDE_JSON`，避免老版 init 脚本与新版互不可见。
- `lib/fatjar-verify.js`
  - `parseJarFileNameToGav` 用已知 classifier 白名单收紧推断；
  - `readFatjarLibs` 在 `inferGavFromInnerJar` 后不再保留旧 classifier 回退。
- `lib/util.js` 新增 `isRegularFile`，并 export。
- `lib/bundle.js`
  - 新增 `isRegularFile` import；
  - `createBundle` 内 artifact 收集环节增加目录型 artifact 过滤 + 按源文件 dedup。
- `public/index.html`
  - `repoConfig` 容器默认展开，标题与说明改为「额外源仓库（仅 inspect/resolve 阶段叠加）」，明确「不会清空工程原仓库」。

### v3.6 真实链路验证（workflow-engine）

- inspect 抓到 `versionCatalogImports: ['com.thtf.base:management:0.0.98']`，4 个 RepositoryHandler 都出现 `ogn-source-1`（即额外的 `maven-public`）+ 工程原 `hjk-test-...` 两条仓库；
- resolve 命中 5 个 `com.thtf.base:base-futool-*:2.0.0-SNAPSHOT`，failures 仅剩 `spring-boot-jarmode-tools:3.2.4`（Spring Boot 3.2.x 不存在该变体，正常）；
- download 产出 209 个 artifact、445 个 metadata、**0 errors**（v3.5 的 60 条 EPERM + 2 条 EBUSY 全部消除）；
- upload 2010/2010 全部 PUT 成功（含 5 个 base-futool 的 jar/pom/module/checksum，共 45 项）；
- verify-fatjar：`matched: 130, shaMismatch: 0, onlyInFatjar: 0, consistent: true`；
- 在 workflow-engine 工程清掉 `.gradle` 与 `~/.gradle/caches/modules-2/files-2.1/com.thtf.base` 后，`:engine-spring-boot-test:assemble -x test` **从干净环境跑成功**，包括 `bootJar` 任务全部完成。

### v3.6 已知边界（补充）

- 「额外源仓库」是追加语义。如果工程原仓库本身就是错的（如 URL 拼错），额外仓库能补齐依赖但不会修正原仓库；如果用户希望强行替换，需要自己改 `settings.gradle` / `build.gradle`。
- `fatjar-verify` 的 classifier 白名单是基于真实生产场景的常见命名收录，没收录的 classifier（如自定义 `linux-musl-x86_64`）会被并入 version 字段。这会让对应行的 GAV 显示偏窄，但**不会**误判为 only-in-fatjar，因为 bundle 一侧也走同一套解析、`byKey` 一致；如发现新需要识别的 classifier，请在 `KNOWN_CLASSIFIER_SET` 中追加。
- 目录型 artifact 被跳过后，`manifest.warnings` 中类型为 `artifact-not-regular-file`；如果某天发现自家工程依赖的 jar 被错当成目录跳过（极少见），可以从 warning 反向定位。

## 本次（v3.7）变更

### v3.7 Bug 修复

- **动态版本（`+` / `latest.release` / 区间）切到目标 Nexus 后解析失败**：根因是逐文件 PUT 到 Nexus 不会自动重建 `maven-metadata.xml`，导致 `com.thtf.base:base-credential-*-spring-boot-starter:+`、`com.thtf.base:system-sdk:+` 等在目标仓库报 `no versions available`。修复：新增 GA 级 `maven-metadata.xml` 生成器，在所有 POM/jar 落盘后扫描 `repo/` 的 Maven 布局，为每个 `group:artifact` 写出含全部已存在版本（及 `latest`/`release`/`lastUpdated`、`.sha1`/`.md5`）的 metadata，随 bundle 一并上传，作为动态版本可被解析的前提。
- **POM 用 Maven 内置属性（`${project.version}` 等）引用的坐标被静默漏抓**：根因是 `parsePomExtraModules` 只认工程 `<properties>` 自定义属性。`cn.dev33:sa-token-parent` 在 `dependencyManagement` 里以 `import` 方式引入 `sa-token-dependencies:${project.version}`，占位符无法求值被直接跳过，导致目标仓库缺 `sa-token-dependencies`，进而 Gradle 报 `Could not parse POM sa-token-parent` → `Could not find sa-token-dependencies`。修复：新增 `readProjectGav` + `buildPomPropertyScope`，把 `project.version/groupId/artifactId`、`project.parent.version` 等 Maven 内置保留字纳入属性域；`parsePomExtraModules` 改为返回 `{ modules, unresolved }`，可求值的坐标进入递归补齐，仍不可求值的（属性定义在更上层 parent）记录到 `warnings`，缺口可见、可诊断而非静默丢失。
- **POM 闭包递归由“固定轮次”改为 BFS**：原实现按有限轮次循环，多级 parent/import 链较深时可能未收敛。改为对“新落盘 POM”的广度优先遍历，沿 `parent` + `dependencyManagement import BOM` 边逐层补齐，直到没有新增坐标为止（`guard` 仅用于防御异常环）。

### v3.7 文件结构

- `lib/maven-metadata.js`
  - 新增 `readProjectGav`、`buildPomPropertyScope`：解析 POM 自身坐标与 parent，组装含 Maven 内置属性的属性域；
  - `parsePomExtraModules` 改为返回 `{ modules, unresolved }`，支持 `${project.version}` 等内置占位符求值；
  - 新增 `mavenTimestamp`、`compareMavenVersions`、`buildMavenMetadataXml`（GA 级 `maven-metadata.xml` 生成）。
- `lib/bundle.js`
  - 新增 `pomPathForModule`、`writeRepositoryMetadata`；
  - `collectPomDerivedModules` 适配 `{ modules, unresolved }` 新返回类型，并对不可求值的 parent/import 记录 `pom-extra-version-unresolved` warning；
  - POM 递归补齐由固定轮次改为 BFS；在所有 POM/jar 落盘后调用 `writeRepositoryMetadata` 生成 GA 级 `maven-metadata.xml`。

### v3.7 真实链路验证（agent-development-executor-server）

- 目标仓库 `http://192.168.9.235:8081/repository/zntpt/`，源仓库 164 的 `maven-public` + `maven-snapshots`；
- bundle 产出含新生成的 GA `maven-metadata.xml` 与 sa-token 闭包（`sa-token-dependencies`/`sa-token-bom`/`oss-parent`），upload **9981/9981** 全部 PUT 成功；
- HTTP 复核：`base-credential-client/server/driver-all-spring-boot-starter`、`system-sdk` 等的 `maven-metadata.xml` 均返回 200，且 `+` 解析到的版本（client→`0.0.21.6`、system-sdk→`0.0.3`）其 `-plain.jar` + `.module` + `.pom` 均已在目标仓库（这些库以 Gradle Module Metadata 发布，实际产物为 `-plain.jar`，解析以 `.module` 为准）；
- **最严格验证**：用全新空 `GRADLE_USER_HOME`（仅以目录联接复用本机 gradle-8.4 发行版，无任何依赖缓存），强制所有依赖 / 插件（spring-boot 3.2.4、dependency-management 1.1.4、buildinfo、jib 等 marker+impl）/ 版本目录（`com.thtf.base:management:0.0.98`）全部从 235 实时解析，`.\gradlew.bat :application-web:bootJar` **BUILD SUCCESSFUL（5m13s，53/53 任务执行）**，产出 `agent-development-executor-server-0.1.4.1.jar`（约 383MB 的 Spring Boot 可执行胖包）。

## 本次（v3.8）变更

### v3.8 Bug 修复

- **import BOM 版本属性定义在父 POM 时被静默漏抓，离线构建报 `Could not parse POM`**：典型案例为 `com.alibaba:fastjson:2.0.58`——其 `dependencyManagement` 以 `scope=import` 引入 `spring-framework-bom:${springframework5.version}`、`spring-data-bom:${springdata2021.version}`、`spring-security-bom:${springsecurity5.version}`，而这 3 个属性定义在父 POM `com.alibaba.fastjson2:fastjson2-parent:2.0.58` 的 `<properties>` 中。v3.7 的 `parsePomExtraModules` 只用本 POM 属性域求值，这 3 个 BOM 被归入 `unresolved` 仅记 warning，目标仓库因此缺失 `spring-security-bom:5.8.8` 等坐标，Gradle 解析 fastjson effective POM 时直接失败。修复分两层：
  - `lib/maven-metadata.js` 新增 `collectAncestorProps`：沿 `parent` 链读取 repo 目录已落盘的祖先 POM，合并其 `<properties>`（就近祖先优先，与 Maven 子覆盖父的继承语义一致）；`buildPomPropertyScope` / `parsePomExtraModules` 接受祖先属性域入参；`resolvePomValue` 同时支持整段（`${a.version}`）与内嵌（`1.2.${patch}`）占位符迭代求值。
  - `lib/bundle.js` 的 POM 闭包 BFS 升级为父链属性感知：父链尚未完整落盘且存在未求值占位符的 POM 进入 pending，待其父 POM 在后续轮次下载落盘后自动重扫求值；BFS 收敛后仍无法求值的才写入 `pom-extra-version-unresolved` warning（附 `missingParent` 字段），缺口可见、可诊断。

### v3.8 真实链路验证（fine-tuning-configuration-server）

- 代码级：用 164 源仓库的真实 `fastjson-2.0.58.pom` + `fastjson2-parent-2.0.58.pom` 模拟两轮 BFS，第 1 轮正确挂起 3 个占位符 import 并报告 missingParent，第 2 轮父 POM 落盘后精确提取 `spring-framework-bom:5.3.31`、`spring-data-bom:2021.2.18`、`spring-security-bom:5.8.8`；
- bundle 重跑：608 个 artifact、2016 个 metadata、**0 errors、0 条 pom-extra-version-unresolved**（v3.7 下同场景该 warning 非零且对应坐标缺失）；
- upload **7884/7884** 全部 PUT 成功至 235 `zntpt`，5 个关键 POM（3 个 spring BOM + fastjson2-parent + fastjson）HTTP 复核均 200；
- 终验：全新空 `GRADLE_USER_HOME`（仅联接复用 wrapper 发行版），工程仓库仅指向 235 `zntpt`，`.\gradlew.bat :application-web:clean :application-web:build -x test` **BUILD SUCCESSFUL（2m50s）**，曾失败的 `:application-web:bootJar` 任务正常完成，产出约 350MB 的 Spring Boot 胖包。
