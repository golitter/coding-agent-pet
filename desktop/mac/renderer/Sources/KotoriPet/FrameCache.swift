import AppKit

/// Pre-loads all sprite frame PNGs into memory keyed by animation state name.
final class FrameCache {
    let frames: [String: [NSImage]]

    /// All 9 animation states in spritesheet row order.
    static let states = [
        "idle", "running-right", "running-left", "waving",
        "jumping", "failed", "waiting", "running", "review"
    ]

    init(framesDir: String) {
        var result: [String: [NSImage]] = [:]

        for state in Self.states {
            let stateDir = (framesDir as NSString).appendingPathComponent(state)
            let fm = FileManager.default

            guard let files = try? fm.contentsOfDirectory(atPath: stateDir) else {
                print("[FrameCache] ⚠️ No frames for state '\(state)' at \(stateDir)")
                result[state] = []
                continue
            }

            let pngs = files
                .filter { $0.hasSuffix(".png") }
                .sorted()

            var images: [NSImage] = []
            for png in pngs {
                let path = (stateDir as NSString).appendingPathComponent(png)
                if let image = NSImage(contentsOf: URL(fileURLWithPath: path)) {
                    images.append(image)
                } else {
                    print("[FrameCache] ⚠️ Failed to load \(path)")
                }
            }

            result[state] = images
            print("[FrameCache] ✓ \(state): \(images.count) frames")
        }

        self.frames = result
        let total = result.values.flatMap { $0 }.count
        print("[FrameCache] Loaded \(total) frames total")
    }
}
