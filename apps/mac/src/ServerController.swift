import Foundation

private let logTailBytes = 4000

/// 本地服务的生命周期：探测（复用）→ 需要时拉起 `scripts/start.mjs` → 退出只停自己拉起的进程。
final class ServerController {
    let rootURL: URL
    let port: Int
    let node: NodeInvocation?
    let extraPathDirs: [String]

    private(set) var process: Process?
    private(set) var spawned = false
    private var logHandle: FileHandle?
    private var pollTimer: Timer?
    private var finished = false

    init(rootURL: URL, port: Int, node: NodeInvocation?, extraPathDirs: [String]) {
        self.rootURL = rootURL
        self.port = port
        self.node = node
        self.extraPathDirs = extraPathDirs
    }

    /// 请求 /api/health（回调可能在后台线程）。
    func ping(timeout: TimeInterval = 1.0, completion: @escaping (Bool) -> Void) {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/health") else {
            completion(false)
            return
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        URLSession.shared.dataTask(with: request) { _, response, _ in
            if let http = response as? HTTPURLResponse {
                completion((200..<300).contains(http.statusCode))
            } else {
                completion(false)
            }
        }.resume()
    }

    /// 拉起服务并轮询健康检查；`progress` 用于更新启动界面文案。
    func start(progress: @escaping (String) -> Void, completion: @escaping (Result<Void, Error>) -> Void) {
        if spawned {
            completion(.success(()))
            return
        }
        guard FileManager.default.fileExists(atPath: rootURL.appendingPathComponent("scripts/start.mjs").path) else {
            completion(.failure(ServerError.rootMissing(rootURL.path)))
            return
        }
        guard let node = node else {
            completion(.failure(ServerError.nodeMissing))
            return
        }

        let log = openLog()
        let process = Process()
        process.executableURL = node.executableURL
        process.arguments = node.arguments(script: rootURL.appendingPathComponent("scripts/start.mjs"), port: port)
        process.currentDirectoryURL = rootURL
        process.environment = childEnvironment(node: node)
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = log
        process.standardError = log

        do {
            try process.run()
        } catch {
            closeLog()
            completion(.failure(ServerError.spawnFailed(error.localizedDescription)))
            return
        }

        self.process = process
        self.spawned = true
        writeLogHeader()
        AppLog.write("已拉起服务 pid=\(process.processIdentifier) node=\(node.displayPath) port=\(port)")

        let startedAt = Date()
        let deadline = startedAt.addingTimeInterval(300)
        var lastReportedSecond = -1

        let timer = Timer(timeInterval: 0.4, repeats: true) { [weak self] timer in
            guard let self = self else {
                timer.invalidate()
                return
            }
            if self.finished {
                timer.invalidate()
                return
            }
            self.ping(timeout: 0.8) { [weak self] alive in
                guard let self = self else { return }
                DispatchQueue.main.async {
                    if self.finished { return }
                    if alive {
                        self.finished = true
                        timer.invalidate()
                        progress("服务已就绪")
                        AppLog.write("健康检查通过（\(Int(Date().timeIntervalSince(startedAt)))s）")
                        completion(.success(()))
                        return
                    }
                    if !process.isRunning {
                        self.finished = true
                        timer.invalidate()
                        let tail = self.logTail()
                        AppLog.write("服务进程提前退出（启动日志尾部已记录）")
                        completion(.failure(ServerError.exited(tail)))
                        return
                    }
                    if Date() > deadline {
                        self.finished = true
                        timer.invalidate()
                        completion(.failure(ServerError.timeout(self.logTail())))
                        return
                    }
                    let elapsed = Int(Date().timeIntervalSince(startedAt))
                    if elapsed >= 3, elapsed % 3 == 0, elapsed != lastReportedSecond {
                        lastReportedSecond = elapsed
                        progress("正在启动本地服务…（已等待 \(elapsed) 秒，首次启动需要编译）")
                    }
                }
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer
    }

    /// 只终止自己拉起的进程；复用的服务不会被碰。
    func stop(completion: @escaping () -> Void) {
        finished = true
        pollTimer?.invalidate()
        pollTimer = nil

        guard let process = process, process.isRunning else {
            closeLog()
            completion()
            return
        }
        let pid = process.processIdentifier
        AppLog.write("正在停止自己拉起的服务 pid=\(pid)")
        process.terminate()

        DispatchQueue.global().asyncAfter(deadline: .now() + 1.5) { [weak self] in
            if process.isRunning {
                // start.mjs 的子进程（node apps/server/dist/index.js）不会被 SIGKILL 传播，先按父进程清理
                let pkill = Process()
                pkill.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
                pkill.arguments = ["-TERM", "-P", String(pid)]
                try? pkill.run()
                pkill.waitUntilExit()
                kill(pid, SIGKILL)
            }
            DispatchQueue.main.async {
                self?.closeLog()
                AppLog.write("服务已停止")
                completion()
            }
        }
    }

    /// 退出应用时使用：同步清理（最多等 `timeout` 秒），避免 AppKit 的
    /// `.terminateLater` 嵌套事件循环不排空 main queue 导致退出卡死。
    func stopAndWait(timeout: TimeInterval = 2.0) {
        finished = true
        pollTimer?.invalidate()
        pollTimer = nil

        guard let process = process, process.isRunning else {
            closeLog()
            return
        }
        let pid = process.processIdentifier
        AppLog.write("正在停止自己拉起的服务 pid=\(pid)")

        // 先礼后兵：SIGTERM → 等 start.mjs 自己收尾 → 兜底 pkill -P + SIGKILL
        process.terminate()
        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning && Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
        }
        if process.isRunning {
            let pkill = Process()
            pkill.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
            pkill.arguments = ["-TERM", "-P", String(pid)]
            try? pkill.run()
            pkill.waitUntilExit()
            kill(pid, SIGKILL)
        }
        closeLog()
        AppLog.write("服务已停止")
    }

    func logTail() -> String {
        guard let data = try? Data(contentsOf: AppPaths.serverLog) else { return "" }
        return String(decoding: data.suffix(logTailBytes), as: UTF8.self)
    }

    // MARK: - 私有

    private func openLog() -> FileHandle? {
        AppPaths.prepare()
        if !FileManager.default.fileExists(atPath: AppPaths.serverLog.path) {
            FileManager.default.createFile(atPath: AppPaths.serverLog.path, contents: nil)
        }
        let handle = try? FileHandle(forWritingTo: AppPaths.serverLog)
        _ = try? handle?.seekToEnd()
        logHandle = handle
        return handle
    }

    private func writeLogHeader() {
        let line = "\n===== \(ISO8601DateFormatter().string(from: Date())) Super Work 服务启动（端口 \(port)）=====\n"
        try? logHandle?.write(contentsOf: Data(line.utf8))
    }

    private func closeLog() {
        try? logHandle?.close()
        logHandle = nil
    }

    private func childEnvironment(node: NodeInvocation) -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        var paths: [String] = []
        paths.append(node.executableURL.deletingLastPathComponent().path)
        paths.append(contentsOf: extraPathDirs)
        paths.append(contentsOf: ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])
        if let existing = environment["PATH"], !existing.isEmpty {
            paths.append(existing)
        }
        var seen = Set<String>()
        let unique = paths.filter { !$0.isEmpty && seen.insert($0).inserted }
        environment["PATH"] = unique.joined(separator: ":")
        environment["HOME"] = environment["HOME"] ?? NSHomeDirectory()
        environment["SUPER_WORK_PORT"] = String(port)
        if environment["LANG"] == nil { environment["LANG"] = "zh_CN.UTF-8" }
        return environment
    }
}

enum ServerError: LocalizedError {
    case rootMissing(String)
    case nodeMissing
    case spawnFailed(String)
    case exited(String)
    case timeout(String)

    var errorDescription: String? {
        switch self {
        case .rootMissing(let path):
            return """
            没有找到 Super Work 项目目录：\(path) 下缺少 scripts/start.mjs。

            把应用放回项目的 apps/mac/build/ 目录，或：
            · 设置环境变量 SUPER_WORK_ROOT=/path/to/super-work
            · 或在 \(AppPaths.configFile.path) 里写 {"root": "/path/to/super-work"}
            """
        case .nodeMissing:
            return """
            没有找到 Node.js（需要 22 或更高版本）。

            安装 Node 后重启应用；也可以设置环境变量 SUPER_WORK_NODE 指向 node 可执行文件。
            """
        case .spawnFailed(let message):
            return "无法启动本地服务：\(message)"
        case .exited(let tail):
            return "本地服务启动后立即退出。\n\n最近的日志：\n\(tail.isEmpty ? "（见 \(AppPaths.serverLog.path)）" : tail)"
        case .timeout(let tail):
            return "本地服务启动超时（300 秒）。\n\n最近的日志：\n\(tail.isEmpty ? "（见 \(AppPaths.serverLog.path)）" : tail)"
        }
    }
}
