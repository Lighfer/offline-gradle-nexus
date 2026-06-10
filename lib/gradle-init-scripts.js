'use strict';

// 注入到 Gradle 的 init script 模板。
// 这些脚本通过 -I 参数传给 Gradle，借助 Gradle 自身完成依赖图解析与仓库识别，
// 避免在 Node 侧手工解析 build.gradle / settings.gradle。

const JSON_START = '@@OGN_JSON_START@@';
const JSON_END = '@@OGN_JSON_END@@';

// 通用部分：仓库覆盖、凭据注入、SSL 信任、依赖图收集函数等。
const GRADLE_COMMON = String.raw`
import groovy.json.JsonOutput
import groovy.json.JsonSlurper
import org.gradle.api.artifacts.component.ModuleComponentIdentifier
import org.gradle.api.artifacts.component.ProjectComponentIdentifier
import org.gradle.api.artifacts.repositories.MavenArtifactRepository
import org.gradle.api.artifacts.result.ResolvedDependencyResult
import org.gradle.api.artifacts.result.UnresolvedDependencyResult
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager
import java.security.SecureRandom
import java.security.cert.X509Certificate

ext.ognJsonStart = '` + JSON_START + String.raw`'
ext.ognJsonEnd = '` + JSON_END + String.raw`'
ext.ognPluginRequests = []
ext.ognPluginRepos = []
ext.ognSettingsRepos = []
ext.ognVersionCatalogImports = []

def ognReadExtraRepoSpecs() {
    // 「额外源仓库」：仅在 inspect/resolve 阶段叠加到用户工程现有仓库 *前部*，
    // 不清空原 repo，专门用于「用户已经把仓库切到只读目标 Nexus，但目标仓库里还没有这些依赖」的场景。
    // 兼容旧字段 OGN_REPO_OVERRIDE_JSON：若仅设置了旧字段也会按追加语义生效，避免历史调用方爆掉。
    def txt = System.getenv('OGN_EXTRA_REPOS_JSON') ?: System.getenv('OGN_REPO_OVERRIDE_JSON') ?: ''
    if (!txt.trim()) return []
    try { return new JsonSlurper().parseText(txt) as List } catch (Throwable t) { return [] }
}

def ognBoolEnv(String name) {
    return String.valueOf(System.getenv(name) ?: '').equalsIgnoreCase('true')
}

// 反射读字段：兼容 Gradle Decorated 类型（字段可能定义在父类）。
def ognReadField(Object obj, String fieldName) {
    if (obj == null || fieldName == null) return null
    def k = obj.getClass()
    while (k != null) {
        try {
            def f = k.getDeclaredField(fieldName)
            f.setAccessible(true)
            return f.get(obj)
        } catch (Throwable ignored) {}
        k = k.getSuperclass()
    }
    return null
}

def ognTrustAllSslIfRequested() {
    if (!ognBoolEnv('OGN_TRUST_ALL_SSL')) return
    try {
        def trustAll = [
            [
                checkClientTrusted: { X509Certificate[] chain, String authType -> },
                checkServerTrusted: { X509Certificate[] chain, String authType -> },
                getAcceptedIssuers: { -> new X509Certificate[0] }
            ] as X509TrustManager
        ] as TrustManager[]
        SSLContext sc = SSLContext.getInstance('SSL')
        sc.init(null, trustAll, new SecureRandom())
        HttpsURLConnection.setDefaultSSLSocketFactory(sc.getSocketFactory())
        HttpsURLConnection.setDefaultHostnameVerifier({ String hostname, session -> true } as HostnameVerifier)
    } catch (Throwable ignored) {}
}
ognTrustAllSslIfRequested()

def ognRepoToMap(repo) {
    def m = [name: String.valueOf(repo.name), type: repo.getClass().getName()]
    try { if (repo.hasProperty('url')) m.url = String.valueOf(repo.url) } catch (Throwable ignored) {}
    try { if (repo.hasProperty('allowInsecureProtocol')) m.allowInsecureProtocol = repo.allowInsecureProtocol } catch (Throwable ignored) {}
    // 注意：不要在这里读取 repo.credentials。Gradle 对 MavenArtifactRepository 的 credentials 是惰性对象，
    // 仅仅读取就可能创建一个 username=null 的凭据对象，从而在解析依赖时触发 "Username must not be null"。
    m.hasCredentials = null
    m.credentialsSource = String.valueOf(System.getenv('OGN_SOURCE_USERNAME') ?: '').trim().length() > 0 ? 'page-override' : 'not-inspected'
    return m
}

def ognRepoUrl(repo) {
    try { return String.valueOf(repo.url ?: '') } catch (Throwable ignored) { return '' }
}

def ognIsHttpUrl(String url) {
    def u = String.valueOf(url ?: '').toLowerCase(Locale.ROOT)
    return u.startsWith('http://') || u.startsWith('https://')
}

def ognIsHttpMavenRepo(repo) {
    if (!(repo instanceof MavenArtifactRepository)) return false
    return ognIsHttpUrl(ognRepoUrl(repo))
}

def ognClearAuthenticationIfNonHttp(repo) {
    try {
        if ((repo instanceof MavenArtifactRepository) && !ognIsHttpMavenRepo(repo)) {
            // Gradle 8.x 中 file:// Maven 仓库一旦带 authentication/credentials，解析时会报
            // "Authentication scheme 'all'(Authentication) is not supported by protocol 'file'"。
            // 这里不读取 credentials，避免懒创建 username=null；只尽力清掉 authentication 容器。
            try { repo.authentication.clear() } catch (Throwable ignored) {}
        }
    } catch (Throwable ignored) {}
}

def ognApplyCredentials(repo) {
    try {
        if (!(repo instanceof MavenArtifactRepository)) return
        if (!ognIsHttpMavenRepo(repo)) {
            ognClearAuthenticationIfNonHttp(repo)
            return
        }
        def u = System.getenv('OGN_SOURCE_USERNAME') ?: ''
        def p = System.getenv('OGN_SOURCE_PASSWORD') ?: ''
        def hasPageUser = u.trim().length() > 0
        def fillEmpty = ognBoolEnv('OGN_FILL_EMPTY_CREDENTIALS')
        // 只对 HTTP(S) Maven 仓库设置凭据，避免 file:// 仓库被错误配置 authentication。
        // 页面填写账号时强制覆盖；未填写账号时填空串，专门规避 username=null 的 Gradle 异常。
        if (hasPageUser || fillEmpty) {
            repo.credentials {
                username = hasPageUser ? u : ''
                password = hasPageUser ? p : ''
            }
        }
        if (ognBoolEnv('OGN_ALLOW_INSECURE')) {
            try { repo.allowInsecureProtocol = true } catch (Throwable ignored) {}
        }
    } catch (Throwable ignored) {}
}

def ognApplyCredentialsToHandler(handler) {
    try { handler.all { repo -> ognApplyCredentials(repo) } } catch (Throwable ignored) {}
}

def ognNormalizeRepoUrl(String u) {
    def s = String.valueOf(u ?: '').trim()
    while (s.endsWith('/')) s = s.substring(0, s.length() - 1)
    return s.toLowerCase(Locale.ROOT)
}

def ognMergeExtraRepos(handler, specs) {
    // 把「额外源仓库」前置注入到指定 RepositoryHandler：
    // 1) 保留工程原有仓库（用户工程已声明的 Maven repo 全部保留）；
    // 2) 在已有列表 *前部* 插入额外仓库，让 Gradle 优先在更完整的上游里查询依赖；
    // 3) 仍然走 ognApplyCredentials 给所有 http(s) repo 统一注入凭据/SSL 信任开关；
    // 4) 按 URL 去重：beforeSettings/settingsEvaluated/beforeProject 会重复调用，
    //    若 spec 的 URL 已经存在则跳过，避免同一仓库被重复注入若干份。
    if (!specs || specs.size() == 0) return
    def originals = []
    try { handler.each { originals << it } } catch (Throwable ignored) {}
    def existingUrls = [] as Set
    originals.each {
        try { existingUrls << ognNormalizeRepoUrl(it.url) } catch (Throwable ignored) {}
    }
    def specsToAdd = specs.findAll { spec ->
        def normalized = ognNormalizeRepoUrl(String.valueOf(spec.url ?: ''))
        normalized.length() > 0 && !existingUrls.contains(normalized)
    }
    if (specsToAdd.size() == 0) {
        // 没有新仓库要添加；只确保现有仓库都已套用凭据策略即可，避免无谓地 clear+rebuild。
        try { handler.all { repo -> ognApplyCredentials(repo) } } catch (Throwable ignored) {}
        return
    }
    try { handler.clear() } catch (Throwable ignored) {}
    specsToAdd.eachWithIndex { spec, idx ->
        try {
            handler.maven { MavenArtifactRepository r ->
                name = String.valueOf(spec.name ?: ('ogn-extra-' + idx))
                def rawUrl = String.valueOf(spec.url ?: '').trim()
                url = uri(rawUrl)
                def specIsHttp = ognIsHttpUrl(rawUrl)
                def u = String.valueOf(spec.username ?: '')
                if (specIsHttp && (u.trim().length() > 0 || ognBoolEnv('OGN_FILL_EMPTY_CREDENTIALS'))) {
                    credentials {
                        username = u.trim().length() > 0 ? u : ''
                        password = u.trim().length() > 0 ? String.valueOf(spec.password ?: '') : ''
                    }
                } else if (!specIsHttp) {
                    ognClearAuthenticationIfNonHttp(r)
                }
                try { if (specIsHttp) allowInsecureProtocol = Boolean.valueOf(String.valueOf(spec.allowInsecureProtocol ?: false)) } catch (Throwable ignored) {}
            }
        } catch (Throwable t) {
            println('OGN extra repo failed: ' + t.message)
        }
    }
    // 重新追加工程原 repo 实例，保持其原有 credentials 与配置。
    originals.each { try { handler.add(it) } catch (Throwable ignored) {} }
    // 对后续 settings.gradle / build.gradle 再追加的仓库也立即修正凭据。
    try { handler.all { repo -> ognApplyCredentials(repo) } } catch (Throwable ignored) {}
}

def ognExtraRepoSpecs = ognReadExtraRepoSpecs()
def ognHasExtraRepos = ognExtraRepoSpecs != null && ognExtraRepoSpecs.size() > 0

beforeSettings { settings ->
    try {
        settings.pluginManagement.resolutionStrategy.eachPlugin { details ->
            try {
                def req = details.requested
                if (req != null && req.version != null) {
                    gradle.ext.ognPluginRequests << [id: String.valueOf(req.id.id), version: String.valueOf(req.version)]
                }
            } catch (Throwable ignored) {}
        }
    } catch (Throwable ignored) {}
    try {
        ognApplyCredentialsToHandler(settings.pluginManagement.repositories)
        if (ognHasExtraRepos) ognMergeExtraRepos(settings.pluginManagement.repositories, ognExtraRepoSpecs)
        settings.pluginManagement.repositories.all { repo ->
            try { gradle.ext.ognPluginRepos << ognRepoToMap(repo) } catch (Throwable ignored) {}
        }
    } catch (Throwable ignored) {}
    // Version catalog 会在 settings 评估期间解析，凭据必须在 settingsEvaluated 之前注入。
    try {
        ognApplyCredentialsToHandler(settings.dependencyResolutionManagement.repositories)
        if (ognHasExtraRepos) ognMergeExtraRepos(settings.dependencyResolutionManagement.repositories, ognExtraRepoSpecs)
        settings.dependencyResolutionManagement.repositories.all { repo ->
            try { gradle.ext.ognSettingsRepos << ognRepoToMap(repo) } catch (Throwable ignored) {}
        }
    } catch (Throwable ignored) {}
}

settingsEvaluated { settings ->
    try {
        ognApplyCredentialsToHandler(settings.dependencyResolutionManagement.repositories)
        if (ognHasExtraRepos) ognMergeExtraRepos(settings.dependencyResolutionManagement.repositories, ognExtraRepoSpecs)
        settings.dependencyResolutionManagement.repositories.all { repo ->
            try { gradle.ext.ognSettingsRepos << ognRepoToMap(repo) } catch (Throwable ignored) {}
        }
    } catch (Throwable ignored) {}
    // 采集 versionCatalog 的 from(...) 源坐标（如 com.foo:management:1.2.3），
    // 后续在 resolve 阶段单独解析该坐标，避免构建时 incomingCatalogFor* 缺失。
    try {
        settings.dependencyResolutionManagement.versionCatalogs.each { c ->
            try {
                def imported = ognReadField(c, 'importedCatalog')
                def notation = ognReadField(imported, 'notation')
                if (notation != null) {
                    def txt = String.valueOf(notation).trim()
                    if (txt.length() > 0) gradle.ext.ognVersionCatalogImports << txt
                }
            } catch (Throwable ignored2) {}
        }
        gradle.ext.ognVersionCatalogImports = (gradle.ext.ognVersionCatalogImports ?: []).toSet().toList()
    } catch (Throwable ignored) {}
}

gradle.beforeProject { p ->
    try {
        ognApplyCredentialsToHandler(p.buildscript.repositories)
        if (ognHasExtraRepos) ognMergeExtraRepos(p.buildscript.repositories, ognExtraRepoSpecs)
    } catch (Throwable ignored) {}
    try {
        ognApplyCredentialsToHandler(p.repositories)
        if (ognHasExtraRepos) ognMergeExtraRepos(p.repositories, ognExtraRepoSpecs)
    } catch (Throwable ignored) {}
}

def ognComponentIdToMap(cid) {
    def m = [displayName: String.valueOf(cid.displayName), className: cid.getClass().getName()]
    if (cid instanceof ModuleComponentIdentifier) {
        m.type = 'module'
        m.group = String.valueOf(cid.group)
        m.module = String.valueOf(cid.module)
        m.version = String.valueOf(cid.version)
        m.id = 'module:' + m.group + ':' + m.module + ':' + m.version
    } else if (cid instanceof ProjectComponentIdentifier) {
        m.type = 'project'
        m.projectPath = String.valueOf(cid.projectPath)
        m.id = 'project:' + m.projectPath
    } else {
        m.type = 'other'
        m.id = 'other:' + m.displayName
    }
    return m
}

def ognArtifactName(p) {
    try {
        def base = p.extensions.findByName('base')
        if (base != null && base.hasProperty('archivesName')) {
            def v = base.archivesName.get()
            if (v != null && String.valueOf(v).trim().length() > 0) return String.valueOf(v)
        }
    } catch (Throwable ignored) {}
    try {
        def v = p.hasProperty('archivesBaseName') ? p.property('archivesBaseName') : null
        if (v != null && String.valueOf(v).trim().length() > 0) return String.valueOf(v)
    } catch (Throwable ignored) {}
    return String.valueOf(p.name)
}

def ognProjectInfo(p) {
    def g = String.valueOf(p.group == null ? '' : p.group)
    if (g == 'unspecified') g = ''
    def v = String.valueOf(p.version == null ? '' : p.version)
    if (v == 'unspecified') v = ''
    def taskNames = []
    try { taskNames = p.tasks.names as List } catch (Throwable ignored) {}
    return [
        path: String.valueOf(p.path),
        name: String.valueOf(p.name),
        group: g,
        version: v,
        artifact: ognArtifactName(p),
        projectDir: String.valueOf(p.projectDir),
        buildFile: String.valueOf(p.buildFile),
        description: p.description == null ? '' : String.valueOf(p.description),
        tasks: taskNames.findAll { it in ['jar','bootJar','shadowJar','war','bootWar'] },
        jarTaskPath: taskNames.contains('jar') ? String.valueOf(p.path == ':' ? ':jar' : p.path + ':jar') : null,
        bootJarTaskPath: taskNames.contains('bootJar') ? String.valueOf(p.path == ':' ? ':bootJar' : p.path + ':bootJar') : null,
        shadowJarTaskPath: taskNames.contains('shadowJar') ? String.valueOf(p.path == ':' ? ':shadowJar' : p.path + ':shadowJar') : null
    ]
}

def ognDirectDependenciesFor(configuration) {
    def out = []
    try {
        def rr = configuration.incoming.resolutionResult
        rr.root.dependencies.each { dep ->
            if (dep instanceof ResolvedDependencyResult) {
                out << [requested: String.valueOf(dep.requested.displayName), selected: ognComponentIdToMap(dep.selected.id)]
            } else if (dep instanceof UnresolvedDependencyResult) {
                out << [requested: String.valueOf(dep.requested.displayName), unresolved: true, failure: String.valueOf(dep.failure == null ? '' : dep.failure.message)]
            }
        }
    } catch (Throwable t) {
        out << [unresolved: true, failure: String.valueOf(t.message)]
    }
    return out
}

def ognResolveConfiguration(ownerProject, configuration, label) {
    def result = [label: label, ownerProject: String.valueOf(ownerProject.path), configuration: String.valueOf(configuration.name), canBeResolved: configuration.canBeResolved]
    if (!configuration.canBeResolved) {
        result.skipped = true
        result.reason = 'Configuration is not resolvable'
        return result
    }
    def components = []
    def edges = []
    def unresolved = []
    def artifacts = []
    def artifactFailures = []
    try {
        def rr = configuration.incoming.resolutionResult
        rr.allComponents.each { c ->
            def cm = ognComponentIdToMap(c.id)
            cm.selectionReason = String.valueOf(c.selectionReason)
            cm.repositoryName = null
            try { cm.repositoryName = String.valueOf(c.repositoryName) } catch (Throwable ignored) {}
            components << cm
        }
        rr.allDependencies.each { dep ->
            if (dep instanceof ResolvedDependencyResult) {
                edges << [from: ognComponentIdToMap(dep.from.id).id, to: ognComponentIdToMap(dep.selected.id).id, requested: String.valueOf(dep.requested.displayName), constraint: dep.constraint]
            } else if (dep instanceof UnresolvedDependencyResult) {
                unresolved << [from: ognComponentIdToMap(dep.from.id).id, requested: String.valueOf(dep.requested.displayName), failure: String.valueOf(dep.failure == null ? '' : dep.failure.message)]
            }
        }
        result.root = ognComponentIdToMap(rr.root.id).id
        result.directDependencies = ognDirectDependenciesFor(configuration)
    } catch (Throwable t) {
        result.graphFailure = String.valueOf(t.message)
    }
    try {
        def view = configuration.incoming.artifactView { viewConfig -> viewConfig.lenient(true) }
        view.artifacts.artifacts.each { a ->
            artifacts << [component: ognComponentIdToMap(a.id.componentIdentifier), file: String.valueOf(a.file.absolutePath), fileName: String.valueOf(a.file.name), variant: String.valueOf(a.variant.displayName)]
        }
        view.artifacts.failures.each { f -> artifactFailures << String.valueOf(f.message) }
    } catch (Throwable t) {
        artifactFailures << String.valueOf(t.message)
    }
    result.components = components
    result.edges = edges
    result.unresolved = unresolved
    result.artifacts = artifacts
    result.artifactFailures = artifactFailures
    return result
}

def ognCollectRepositories(rootProject) {
    def repos = []
    try { repos.addAll((gradle.ext.ognPluginRepos ?: [])) } catch (Throwable ignored) {}
    try { repos.addAll((gradle.ext.ognSettingsRepos ?: [])) } catch (Throwable ignored) {}
    try {
        rootProject.allprojects.each { p ->
            p.buildscript.repositories.each { r -> repos << (ognRepoToMap(r) + [scope: 'buildscript', project: String.valueOf(p.path)]) }
            p.repositories.each { r -> repos << (ognRepoToMap(r) + [scope: 'project', project: String.valueOf(p.path)]) }
        }
    } catch (Throwable ignored) {}
    return repos
}
`;

// inspect 任务：列出多模块工程基本信息、wrapper、仓库快照、plugin request 等。
// 同样使用脚本顶层函数 + gradle.rootProject 直接寻址，避免 doLast 局部变量在嵌套闭包中失效。
const INSPECT_INIT = GRADLE_COMMON + String.raw`
def ognBuildProjectsSnapshot() {
    def projects = []
    gradle.rootProject.allprojects.each { p ->
        def confs = []
        try {
            p.configurations.each { c ->
                confs << [name: String.valueOf(c.name), canBeResolved: c.canBeResolved, canBeConsumed: c.canBeConsumed, description: c.description == null ? '' : String.valueOf(c.description)]
            }
        } catch (Throwable ignored) {}
        def info = ognProjectInfo(p)
        info.configurations = confs
        projects << info
    }
    return projects
}

def ognReadWrapperInfo() {
    def wrapper = [:]
    try {
        def f = new File(gradle.rootProject.projectDir, 'gradle/wrapper/gradle-wrapper.properties')
        if (f.exists()) {
            def props = new Properties()
            f.withInputStream { props.load(it) }
            wrapper.exists = true
            wrapper.path = String.valueOf(f.absolutePath)
            wrapper.distributionUrl = String.valueOf(props.getProperty('distributionUrl') ?: '')
            wrapper.distributionSha256Sum = String.valueOf(props.getProperty('distributionSha256Sum') ?: '')
        } else {
            wrapper.exists = false
        }
    } catch (Throwable t) {
        wrapper.error = String.valueOf(t.message)
    }
    return wrapper
}

gradle.projectsLoaded {
    gradle.rootProject.tasks.register('__ognInspect') {
        group = 'offline-gradle-nexus'
        doLast {
            def out = [
                generatedAt: new Date().format("yyyy-MM-dd'T'HH:mm:ssXXX"),
                gradleVersion: String.valueOf(gradle.gradleVersion),
                rootProject: ognProjectInfo(gradle.rootProject),
                projects: ognBuildProjectsSnapshot(),
                repositories: ognCollectRepositories(gradle.rootProject),
                pluginRequests: gradle.ext.ognPluginRequests,
                versionCatalogImports: gradle.ext.ognVersionCatalogImports,
                wrapper: ognReadWrapperInfo(),
                javaHome: System.getProperty('java.home'),
                userDir: System.getProperty('user.dir')
            ]
            println(gradle.ext.ognJsonStart)
            println(JsonOutput.prettyPrint(JsonOutput.toJson(out)))
            println(gradle.ext.ognJsonEnd)
        }
    }
}
`;

// resolve 任务：对指定模块按配置项解析依赖图与 artifact，并附加 buildscript / plugin marker 解析。
// 关键注意：doLast 闭包内的 `def` 局部变量，在 Gradle 8.x 某些场景下不能被嵌套 each 闭包正确捕获，
// Groovy 会把未解析变量名落到 delegate（即 Task），从而触发
//   Could not find method project() for arguments [:xxx] on task ':__ognResolve'
// 因此一律改为脚本顶层函数 + gradle.rootProject 直接寻址，不依赖闭包捕获局部变量。
const RESOLVE_INIT = GRADLE_COMMON + String.raw`
def ognDetectSpringBootVersion() {
    // 优先从 plugin requests（settings 阶段捕获的 plugins {} DSL）取版本；
    // 其次扫描所有项目的 buildscript classpath，找 org.springframework.boot:spring-boot-gradle-plugin 的版本。
    def v = null
    try {
        def req = (gradle.ext.ognPluginRequests ?: []).find { String.valueOf(it.id) == 'org.springframework.boot' }
        if (req != null && req.version != null) v = String.valueOf(req.version)
    } catch (Throwable ignored) {}
    if (v != null) return v
    try {
        gradle.rootProject.allprojects.each { p ->
            try {
                def bc = p.buildscript.configurations.findByName('classpath')
                if (bc == null) return
                bc.incoming.resolutionResult.allComponents.each { c ->
                    if (c.id instanceof ModuleComponentIdentifier) {
                        def cid = c.id
                        if (String.valueOf(cid.group) == 'org.springframework.boot' && String.valueOf(cid.module) == 'spring-boot-gradle-plugin') {
                            v = String.valueOf(cid.version)
                        }
                    }
                }
            } catch (Throwable ignored) {}
        }
    } catch (Throwable ignored) {}
    return v
}

def ognBuildSpringBootBundled(target, springBootVersion) {
    // Spring Boot bootJar 在打包 layered fatjar 时会把 jarmode 工具直接拍进 BOOT-INF/lib/。
    //   - 3.0~3.2.x：spring-boot-jarmode-layertools
    //   - 3.3+    ：spring-boot-jarmode-tools
    // 这两个模块都不在用户的 runtimeClasspath / buildscript / plugin marker 里，仅由 spring-boot-gradle-plugin 在 task 阶段额外注入。
    // 这里用 detached configuration + lenient 视图把它们顺便拉下来，让 fatjar 一致性比对能够 1:1 对齐。
    if (!springBootVersion) return null
    def deps = []
    ['spring-boot-jarmode-layertools', 'spring-boot-jarmode-tools'].each { name ->
        try { deps << target.dependencies.create('org.springframework.boot:' + name + ':' + springBootVersion) } catch (Throwable ignored) {}
    }
    if (deps.size() == 0) return null
    def dc = target.configurations.detachedConfiguration(deps as org.gradle.api.artifacts.Dependency[])
    dc.transitive = true
    def label = '__springBootBundled:' + springBootVersion
    return ognResolveConfiguration(target, dc, label)
}

def ognBuildVersionCatalogImports(target) {
    // settings.gradle 的 versionCatalogs { libs { from("g:a:v") } } 走的是 incomingCatalogFor* 内部配置，
    // 不会自然出现在 runtimeClasspath/buildscript/plugin marker 结果里。这里把 from(...) 的坐标补一次 detached resolve。
    def imports = (gradle.ext.ognVersionCatalogImports ?: []).collect { String.valueOf(it).trim() }.findAll { it.length() > 0 }
    if (imports.size() == 0) {
        return [label: '__versionCatalogImports', skipped: true, reason: '未发现 version catalog from(...) 坐标']
    }
    def deps = []
    def seen = [] as Set
    imports.each { n ->
        // 排除 projectLibs 这类 from(files("./libs.toml")) 的 file collection 文本表示。
        if (n.toLowerCase(Locale.ROOT).contains('file collection')) return
        if (!n.contains(':')) return
        try {
            if (!seen.contains(n)) {
                seen << n
                deps << target.dependencies.create(n)
            }
        } catch (Throwable ignored) {}
    }
    if (deps.size() == 0) {
        return [label: '__versionCatalogImports', skipped: true, reason: 'version catalog import 坐标不可解析（可能全是本地文件 catalog）']
    }
    def dc = target.configurations.detachedConfiguration(deps as org.gradle.api.artifacts.Dependency[])
    dc.transitive = true
    return ognResolveConfiguration(target, dc, '__versionCatalogImports')
}

def ognBuildAllProjectClasspaths() {
    // 为“把仓库整体迁移到新 Nexus 后仍能编译”的场景补齐构建期依赖：
    // 不再只限 compile/runtime/test，而是遍历所有 canBeResolved 配置（如 jacocoAnt、codegen、quality 插件配置等）。
    def out = []
    def seen = [] as Set
    gradle.rootProject.allprojects.each { p ->
        p.configurations.each { c ->
            if (c == null || !c.canBeResolved) return
            def cn = String.valueOf(c.name)
            def label = p.path + ':' + cn
            if (seen.contains(label)) return
            seen << label
            try {
                out << ognResolveConfiguration(p, c, label)
            } catch (Throwable t) {
                out << [label: p.path + ':' + cn, ownerProject: p.path, skipped: true, reason: String.valueOf(t.message)]
            }
        }
    }
    return out
}

def ognBuildResolveResults(target, configurations, includeBuildscript, includePlugins, includeSpringBootBundled, includeVersionCatalogImports, includeAllProjectClasspaths) {
    def results = []
    configurations.each { cn ->
        def c = target.configurations.findByName(cn)
        if (c != null) results << ognResolveConfiguration(target, c, target.path + ':' + cn)
        else results << [label: target.path + ':' + cn, ownerProject: target.path, configuration: cn, skipped: true, reason: 'Configuration not found']
    }
    if (includeBuildscript) {
        gradle.rootProject.allprojects.each { p ->
            try {
                def bc = p.buildscript.configurations.findByName('classpath')
                if (bc != null) results << ognResolveConfiguration(p, bc, p.path + ':buildscriptClasspath')
            } catch (Throwable t) {
                results << [label: p.path + ':buildscriptClasspath', ownerProject: p.path, skipped: true, reason: String.valueOf(t.message)]
            }
        }
    }
    if (includePlugins) {
        try {
            def markerDeps = []
            def seen = [] as Set
            (gradle.ext.ognPluginRequests ?: []).each { pr ->
                def id = String.valueOf(pr.id ?: '')
                def ver = String.valueOf(pr.version ?: '')
                def key = id + ':' + ver
                if (id.length() > 0 && ver.length() > 0 && !seen.contains(key)) {
                    seen << key
                    markerDeps << target.dependencies.create(id + ':' + id + '.gradle.plugin:' + ver)
                }
            }
            if (markerDeps.size() > 0) {
                def dc = target.configurations.detachedConfiguration(markerDeps as org.gradle.api.artifacts.Dependency[])
                dc.transitive = true
                results << ognResolveConfiguration(target, dc, '__gradlePluginMarkers')
            }
        } catch (Throwable t) {
            results << [label: '__gradlePluginMarkers', skipped: true, reason: String.valueOf(t.message)]
        }
    }
    if (includeSpringBootBundled) {
        try {
            def sbv = ognDetectSpringBootVersion()
            if (sbv != null && sbv.length() > 0) {
                def extra = ognBuildSpringBootBundled(target, sbv)
                if (extra != null) results << extra
                else results << [label: '__springBootBundled', skipped: true, reason: 'spring-boot-jarmode-* 解析为空（可能不是 Spring Boot 工程）']
            } else {
                results << [label: '__springBootBundled', skipped: true, reason: '未检测到 Spring Boot 版本（plugin requests 与 buildscript classpath 中均未找到 spring-boot-gradle-plugin）']
            }
        } catch (Throwable t) {
            results << [label: '__springBootBundled', skipped: true, reason: String.valueOf(t.message)]
        }
    }
    if (includeVersionCatalogImports) {
        try {
            results << ognBuildVersionCatalogImports(target)
        } catch (Throwable t) {
            results << [label: '__versionCatalogImports', skipped: true, reason: String.valueOf(t.message)]
        }
    }
    if (includeAllProjectClasspaths) {
        try {
            results.addAll(ognBuildAllProjectClasspaths())
        } catch (Throwable t) {
            results << [label: '__allProjectClasspaths', skipped: true, reason: String.valueOf(t.message)]
        }
    }
    return results
}

def ognCollectProjectPaths(results) {
    def projectPaths = [] as Set
    results.each { r ->
        try {
            (r.components ?: []).each { c ->
                if (c.type == 'project' && c.projectPath != null) projectPaths << String.valueOf(c.projectPath)
            }
        } catch (Throwable ignored) {}
    }
    return projectPaths
}

def ognBuildProjectRuntimeDirectDeps(projectPaths) {
    def map = [:]
    projectPaths.each { pp ->
        try {
            def p = gradle.rootProject.project(String.valueOf(pp))
            def rc = p.configurations.findByName('runtimeClasspath')
            if (rc != null && rc.canBeResolved) map[pp] = ognDirectDependenciesFor(rc)
        } catch (Throwable t) {
            map[pp] = [[unresolved: true, failure: String.valueOf(t.message)]]
        }
    }
    return map
}

def ognBuildAllProjectInfos() {
    def map = [:]
    gradle.rootProject.allprojects.each { p -> map[String.valueOf(p.path)] = ognProjectInfo(p) }
    return map
}

gradle.projectsLoaded {
    gradle.rootProject.tasks.register('__ognResolve') {
        group = 'offline-gradle-nexus'
        doLast {
            def targetPath = System.getenv('OGN_TARGET_PROJECT') ?: ':'
            def configText = System.getenv('OGN_CONFIGURATIONS') ?: 'runtimeClasspath'
            def includeBuildscript = String.valueOf(System.getenv('OGN_INCLUDE_BUILDSCRIPT') ?: 'true').equalsIgnoreCase('true')
            def includePlugins = String.valueOf(System.getenv('OGN_INCLUDE_PLUGINS') ?: 'true').equalsIgnoreCase('true')
            def includeSpringBootBundled = String.valueOf(System.getenv('OGN_INCLUDE_SPRING_BOOT_BUNDLED') ?: 'true').equalsIgnoreCase('true')
            def includeVersionCatalogImports = String.valueOf(System.getenv('OGN_INCLUDE_VERSION_CATALOG_IMPORTS') ?: 'true').equalsIgnoreCase('true')
            def includeAllProjectClasspaths = String.valueOf(System.getenv('OGN_INCLUDE_ALL_PROJECT_CLASSPATHS') ?: 'true').equalsIgnoreCase('true')
            def target = gradle.rootProject.project(targetPath)
            def configurations = configText.split(',').collect { it.trim() }.findAll { it.length() > 0 }
            def results = ognBuildResolveResults(target, configurations, includeBuildscript, includePlugins, includeSpringBootBundled, includeVersionCatalogImports, includeAllProjectClasspaths)
            def projectInfos = ognBuildAllProjectInfos()
            def projectPaths = ognCollectProjectPaths(results)
            def projectRuntimeDirectDependencies = ognBuildProjectRuntimeDirectDeps(projectPaths)
            def out = [
                generatedAt: new Date().format("yyyy-MM-dd'T'HH:mm:ssXXX"),
                gradleVersion: String.valueOf(gradle.gradleVersion),
                targetProject: targetPath,
                configurations: configurations,
                results: results,
                projectInfos: projectInfos,
                projectRuntimeDirectDependencies: projectRuntimeDirectDependencies,
                repositories: ognCollectRepositories(gradle.rootProject),
                pluginRequests: gradle.ext.ognPluginRequests,
                versionCatalogImports: gradle.ext.ognVersionCatalogImports,
                javaHome: System.getProperty('java.home')
            ]
            println(gradle.ext.ognJsonStart)
            println(JsonOutput.prettyPrint(JsonOutput.toJson(out)))
            println(gradle.ext.ognJsonEnd)
        }
    }
}
`;

module.exports = {
  JSON_START,
  JSON_END,
  GRADLE_COMMON,
  INSPECT_INIT,
  RESOLVE_INIT
};
