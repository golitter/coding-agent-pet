import Foundation

/// Reads configuration from config.json. Auto-detects paths when values are null.
///
/// Config resolution order:
/// 1. config.json next to setup scripts (desktop/mac/config.json)
/// 2. config.example.json as fallback template
/// 3. Hardcoded defaults
///
/// Paths set to null are auto-detected from the executable location:
///   pet_base_dir → repo root (3 levels up from .build/release/KotoriPet)
///   frames_dir   → {pet_base_dir}/{pet_id}/frames
///   sessions_dir → {pet_base_dir}/desktop/mac/runtime/sessions
struct PetConfig {
    let petBaseDir: String
    let petId: String
    let framesDir: String
    let sessionsDir: String
    let socketPath: String

    let scale: CGFloat
    let fps: Double
    let staleTimeout: TimeInterval
    let cleanupInterval: TimeInterval
    let cornerMargin: CGFloat

    let dialogueFontSize: CGFloat
    let dialogueMaxWidth: CGFloat
    let dialogueCornerRadius: CGFloat
    let dialogueFadeDuration: TimeInterval

    let menuItems: [MenuItemConfig]

    struct MenuItemConfig {
        let title: String
        let action: String  // "applescript", "quit", "separator"
        let script: String?
    }

    init() {
        // Auto-detect repo root from executable path:
        // .build/release/KotoriPet → renderer/ → mac/ → desktop/ → repo root
        let exePath = CommandLine.arguments[0]
        let exeDir = (exePath as NSString).deletingLastPathComponent
        // exeDir = .../desktop/mac/renderer/.build/release
        let releaseDir = (exeDir as NSString).deletingLastPathComponent    // .build
        let buildDir = (releaseDir as NSString).deletingLastPathComponent  // renderer
        let rendererDir = (buildDir as NSString).deletingLastPathComponent // mac
        let macDir = (rendererDir as NSString).deletingLastPathComponent   // desktop
        let detectedBaseDir = (macDir as NSString).deletingLastPathComponent // repo root

        // Find config.json or config.example.json
        let configPath = (rendererDir as NSString).appendingPathComponent("config.json")
        let examplePath = (rendererDir as NSString).appendingPathComponent("config.example.json")

        // Defaults
        var petBaseDir = detectedBaseDir
        var petId = "kotori-minami"
        var socketPath = "/tmp/kotori-pet.sock"
        var scale: CGFloat = 0.6
        var fps: Double = 10.0
        var staleTimeout: TimeInterval = 60
        var cleanupInterval: TimeInterval = 5
        var cornerMargin: CGFloat = 20
        var dialogueFontSize: CGFloat = 10
        var dialogueMaxWidth: CGFloat = 160
        var dialogueCornerRadius: CGFloat = 6
        var dialogueFadeDuration: TimeInterval = 0.3
        var menuItems: [MenuItemConfig] = []

        // Explicit frames/sessions overrides (null = auto)
        var framesDirOverride: String? = nil
        var sessionsDirOverride: String? = nil

        // Try config.json first, then config.example.json
        let actualConfigPath: String
        if FileManager.default.fileExists(atPath: configPath) {
            actualConfigPath = configPath
        } else if FileManager.default.fileExists(atPath: examplePath) {
            actualConfigPath = examplePath
        } else {
            actualConfigPath = configPath  // will fail gracefully
        }

        if let data = try? Data(contentsOf: URL(fileURLWithPath: actualConfigPath)),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {

            // pet_base_dir: null → auto-detect, string → use as-is
            if let dir = json["pet_base_dir"] as? String {
                petBaseDir = Self.resolvePath(dir, relativeTo: detectedBaseDir)
            }
            // null or missing → keep detected

            petId = json["pet_id"] as? String ?? petId

            // frames_dir: null → auto, string → override
            if let dir = json["frames_dir"] as? String {
                framesDirOverride = Self.resolvePath(dir, relativeTo: petBaseDir)
            }

            // sessions_dir: null → auto, string → override
            if let dir = json["sessions_dir"] as? String {
                sessionsDirOverride = Self.resolvePath(dir, relativeTo: petBaseDir)
            }

            socketPath = json["socket_path"] as? String ?? socketPath

            if let r = json["renderer"] as? [String: Any] {
                scale = CGFloat(r["scale"] as? Double ?? Double(scale))
                fps = r["fps"] as? Double ?? fps
                staleTimeout = TimeInterval(r["stale_timeout_sec"] as? Int ?? Int(staleTimeout))
                cleanupInterval = TimeInterval(r["cleanup_interval_sec"] as? Int ?? Int(cleanupInterval))
                cornerMargin = CGFloat(r["corner_margin"] as? Int ?? Int(cornerMargin))
            }

            if let d = json["dialogue"] as? [String: Any] {
                dialogueFontSize = CGFloat(d["font_size"] as? Int ?? Int(dialogueFontSize))
                dialogueMaxWidth = CGFloat(d["max_width"] as? Int ?? Int(dialogueMaxWidth))
                dialogueCornerRadius = CGFloat(d["cornerRadius"] as? Int ?? Int(dialogueCornerRadius))
                dialogueFadeDuration = TimeInterval(d["fade_duration_sec"] as? Double ?? dialogueFadeDuration)
            }

            if let menu = json["menu"] as? [String: Any],
               let items = menu["items"] as? [[String: Any]] {
                for item in items {
                    let type = item["type"] as? String
                    if type == "separator" {
                        menuItems.append(MenuItemConfig(title: "", action: "separator", script: nil))
                    } else {
                        let title = item["title"] as? String ?? ""
                        let action = item["action"] as? String ?? ""
                        let script = item["script"] as? String
                        menuItems.append(MenuItemConfig(title: title, action: action, script: script))
                    }
                }
            }
        }

        self.petBaseDir = petBaseDir
        self.petId = petId
        self.framesDir = framesDirOverride
            ?? (petBaseDir as NSString).appendingPathComponent("\(petId)/frames")
        self.sessionsDir = sessionsDirOverride
            ?? (petBaseDir as NSString).appendingPathComponent("desktop/mac/runtime/sessions")
        self.socketPath = socketPath
        self.scale = scale
        self.fps = fps
        self.staleTimeout = staleTimeout
        self.cleanupInterval = cleanupInterval
        self.cornerMargin = cornerMargin
        self.dialogueFontSize = dialogueFontSize
        self.dialogueMaxWidth = dialogueMaxWidth
        self.dialogueCornerRadius = dialogueCornerRadius
        self.dialogueFadeDuration = dialogueFadeDuration
        self.menuItems = menuItems

        print("[Config] ✓ Config: \(actualConfigPath)")
        print("[Config]   petBaseDir: \(self.petBaseDir)")
        print("[Config]   framesDir: \(self.framesDir)")
        print("[Config]   sessionsDir: \(self.sessionsDir)")
        print("[Config]   scale: \(scale), fps: \(fps)")
    }

    // MARK: - Path Helpers

    /// Resolve a path: expand ~, resolve relative paths against a base.
    private static func resolvePath(_ path: String, relativeTo base: String) -> String {
        // Expand ~
        let expanded = NSString(string: path).expandingTildeInPath
        if (expanded as NSString).isAbsolutePath {
            return expanded
        }
        // Relative path → resolve against base
        return (base as NSString).appendingPathComponent(expanded)
    }
}
