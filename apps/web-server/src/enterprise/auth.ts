/**
 * enterprise/auth — SSO/OIDC auth flow (placeholder).
 */

import { registerHandle } from '../common/registry.js'

export function registerAuthHandlers(): void {
  registerHandle('auth:sso-login', (_event: unknown, args: unknown) => {
    const { provider, redirectUri } = (args || {}) as {
      provider: string
      redirectUri?: string
    }
    return {
      authUrl: `https://sso.genoffice.ai/authorize?provider=${provider}&redirect_uri=${redirectUri || ''}`,
      state: `state-${Date.now()}`,
    }
  })

  registerHandle('auth:sso-callback', async (_event: unknown, args: unknown) => {
    const { code, state } = (args || {}) as { code: string; state: string }
    return {
      ok: true,
      accessToken: `token-${Date.now()}`,
      refreshToken: `refresh-${Date.now()}`,
      expiresIn: 3600,
      user: {
        id: `user-${Date.now()}`,
        email: 'user@example.com',
        name: 'SSO User',
      },
    }
  })

  registerHandle('auth:logout', (_event: unknown) => ({
    ok: true,
    redirectUrl: '/',
  }))
}
