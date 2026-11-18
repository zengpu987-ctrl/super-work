import Foundation

/// 应用自己的配置 / 日志 / 用户覆盖配置路径。
enum AppPaths {
    static let supportDir: URL = FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("SuperWork", isDirectory: true)

    static let logsDir: URL = FileManager.default
        .urls(for: .libraryDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Logs/SuperWork", isDirectory: true)

    static var configFile: URL { supportDir.appendingPathComponent("config.json") }
    static var serverLog: URL { logsDir.appendingPathComponent("server.log") }
    static var appLog: URL { logsDir.appendingPathComponent("app.log") }

    static func prepare() {
        try? FileManager.default.createDirectory(at: supportDir, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: logsDir, withIntermediateDirectories: true)
    }
}

/// 轻量运行日志（排查启动问题用，不依赖 Console.app）。
enum AppLog {
    private static let formatter = ISO8601DateFormatter()

    static func write(_ message: String) {
        AppPaths.prepare()
        let line = "[\(formatter.string(from: Date()))] \(message)\n"
        guard let data = line.data(using: .utf8) else { return }
        if !FileManager.default.fileExists(atPath: AppPaths.appLog.path) {
            FileManager.default.createFile(atPath: AppPaths.appLog.path, contents: nil)
        }
        guard let handle = try? FileHandle(forWritingTo: AppPaths.appLog) else { return }
        defer { try? handle.close() }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: data)
    }
}

/// 启动 node 的方式：绝对路径 node，或 `/usr/bin/env node` 兜底。
struct NodeInvocation {
    let executableURL: URL
    let prefixArguments: [String]

    var displayPath: String {
        ([executableURL.path] + prefixArguments).joined(separator: " ")
    }

    func arguments(script: URL, port: Int) -> [String] {
        prefixArguments + [script.path, "--no-open", "--port", String(port)]
    }
}

/// 应用配置。优先级：环境变量 > 用户 config.json > 构建时写入的兜底值 > 自动探测。
struct AppConfig {
    let rootURL: URL
    let port: Int
    let node: NodeInvocation?
    let extraPathDirs: [String]

    var startScriptURL: URL { rootURL.appendingPathComponent("scripts/start.mjs") }
    var hasStartScript: Bool { FileManager.default.fileExists(atPath: startScriptURL.path) }

    static func load() -> AppConfig {
        AppPaths.prepare()
        let environment = ProcessInfo.processInfo.environment
        let config = readConfigJSON()
        let baked = bakedText("repo-root.txt")

        var rootPath = environment["SUPER_WORK_ROOT"]
        if rootPath == nil { rootPath = config["root"] as? String }
        if rootPath == nil { rootPath = baked }
        if rootPath == nil { rootPath = findRepoRoot() }
        if rootPath == nil { rootPath = NSHomeDirectory() + "/GZT/super-work" }

        var port = Int(environment["SUPER_WORK_PORT"] ?? "")
        if port == nil, let value = config["port"] as? Int { port = value }
        if port == nil, let value = config["port"] as? String { port = Int(value) }

        return AppConfig(
            rootURL: URL(fileURLWithPath: rootPath!, isDirectory: true),
            port: port ?? 7788,
            node: resolveNode(environment: environment, config: config),
            extraPathDirs: extraPathDirs()
        )
    }

    // MARK: - 配置读取

    private static func readConfigJSON() -> [String: Any] {
        guard let data = try? Data(contentsOf: AppPaths.configFile),
              let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any] else {
            return [:]
        }
        return dictionary
    }

    private static func bakedText(_ name: String) -> String? {
        guard let directory = Bundle.main.resourceURL else { return nil }
        guard let value = try? String(contentsOf: directory.appendingPathComponent(name), encoding: .utf8) else {
            return nil
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func extraPathDirs() -> [String] {
        guard let baked = bakedText("env-path.txt") else { return [] }
        return baked.split(separator: ":").map(String.init).filter { !$0.isEmpty }
    }

    // MARK: - 仓库目录探测

    /// 从 .app 位置逐级向上找“含 scripts/start.mjs + package.json(super-work)”的目录。
    private static func findRepoRoot() -> String? {
        var url = Bundle.main.bundleURL
        for _ in 0..<8 {
            url.deleteLastPathComponent()
            if url.path == "/" { break }
            let script = url.appendingPathComponent("scripts/start.mjs")
            guard FileManager.default.fileExists(atPath: script.path) else { continue }
            let package = url.appendingPathComponent("package.json")
            if let data = try? Data(contentsOf: package),
               let text = String(data: data, encoding: .utf8),
               text.contains("\"super-work\"") {
                return url.path
            }
        }
        return nil
    }

    // MARK: - Node 探测

    private static func resolveNode(environment: [String: String], config: [String: Any]) -> NodeInvocation? {
        var candidates: [String] = []

        if let value = environment["SUPER_WORK_NODE"], !value.isEmpty { candidates.append(value) }
        if let value = config["node"] as? String, !value.isEmpty { candidates.append(value) }
        if let value = bakedText("node-path.txt") { candidates.append(value) }

        candidates.append("/Users/zp/bin/node")
        candidates.append("/opt/homebrew/bin/node")
        candidates.append("/usr/local/bin/node")

        let home = NSHomeDirectory()
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: home + "/.nvm/versions/node") {
            for version in versions.sorted(by: >) {
                candidates.append(home + "/.nvm/versions/node/" + version + "/bin/node")
            }
        }
        if let loginShellNode = nodeFromLoginShell() { candidates.append(loginShellNode) }

        for candidate in candidates where isExecutable(candidate) {
            return NodeInvocation(executableURL: URL(fileURLWithPath: candidate), prefixArguments: [])
        }
        let envPath = "/usr/bin/env"
        if isExecutable(envPath) {
            return NodeInvocation(executableURL: URL(fileURLWithPath: envPath), prefixArguments: ["node"])
        }
        return nil
    }

    private static func isExecutable(_ path: String) -> Bool {
        !path.isEmpty && FileManager.default.isExecutableFile(atPath: path)
    }

    /// Finder 启动时 PATH 很干净，用登录 shell 再找一次（nvm / fnm / asdf 等）。
    private static func nodeFromLoginShell() -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", "command -v node"]
        process.standardError = FileHandle.nullDevice
        let pipe = Pipe()
        process.standardOutput = pipe
        do {
            try process.run()
        } catch {
            return nil
        }
        process.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let output = String(decoding: data, as: UTF8.self)
        for line in output.split(separator: "\n").reversed() {
            let candidate = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if isExecutable(candidate) { return candidate }
        }
        return nil
    }
}
