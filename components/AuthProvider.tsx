"use client";

// 统一认证（apps/auth :8008）接入层 — 与 board 同一套登录逻辑。
//
// 复用 web3auth 前端 SDK 的登录能力（LoginModal / 邮箱 OTP / 社交登录 / 钱包登录），
// backendUrl 指向 auth 服务；auth 的 /gql 兼容层承接 SDK 的 GraphQL mutations。
// 本层只关心登录态（isConnected / userInfo / token），不关心钱包/链。
//
// 全局 fetch 拦截：同源 /api 请求自动带 Bearer token；401 时静默续期重放一次，
// 续期失败派发 "auth:required" 事件（UI 弹登录）。
// 服务端验签见 lib/auth-verify.ts（JWKS 本地验签，proxy.ts 接入）。

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  Web3AuthProvider,
  useWeb3Auth,
  useWeb3AuthConnect,
  useWeb3AuthDisconnect,
  useWeb3AuthUser,
  type Web3AuthContextConfig,
} from "@wetee/web3auth/react";

const SESSION_KEY = "web3auth:session";

interface StoredSession {
  token?: string;
  refreshToken?: string;
}

function getAuthApiBase(): string {
  const raw = process.env.NEXT_PUBLIC_AUTH_API_URL;
  if (raw && raw.trim()) return raw.trim().replace(/\/+$/, "");
  // SSR 时无 window；仅客户端调用路径会用到默认值。
  return typeof window === "undefined"
    ? "http://127.0.0.1:8008"
    : `http://${window.location.hostname}:8008`;
}

function readSession(): StoredSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

function currentToken(): string {
  return readSession()?.token ?? "";
}

// 静默续期：全局单例锁，避免并发双 refresh 触发 refresh token 重放 → 吊销全部会话。
let refreshInFlight: Promise<string | null> | null = null;

function refreshAccessToken(): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const session = readSession();
      if (!session?.refreshToken) return null;
      try {
        const res = await fetch(`${getAuthApiBase()}/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: session.refreshToken }),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as {
          access_token?: string;
          refresh_token?: string;
        };
        if (!data?.access_token) return null;
        const updated: StoredSession = {
          ...session,
          token: data.access_token,
          refreshToken: data.refresh_token ?? session.refreshToken,
        };
        localStorage.setItem(SESSION_KEY, JSON.stringify(updated));
        return data.access_token;
      } catch {
        return null;
      }
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

function isSameOriginApi(url: string): boolean {
  if (url.startsWith("/api")) return true;
  if (url.startsWith(window.location.origin)) {
    return url.slice(window.location.origin.length).startsWith("/api");
  }
  return false;
}

function installFetchInterceptor(): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __piAuthFetchInstalled?: boolean };
  if (w.__piAuthFetchInstalled) return;
  w.__piAuthFetchInstalled = true;

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    if (!isSameOriginApi(url)) return originalFetch(input, init);

    const headers = new Headers(init?.headers);
    const token = currentToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);

    let res = await originalFetch(input, { ...init, headers });
    if (res.status === 401) {
      const newToken = await refreshAccessToken();
      if (newToken) {
        headers.set("Authorization", `Bearer ${newToken}`);
        res = await originalFetch(input, { ...init, headers });
      } else {
        window.dispatchEvent(new Event("auth:required"));
      }
    }
    return res;
  };
}

interface AuthContextValue {
  isInitialized: boolean;
  isConnected: boolean;
  user: { id: string; email?: string; name?: string } | null;
  /** 打开登录弹窗（web3auth LoginModal） */
  login: () => Promise<void>;
  /** 登出（调 auth /logout + 清本地会话） */
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// SSR 时 AuthProvider 未挂载 SDK（见下方 mounted 门控），返回安全默认值。
const AUTH_FALLBACK: AuthContextValue = {
  isInitialized: false,
  isConnected: false,
  user: null,
  login: async () => {},
  logout: async () => {},
};

function AuthInner({ children }: { children: ReactNode }) {
  const { isInitialized, isConnected } = useWeb3Auth();
  const { connect } = useWeb3AuthConnect();
  const { disconnect } = useWeb3AuthDisconnect();
  const { userInfo } = useWeb3AuthUser();

  const logout = useCallback(async () => {
    const token = currentToken();
    try {
      if (token) {
        await fetch(`${getAuthApiBase()}/logout`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: "{}",
        });
      }
    } catch {
      /* 本地登出不受服务端影响 */
    }
    await disconnect();
  }, [disconnect]);

  const value = useMemo<AuthContextValue>(
    () => ({
      isInitialized,
      isConnected,
      user: isConnected
        ? {
            id: (userInfo?.verifierId as string) || (userInfo?.email as string) || "",
            email: userInfo?.email,
            name: userInfo?.name,
          }
        : null,
      login: connect,
      logout,
    }),
    [isInitialized, isConnected, userInfo, connect, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // SDK 依赖 window/localStorage：SSR/预渲染阶段不挂载，仅客户端渲染。
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    installFetchInterceptor();
  }, []);

  const config = useMemo<Web3AuthContextConfig>(() => {
    if (typeof window === "undefined") {
      return { web3AuthOptions: { clientId: "auth", chains: [], authBackendUrl: "http://127.0.0.1:8008" } };
    }
    const origin = window.location.origin;
    const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    const githubClientId = process.env.NEXT_PUBLIC_GITHUB_CLIENT_ID;
    const twitterClientId = process.env.NEXT_PUBLIC_TWITTER_CLIENT_ID;
    return {
      web3AuthOptions: {
        clientId: "auth",
        // pi-web 是内部工具，不需要链/钱包；chains 留空（SDK 仅登录路径使用）
        chains: [],
        uiConfig: { mode: "dark", appName: "pi-web" },
        authBackendUrl: getAuthApiBase(),
        googleClientId: googleClientId || undefined,
        googleRedirectUri: googleClientId ? `${origin}/oauth/callback.html` : undefined,
        githubClientId: githubClientId || undefined,
        githubRedirectUri: githubClientId ? `${origin}/oauth/callback.html` : undefined,
        twitterClientId: twitterClientId || undefined,
        twitterRedirectUri: twitterClientId ? `${origin}/oauth/callback.html` : undefined,
      },
    };
  }, []);

  if (!mounted) return <>{children}</>;

  return (
    <Web3AuthProvider config={config}>
      <AuthInner>{children}</AuthInner>
    </Web3AuthProvider>
  );
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext) ?? AUTH_FALLBACK;
}

// 401 续期失败 / 登出后 → UI 弹登录（简单事件，与 board 一致）
export function onAuthRequired(fn: () => void): () => void {
  const handler = () => fn();
  window.addEventListener("auth:required", handler);
  return () => window.removeEventListener("auth:required", handler);
}
