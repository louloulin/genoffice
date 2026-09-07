/**
 * enterprise/mobile — Mobile capability detection (placeholder).
 */

import { registerHandle } from '../common/registry.js'

export function registerMobileHandlers(): void {
  registerHandle('mobile:get-settings', () => ({
    touchEnabled: true,
    viewportWidth: 375,
    viewportHeight: 667,
    pixelRatio: 2,
    supportsTouch: true,
    supportsPen: true,
    deviceType: 'auto',
    theme: 'light',
    reducedMotion: false,
    darkMode: false,
  }))

  registerHandle('mobile:detect', () => {
    return {
      isMobile: true,
      isTablet: false,
      isDesktop: false,
      os: 'web',
      browser: 'web',
      screenWidth: 375,
      screenHeight: 667,
      orientation: 'portrait',
    }
  })
}
