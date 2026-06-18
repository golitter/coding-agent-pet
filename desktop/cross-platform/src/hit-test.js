export function createSpriteHitTester({
  petSprite,
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
    return Math.max(checkAlphaAtCss(cssX, cssY), checkHoverBodyAlphaAtCss(cssX, cssY));
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
