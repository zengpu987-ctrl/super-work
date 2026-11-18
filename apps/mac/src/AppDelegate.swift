import Cocoa
import Darwin
import Dispatch
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow?
    private var webView: WKWebView?
    private var config: AppConfig!
    private var server: ServerController?
    private var signalSources: [DispatchSourceSignal] = []
    private var loadingTimer: Timer?
    private var loadingStartedAt = Date()
    private var loadingPageLoaded = false
    private var appLoaded = false
    private var isTerminating = false

    // MARK: - 生命周期

    func applicationDidFinishLaunching(_ notification: Notification) {
        AppPaths.prepare()
        config = AppConfig.load()
        AppLog.write(
            "应用启动 · root=\(config.rootURL.path) · port=\(config.port) · node=\(config.node?.displayPath ?? "未找到")"
        )
        installSignalHandlers()
        setupMainMenu()
        setupWindow()
        begin()
    }

    func applicationWillTerminate(_ notification: Notification) {
        AppLog.write("应用退出")
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if isTerminating { return .terminateNow }
        isTerminating = true
        loadingTimer?.invalidate()
        loadingTimer = nil

        // 同步清理（最多 2 秒）。不要用 .terminateLater + NSApp.reply：
        // AppKit 的嵌套事件循环在部分 macOS 版本上不会排空 main queue，会导致退出卡死。
        server?.stopAndWait()
        return .terminateNow
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
        true
    }

    /// ⌘Q / 关闭窗口 / kill -TERM / kill -INT 都走正常的清理流程。
    private func installSignalHandlers() {
        for signalNumber in [SIGTERM, SIGINT] {
            signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
            source.setEventHandler {
                AppLog.write("收到信号 \(signalNumber)，准备退出")
                NSApp.terminate(nil)
            }
            source.resume()
            signalSources.append(source)
        }
    }

    // MARK: - 窗口

    private func setupWindow() {
        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        // 默认 1440×900；屏幕放不下时按可视区域收缩（保留一点边距），最小 1024×700
        let width = min(1440, max(1024, visible.width - 24))
        let height = min(900, max(700, visible.height - 40))
        let frame = NSRect(x: 0, y: 0, width: width, height: height)

        let window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Super Work"
        window.minSize = NSSize(width: 1024, height: 700)
        window.center()
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = NSColor(srgbRed: 10 / 255, green: 11 / 255, blue: 16 / 255, alpha: 1)
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.collectionBehavior.insert(.fullScreenPrimary)

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.preferences.setValue(true, forKey: "developerExtrasEnabled")

        let webView = WKWebView(frame: NSRect(origin: .zero, size: frame.size), configuration: configuration)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.underPageBackgroundColor = NSColor(srgbRed: 10 / 255, green: 11 / 255, blue: 16 / 255, alpha: 1)
        if #available(macOS 13.3, *) {
            webView.isInspectable = true
        }

        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        if #available(macOS 14.0, *) {
            NSApp.activate()
        } else {
            NSApp.activate(ignoringOtherApps: true)
        }

        self.window = window
        self.webView = webView
    }

    // MARK: - 启动流程：复用 / 拉起

    private func begin() {
        appLoaded = false
        loadingPageLoaded = false
        showLoading(status: "正在检查本机服务…", detail: "127.0.0.1:\(config.port)")

        let controller = ServerController(
            rootURL: config.rootURL,
            port: config.port,
            node: config.node,
            extraPathDirs: config.extraPathDirs
        )
        server = controller

        probe(controller, attempts: 3) { [weak self] alive in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if alive {
                    AppLog.write("复用已在运行的服务 http://127.0.0.1:\(self.config.port)")
                    self.loadApp()
                } else if !self.config.hasStartScript {
                    self.showFailure(ServerError.rootMissing(self.config.rootURL.path))
                } else {
                    self.spawnServer(controller)
                }
            }
        }
    }

    /// 探测时重试几次，避免和开发服务器的重启瞬间抢跑。
    private func probe(_ controller: ServerController, attempts: Int, completion: @escaping (Bool) -> Void) {
        controller.ping { [weak self] alive in
            if alive {
                completion(true)
                return
            }
            guard let self = self, attempts > 1 else {
                completion(false)
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                self.probe(controller, attempts: attempts - 1, completion: completion)
            }
        }
    }

    private func spawnServer(_ controller: ServerController) {
        updateLoading(status: "正在启动本地服务…", detail: "首次启动需要编译，可能需要 1~3 分钟")
        loadingStartedAt = Date()
        startLoadingTimer()

        controller.start(
            progress: { [weak self] status in
                DispatchQueue.main.async {
                    self?.updateLoading(status: status, detail: nil)
                }
            },
            completion: { [weak self] result in
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    self.stopLoadingTimer()
                    switch result {
                    case .success:
                        self.loadApp()
                    case .failure(let error):
                        self.showFailure(error)
                    }
                }
            }
        )
    }

    private func loadApp() {
        stopLoadingTimer()
        loadingPageLoaded = false
        appLoaded = true
        guard let url = URL(string: "http://127.0.0.1:\(config.port)/") else { return }
        AppLog.write("加载界面 \(url.absoluteString)")
        webView?.load(URLRequest(url: url))
    }

    // MARK: - 加载页 / 状态

    private func showLoading(status: String, detail: String) {
        loadingPageLoaded = true
        webView?.loadHTMLString(LoadingPage.html(status: status, detail: detail), baseURL: nil)
    }

    private func updateLoading(status: String, detail: String?) {
        guard let webView = webView else { return }
        if !loadingPageLoaded {
            showLoading(status: status, detail: detail ?? "")
            return
        }
        webView.evaluateJavaScript("setStatus(\(Self.jsLiteral(status)))", completionHandler: nil)
        if let detail = detail {
            webView.evaluateJavaScript("setDetail(\(Self.jsLiteral(detail)))", completionHandler: nil)
        }
    }

    private func startLoadingTimer() {
        stopLoadingTimer()
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            let seconds = Int(Date().timeIntervalSince(self.loadingStartedAt))
            guard seconds >= 3 else { return }
            let detail = "首次启动需要编译/安装依赖（最长 5 分钟）· 已等待 \(seconds) 秒 · 日志：~/Library/Logs/SuperWork/server.log"
            self.webView?.evaluateJavaScript("setDetail(\(Self.jsLiteral(detail)))", completionHandler: nil)
        }
        RunLoop.main.add(timer, forMode: .common)
        loadingTimer = timer
    }

    private func stopLoadingTimer() {
        loadingTimer?.invalidate()
        loadingTimer = nil
    }

    private func showFailure(_ error: Error) {
        let message = error.localizedDescription
        AppLog.write("启动失败：\(message)")
        updateLoading(status: "启动失败", detail: message)

        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Super Work 启动失败"
        alert.informativeText = message
        alert.addButton(withTitle: "重试")
        alert.addButton(withTitle: "打开日志")
        alert.addButton(withTitle: "退出")

        switch alert.runModal() {
        case .alertFirstButtonReturn:
            let previous = server
            server = nil
            if let previous = previous {
                previous.stop { [weak self] in
                    DispatchQueue.main.async { self?.begin() }
                }
            } else {
                begin()
            }
        case .alertSecondButtonReturn:
            NSWorkspace.shared.open(AppPaths.logsDir)
        default:
            NSApp.terminate(nil)
        }
    }

    // MARK: - 菜单

    private func setupMainMenu() {
        let mainMenu = NSMenu()

        // 应用菜单
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu(title: "Super Work")

        let aboutItem = NSMenuItem(title: "关于 Super Work", action: #selector(showAbout), keyEquivalent: "")
        aboutItem.target = self
        appMenu.addItem(aboutItem)
        appMenu.addItem(.separator())

        let logsItem = NSMenuItem(title: "打开日志目录", action: #selector(openLogs), keyEquivalent: "")
        logsItem.target = self
        appMenu.addItem(logsItem)
        let rootItem = NSMenuItem(title: "打开项目目录", action: #selector(openProjectRoot), keyEquivalent: "")
        rootItem.target = self
        appMenu.addItem(rootItem)
        appMenu.addItem(.separator())

        let servicesItem = NSMenuItem(title: "服务", action: nil, keyEquivalent: "")
        let servicesMenu = NSMenu(title: "服务")
        servicesItem.submenu = servicesMenu
        appMenu.addItem(servicesItem)
        NSApp.servicesMenu = servicesMenu
        appMenu.addItem(.separator())

        appMenu.addItem(
            withTitle: "隐藏 Super Work",
            action: #selector(NSApplication.hide(_:)),
            keyEquivalent: "h"
        )
        let hideOthersItem = NSMenuItem(
            title: "隐藏其他",
            action: #selector(NSApplication.hideOtherApplications(_:)),
            keyEquivalent: "h"
        )
        hideOthersItem.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(hideOthersItem)
        appMenu.addItem(
            withTitle: "显示全部",
            action: #selector(NSApplication.unhideAllApplications(_:)),
            keyEquivalent: ""
        )
        appMenu.addItem(.separator())
        appMenu.addItem(
            withTitle: "退出 Super Work",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        appMenuItem.submenu = appMenu

        // 编辑菜单（WKWebView 走响应链，⌘C/⌘V/⌘A 等可用）
        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        let redoItem = NSMenuItem(title: "重做", action: Selector(("redo:")), keyEquivalent: "z")
        redoItem.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(redoItem)
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "剪切", action: Selector(("cut:")), keyEquivalent: "x")
        editMenu.addItem(withTitle: "复制", action: Selector(("copy:")), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: Selector(("paste:")), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: Selector(("selectAll:")), keyEquivalent: "a")
        editMenuItem.submenu = editMenu

        // 显示菜单
        let viewMenuItem = NSMenuItem()
        mainMenu.addItem(viewMenuItem)
        let viewMenu = NSMenu(title: "显示")

        let reloadItem = NSMenuItem(title: "重新载入页面", action: #selector(reloadPage), keyEquivalent: "r")
        reloadItem.target = self
        viewMenu.addItem(reloadItem)

        let restartItem = NSMenuItem(title: "重新启动服务并载入", action: #selector(restartServer), keyEquivalent: "r")
        restartItem.target = self
        restartItem.keyEquivalentModifierMask = [.command, .shift]
        viewMenu.addItem(restartItem)
        viewMenu.addItem(.separator())

        let zoomInItem = NSMenuItem(title: "放大", action: #selector(zoomIn), keyEquivalent: "=")
        zoomInItem.target = self
        viewMenu.addItem(zoomInItem)
        let zoomOutItem = NSMenuItem(title: "缩小", action: #selector(zoomOut), keyEquivalent: "-")
        zoomOutItem.target = self
        viewMenu.addItem(zoomOutItem)
        let zoomResetItem = NSMenuItem(title: "实际大小", action: #selector(zoomReset), keyEquivalent: "0")
        zoomResetItem.target = self
        viewMenu.addItem(zoomResetItem)
        viewMenu.addItem(.separator())

        let fullScreenItem = NSMenuItem(
            title: "切换全屏幕",
            action: #selector(NSWindow.toggleFullScreen(_:)),
            keyEquivalent: "f"
        )
        fullScreenItem.keyEquivalentModifierMask = [.command, .control]
        viewMenu.addItem(fullScreenItem)
        viewMenuItem.submenu = viewMenu

        // 窗口菜单
        let windowMenuItem = NSMenuItem()
        mainMenu.addItem(windowMenuItem)
        let windowMenu = NSMenu(title: "窗口")
        windowMenu.addItem(
            withTitle: "最小化",
            action: #selector(NSWindow.performMiniaturize(_:)),
            keyEquivalent: "m"
        )
        windowMenu.addItem(
            withTitle: "缩放",
            action: #selector(NSWindow.performZoom(_:)),
            keyEquivalent: ""
        )
        windowMenu.addItem(.separator())
        windowMenu.addItem(
            withTitle: "关闭窗口",
            action: #selector(NSWindow.performClose(_:)),
            keyEquivalent: "w"
        )
        windowMenuItem.submenu = windowMenu
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = mainMenu
    }

    @objc private func showAbout() {
        let credits = NSAttributedString(
            string: "本机多模型联合工作台\n端口 \(config.port) · 数据与凭证只留在本机",
            attributes: [
                .font: NSFont.systemFont(ofSize: 11),
                .foregroundColor: NSColor.secondaryLabelColor,
            ]
        )
        NSApp.orderFrontStandardAboutPanel(options: [
            .applicationName: "Super Work",
            .applicationVersion: "0.0.3",
            .credits: credits,
        ])
    }

    @objc private func openLogs() {
        NSWorkspace.shared.open(AppPaths.logsDir)
    }

    @objc private func openProjectRoot() {
        NSWorkspace.shared.open(config.rootURL)
    }

    @objc private func reloadPage() {
        guard appLoaded, let webView = webView, let host = webView.url?.host, isLocalHost(host) else {
            restartFlow()
            return
        }
        webView.reload()
    }

    @objc private func restartServer() {
        restartFlow()
    }

    private func restartFlow() {
        let current = server
        server = nil
        appLoaded = false
        loadingPageLoaded = false
        showLoading(status: "正在重新启动…", detail: "")
        if let current = current {
            current.stop { [weak self] in
                DispatchQueue.main.async { self?.begin() }
            }
        } else {
            begin()
        }
    }

    @objc private func zoomIn() {
        guard let webView = webView else { return }
        webView.pageZoom = min(2.0, ((webView.pageZoom + 0.1) * 10).rounded() / 10)
    }

    @objc private func zoomOut() {
        guard let webView = webView else { return }
        webView.pageZoom = max(0.5, ((webView.pageZoom - 0.1) * 10).rounded() / 10)
    }

    @objc private func zoomReset() {
        webView?.pageZoom = 1.0
    }

    // MARK: - WKNavigationDelegate / WKUIDelegate

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        if let host = url.host, isLocalHost(host) {
            decisionHandler(.allow)
            return
        }
        switch url.scheme?.lowercased() {
        case "about", "data", "blob":
            decisionHandler(.allow)
        default:
            // 应用内不加载任何外部页面：OAuth / 文档等链接交给系统默认浏览器
            AppLog.write("外部链接交给系统浏览器：\(url.absoluteString)")
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        }
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        if let host = url.host, isLocalHost(host) {
            webView.load(navigationAction.request)
        } else {
            AppLog.write("新窗口链接交给系统浏览器：\(url.absoluteString)")
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if appLoaded {
            AppLog.write("界面加载完成 title=\(webView.title ?? "") url=\(webView.url?.absoluteString ?? "")")
        }
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        handleNavigationFailure(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handleNavigationFailure(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        AppLog.write("WebContent 进程退出，自动重新载入")
        webView.reload()
    }

    private func handleNavigationFailure(_ error: Error) {
        let nsError = error as NSError
        if nsError.code == NSURLErrorCancelled { return }
        AppLog.write("导航失败：\(nsError.domain) \(nsError.code) \(nsError.localizedDescription)")
        guard appLoaded else { return }
        showFailure(error)
    }

    // MARK: - 工具

    private func isLocalHost(_ host: String) -> Bool {
        let normalized = host.lowercased()
        return normalized == "127.0.0.1" || normalized == "localhost" || normalized == "::1"
    }

    private static func jsLiteral(_ value: String) -> String {
        guard
            let data = try? JSONSerialization.data(withJSONObject: [value]),
            var json = String(data: data, encoding: .utf8),
            json.hasPrefix("["),
            json.hasSuffix("]")
        else {
            return "\"\""
        }
        json.removeFirst()
        json.removeLast()
        return json
    }
}
