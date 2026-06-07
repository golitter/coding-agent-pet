import AppKit

/// Drives the sprite animation loop at a fixed FPS.
/// Cycles through frame arrays for the current animation state.
/// Supports drag-direction override (running-left / running-right).
final class SpriteAnimator {
    private let window: PetWindow
    private let cache: FrameCache
    private var currentState: String = "idle"
    private var preDragState: String = "idle"  // state before drag started
    private var preOneShotState: String = "idle"  // state before one-shot animation
    private var currentFrameIndex: Int = 0
    private var timer: DispatchSourceTimer?
    private let fps: Double

    init(window: PetWindow, cache: FrameCache, fps: Double = 10.0) {
        self.window = window
        self.cache = cache
        self.fps = fps
    }

    /// Start the animation loop.
    func start(queue: DispatchQueue = .main) {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        let interval = Int(1_000_000_000 / fps)
        timer.schedule(deadline: .now(), repeating: .nanoseconds(interval), leeway: .milliseconds(5))
        timer.setEventHandler { [weak self] in
            self?.tick()
        }
        self.timer = timer
        timer.resume()

        // Show first frame immediately
        showCurrentFrame()
        print("[SpriteAnimator] ✓ Started at \(fps) FPS")
    }

    /// Stop the animation loop.
    func stop() {
        timer?.cancel()
        timer = nil
    }

    /// Transition to a new animation state.
    func transition(to state: String) {
        guard state != currentState else { return }
        guard cache.frames[state] != nil else {
            print("[SpriteAnimator] ⚠️ Unknown state: \(state)")
            return
        }
        // If currently in a one-shot, save only if the new state isn't also one-shot
        if Self.oneShotStates.contains(currentState) && !Self.oneShotStates.contains(state) {
            preOneShotState = state  // update restore target
        }
        currentState = state
        currentFrameIndex = 0
        showCurrentFrame()
    }

    /// Trigger a one-shot animation (e.g. jumping, waving).
    /// After it finishes, restores the state that was active before the one-shot.
    func triggerOneShot(_ state: String) {
        guard Self.oneShotStates.contains(state) else { return }
        guard cache.frames[state] != nil else { return }
        // Don't interrupt an ongoing one-shot
        guard !Self.oneShotStates.contains(currentState) else { return }
        preOneShotState = currentState
        currentState = state
        currentFrameIndex = 0
        showCurrentFrame()
    }

    /// Handle drag direction: dx > 0 = right, dx < 0 = left, dx = 0 = stop drag.
    func handleDrag(dx: CGFloat) {
        if dx > 0.5 {
            // Dragging right — only save pre-drag state on first entry
            if currentState != "running-right" && currentState != "running-left" {
                preDragState = currentState
            }
            if currentState != "running-right" {
                currentState = "running-right"
                currentFrameIndex = 0
            }
        } else if dx < -0.5 {
            // Dragging left — only save pre-drag state on first entry
            if currentState != "running-right" && currentState != "running-left" {
                preDragState = currentState
            }
            if currentState != "running-left" {
                currentState = "running-left"
                currentFrameIndex = 0
            }
        } else if dx == 0 {
            // Drag ended — restore original state (always go to idle if terminal)
            if currentState == "running-right" || currentState == "running-left" {
                let restore = (preDragState == "running-right" || preDragState == "running-left") ? "idle" : preDragState
                currentState = restore
                currentFrameIndex = 0
                showCurrentFrame()
            }
        }
    }

    // MARK: - Private

    /// States that play once then return to idle
    private static let oneShotStates: Set<String> = ["jumping", "waving"]

    private func tick() {
        guard let frames = cache.frames[currentState], !frames.isEmpty else { return }

        currentFrameIndex += 1

        // One-shot states: play full cycle then return to previous state
        if Self.oneShotStates.contains(currentState) && currentFrameIndex >= frames.count {
            currentState = preOneShotState
            preOneShotState = "idle"
            currentFrameIndex = 0
        } else {
            currentFrameIndex = currentFrameIndex % frames.count
        }

        showCurrentFrame()
    }

    private func showCurrentFrame() {
        guard let frames = cache.frames[currentState],
              currentFrameIndex < frames.count else { return }
        window.imageView.image = frames[currentFrameIndex]
    }
}
