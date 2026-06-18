export function createSpriteHitTester({
  petSprite,
  interactiveElements = [],
  animator,
  spriteWidth,
  spriteHeight,
  windowRef = window,
}) {
  let cachedRect = null;

  const invalidateRect = () => {
    cachedRect = null;
  };

  windowRef.addEventListener("resize", invalidateRect);

  function checkAlphaAtCss(cssX, cssY) {
    return checkAlphaAtCssForState(cssX, cssY, animator.currentState, animator.currentFrameIndex);
  }

  function checkHoverBodyAlphaAtCss(cssX, cssY) {
    return checkAlphaAtCssForState(cssX, cssY, "idle", 0);
  }

  function getInteractionAlphaAtCss(cssX, cssY) {
    return Math.max(
      checkAlphaAtCss(cssX, cssY),
      checkHoverBodyAlphaAtCss(cssX, cssY),
      checkInteractiveElementAlphaAtCss(cssX, cssY),
    );
  }

  function checkAlphaAtCssForState(cssX, cssY, state, frameIndex) {
    const rect = cachedRect ?? (cachedRect = petSprite.getBoundingClientRect());
    const spriteX = (cssX - rect.left) * (spriteWidth / rect.width);
    const spriteY = (cssY - rect.top) * (spriteHeight / rect.height);
    if (spriteX < 0 || spriteY < 0 || spriteX >= spriteWidth || spriteY >= spriteHeight) {
      return 0;
    }
    return animator.getAlphaAt(state, frameIndex, spriteX, spriteY);
  }

  function isPointInsideWindow(winX, winY) {
    return winX >= 0 && winY >= 0 && winX < windowRef.innerWidth && winY < windowRef.innerHeight;
  }

  function checkInteractiveElementAlphaAtCss(cssX, cssY) {
    for (const element of interactiveElements) {
      if (!isVisibleInteractiveElement(element)) continue;

      const rect = element.getBoundingClientRect();
      if (cssX >= rect.left && cssX < rect.right && cssY >= rect.top && cssY < rect.bottom) {
        return 255;
      }
    }

    return 0;
  }

  function isVisibleInteractiveElement(element) {
    if (!element) return false;

    const style = windowRef.getComputedStyle(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.pointerEvents !== "none" &&
      Number(style.opacity || 1) > 0.01
    );
  }

  return {
    checkAlphaAtCss,
    checkHoverBodyAlphaAtCss,
    getInteractionAlphaAtCss,
    isPointInsideWindow,
    invalidateRect,
    dispose() {
      windowRef.removeEventListener("resize", invalidateRect);
    },
  };
}
