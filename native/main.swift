// Terra Nota for Mac: a window around web/, plus the things a web page can't do
// well on its own: durable storage, native menus, file panels and pinch-to-zoom.
//
// Your data lives in ~/Library/Application Support/Terra Nota, outside the app,
// so replacing or rebuilding the app never touches it.

import Cocoa
import UniformTypeIdentifiers
import WebKit

/// travels.json and its dated copies.
final class TravelFile {
    let folder: URL
    var file: URL { folder.appendingPathComponent("travels.json") }
    var backups: URL { folder.appendingPathComponent("Backups") }
    private let keepBackups = 30

    init() {
        if let override = ProcessInfo.processInfo.environment["TERRA_NOTA_DATA"] {
            folder = URL(fileURLWithPath: override)
        } else {
            let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            folder = support.appendingPathComponent("Terra Nota")
        }
        try? FileManager.default.createDirectory(at: backups, withIntermediateDirectories: true)
    }

    /// The saved JSON, or nil on a first run. A file that can't be parsed is moved
    /// aside rather than overwritten, and `setAside` says where it went.
    func load() -> (json: String?, setAside: URL?) {
        guard let bytes = try? Data(contentsOf: file) else { return (nil, nil) }
        let parsed = try? JSONSerialization.jsonObject(with: bytes)
        if parsed is [String: Any], let text = String(data: bytes, encoding: .utf8) {
            return (text, nil)
        }
        let stamp = Int(Date().timeIntervalSince1970)
        let aside = folder.appendingPathComponent("travels.unreadable-\(stamp).json")
        try? FileManager.default.moveItem(at: file, to: aside)
        return (nil, aside)
    }

    func save(_ json: String) throws {
        backUpToday()
        try json.write(to: file, atomically: true, encoding: .utf8)
    }

    /// One copy per day of the file as it was before that day's first change,
    /// taken at launch or at the first save, so an app left open still gets one.
    func backUpToday() {
        let manager = FileManager.default
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        let copy = backups.appendingPathComponent("travels-\(formatter.string(from: Date())).json")
        guard manager.fileExists(atPath: file.path), !manager.fileExists(atPath: copy.path) else { return }
        try? manager.copyItem(at: file, to: copy)
        let existing = (try? manager.contentsOfDirectory(at: backups, includingPropertiesForKeys: nil)) ?? []
        let dated = existing.filter { $0.lastPathComponent.hasPrefix("travels-") }
            .sorted { $0.lastPathComponent > $1.lastPathComponent }
        for old in dated.dropFirst(keepBackups) {
            try? manager.removeItem(at: old)
        }
    }
}

/// Encodes text as a JavaScript string literal.
func javaScriptLiteral(_ text: String) -> String {
    let wrapped = try! JSONSerialization.data(withJSONObject: [text])
    return String(String(data: wrapped, encoding: .utf8)!.dropFirst().dropLast())
}

final class MapWebView: WKWebView {
    // WebKit's own pinch handling is page zoom. The map wants the gesture instead.
    override func magnify(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let y = isFlipped ? point.y : bounds.height - point.y
        evaluateJavaScript("TN.pinch(\(event.magnification),\(point.x),\(y))")
    }

    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        menu.items.removeAll { $0.identifier?.rawValue == "WKMenuItemIdentifierReload" }
    }
}

/// The title bar is transparent over the page, so this strip stands in for it.
final class TitleBarStrip: NSView {
    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            window?.performZoom(nil)
        } else {
            window?.performDrag(with: event)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var web: MapWebView!
    private let travels = TravelFile()
    private var setAside: URL?
    private var saveFailed = false

    // Smoke test: `Terra Nota --eval '<js>' --snapshot out.png` runs the js once the map
    // is up, prints the result, saves a picture and quits. Point TERRA_NOTA_DATA at a
    // scratch folder when using it, or it will write to your real travels.
    private lazy var evalScript = argument(after: "--eval")
    private lazy var snapshotPath = argument(after: "--snapshot")

    private func argument(after flag: String) -> String? {
        let arguments = CommandLine.arguments
        guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
        return arguments[index + 1]
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        travels.backUpToday()
        buildMenu()
        buildWindow()
        loadPage()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // A note typed in the last moment is still in the page, so collect it before leaving.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        var replied = false
        let finish = {
            guard !replied else { return }
            replied = true
            sender.reply(toApplicationShouldTerminate: true)
        }
        web.evaluateJavaScript("TN.flush()") { _, _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: finish)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1, execute: finish)
        return .terminateLater
    }

    // MARK: Window

    private func buildWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1320, height: 840),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Terra Nota"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.minSize = NSSize(width: 860, height: 560)
        window.isReleasedWhenClosed = false
        // The map has one bright, flat look, so the window stays light in dark mode too.
        window.appearance = NSAppearance(named: .aqua)
        window.backgroundColor = NSColor(srgbRed: 0.922, green: 0.902, blue: 0.863, alpha: 1)
        window.center()
        window.setFrameAutosaveName("TerraNotaMain")

        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "tn")
        web = MapWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self
        web.allowsMagnification = false
        web.allowsBackForwardNavigationGestures = false

        let content = NSView()
        web.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(web)
        let strip = TitleBarStrip()
        strip.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(strip)
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: content.topAnchor),
            web.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            strip.topAnchor.constraint(equalTo: content.topAnchor),
            strip.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            strip.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            strip.heightAnchor.constraint(equalToConstant: 28),
        ])
        window.contentView = content
    }

    private func loadPage() {
        let loaded = travels.load()
        setAside = setAside ?? loaded.setAside
        let controller = web.configuration.userContentController
        controller.removeAllUserScripts()
        if let json = loaded.json {
            controller.addUserScript(WKUserScript(
                source: "window.__TN_SAVED__=\(javaScriptLiteral(json));",
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            ))
        }
        let folder = Bundle.main.resourceURL!.appendingPathComponent("web")
        web.loadFileURL(folder.appendingPathComponent("index.html"), allowingReadAccessTo: folder)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        window.makeKeyAndOrderFront(nil)
        if let script = evalScript {
            runSmokeTest(script)
            return
        }
        NSApp.activate(ignoringOtherApps: true)
        if let aside = setAside {
            setAside = nil
            alert("Your saved travels couldn’t be read",
                  "The file was kept at \(aside.path). Terra Nota started fresh, and dated copies are in the Backups folder beside it.")
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(action.request.url?.isFileURL == true ? .allow : .cancel)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        loadPage()
    }

    private func runSmokeTest(_ script: String) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            let wrapped = "JSON.stringify((() => { \(script) })())"
            self.web.evaluateJavaScript(wrapped) { result, error in
                print((result as? String) ?? "ERROR: \(String(describing: error))")
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                    guard let path = self.snapshotPath else { exit(error == nil ? 0 : 1) }
                    self.web.evaluateJavaScript("TN.finish()") { _, _ in
                        self.web.takeSnapshot(with: nil) { image, _ in
                            if let tiff = image?.tiffRepresentation,
                               let bitmap = NSBitmapImageRep(data: tiff),
                               let png = bitmap.representation(using: .png, properties: [:]) {
                                try? png.write(to: URL(fileURLWithPath: path))
                            }
                            exit(error == nil ? 0 : 1)
                        }
                    }
                }
            }
        }
    }

    // MARK: Messages from the page

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let op = body["op"] as? String else { return }
        switch op {
        case "save":
            guard let json = body["json"] as? String else { return }
            do {
                try travels.save(json)
                saveFailed = false
            } catch {
                if !saveFailed {
                    saveFailed = true
                    alert("Terra Nota couldn’t save", error.localizedDescription)
                }
            }
        case "export":
            if let json = body["json"] as? String {
                export(json, name: body["name"] as? String ?? "terra-nota-backup.json")
            }
        case "import":
            importBackup(nil)
        case "reveal":
            revealData(nil)
        default:
            break
        }
    }

    private func export(_ json: String, name: String) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = name
        panel.allowedContentTypes = [.json]
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let url = panel.url else { return }
            do {
                try json.write(to: url, atomically: true, encoding: .utf8)
            } catch {
                self.alert("That backup couldn’t be saved", error.localizedDescription)
            }
        }
    }

    private func alert(_ title: String, _ detail: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        alert.beginSheetModal(for: window)
    }

    // MARK: Menu actions

    @objc func exportBackup(_ sender: Any?) {
        web.evaluateJavaScript("TN.exportData()")
    }

    @objc func importBackup(_ sender: Any?) {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.allowsMultipleSelection = false
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let url = panel.url else { return }
            guard let text = try? String(contentsOf: url, encoding: .utf8) else {
                self.alert("That file couldn’t be read", url.path)
                return
            }
            self.web.evaluateJavaScript("TN.receiveImport(\(javaScriptLiteral(text)))")
        }
    }

    @objc func revealData(_ sender: Any?) {
        let exists = FileManager.default.fileExists(atPath: travels.file.path)
        NSWorkspace.shared.activateFileViewerSelecting([exists ? travels.file : travels.folder])
    }

    @objc func undoInPage(_ sender: Any?) {
        web.evaluateJavaScript("TN.undo()")
    }

    @objc func redoInPage(_ sender: Any?) {
        web.evaluateJavaScript("TN.redo()")
    }

    private func buildMenu() {
        let bar = NSMenu()

        func menu(_ title: String, _ build: (NSMenu) -> Void) -> NSMenu {
            let item = NSMenuItem()
            let submenu = NSMenu(title: title)
            build(submenu)
            item.submenu = submenu
            bar.addItem(item)
            return submenu
        }

        func add(_ menu: NSMenu, _ title: String, _ action: Selector, _ key: String = "",
                 _ modifiers: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) {
            let item = menu.addItem(withTitle: title, action: action, keyEquivalent: key)
            item.keyEquivalentModifierMask = modifiers
            item.target = target
        }

        _ = menu("Terra Nota") { app in
            add(app, "About Terra Nota", #selector(NSApplication.orderFrontStandardAboutPanel(_:)))
            app.addItem(.separator())
            add(app, "Hide Terra Nota", #selector(NSApplication.hide(_:)), "h")
            add(app, "Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option])
            add(app, "Show All", #selector(NSApplication.unhideAllApplications(_:)))
            app.addItem(.separator())
            add(app, "Quit Terra Nota", #selector(NSApplication.terminate(_:)), "q")
        }
        _ = menu("File") { file in
            add(file, "Export Backup…", #selector(exportBackup(_:)), "e", [.command, .shift], target: self)
            add(file, "Import Backup…", #selector(importBackup(_:)), "i", [.command, .shift], target: self)
            add(file, "Show Data File", #selector(revealData(_:)), target: self)
            file.addItem(.separator())
            add(file, "Close Window", #selector(NSWindow.performClose(_:)), "w")
        }
        // Without an Edit menu, copy and paste don't work in text fields at all.
        _ = menu("Edit") { edit in
            add(edit, "Undo", #selector(undoInPage(_:)), "z", target: self)
            add(edit, "Redo", #selector(redoInPage(_:)), "z", [.command, .shift], target: self)
            edit.addItem(.separator())
            add(edit, "Cut", #selector(NSText.cut(_:)), "x")
            add(edit, "Copy", #selector(NSText.copy(_:)), "c")
            add(edit, "Paste", #selector(NSText.paste(_:)), "v")
            add(edit, "Select All", #selector(NSText.selectAll(_:)), "a")
        }
        _ = menu("View") { view in
            add(view, "Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])
        }
        let windows = menu("Window") { window in
            add(window, "Minimize", #selector(NSWindow.performMiniaturize(_:)), "m")
            add(window, "Zoom", #selector(NSWindow.performZoom(_:)))
        }
        NSApp.mainMenu = bar
        NSApp.windowsMenu = windows
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
