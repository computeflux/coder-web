"use client";

// 统一认证（apps/auth :8008）接入层 — 无 web3auth SDK 版。
//
// 统一登录设计：web3auth 登录框只在枢纽（board-ops :5181）/login 页弹，
// 其他服务一律不能弹 modal。本层只关心登录态：
//  - 会话读自 localStorage "web3auth:session"（枢纽登录后经 ?sso= 回跳写入，
//    见 lib/sso.ts consumeSsoOnBoot）
//  - login() = 跳转枢纽 /login 获取凭证（不弹框）
//  - logout() = 调 auth /logout + 清本地会话
//
// 全局 fetch 拦截：同源 /api 请求自动带 Bearer token；401 派发 "auth:required"
// 事件（SsoGate 监听后跳枢纽 /login 换新凭证；本服务不自续期，见下方注释）。
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
  clearStoredSession,
  readStoredSession,
  redirectToLogin,
} from "@/lib/sso";

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

// ⚠️ 非枢纽服务禁止自行 POST /auth/refresh：refresh token 经 ?sso= 复制到各 origin
// 各持一份拷贝，谁先轮换谁的旧拷贝就是"重放"→ auth 的轮换+重放检测会吊销全部会话
//（auth_audit_logs: refresh_reuse_detected）。凭证轮换只由枢纽（board-ops /login）执行；
// 本服务 401 → 派发 auth:required → SsoGate 先走 /ops/sso iframe 由枢纽代续，失败才跳登录。

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

    const res = await originalFetch(input, { ...init, headers });
    // 401（无 token / 过期 / 会话被吊销）→ 去枢纽 /login 获取新凭证（不自续期，见上）
    if (res.status === 401) {
      window.dispatchEvent(new Event("auth:required"));
    }
    return res;
  };
}

interface AuthContextValue {
  isInitialized: boolean;
  isConnected: boolean;
  user: { id: string; email?: string; name?: string } | null;
  /** 跳转枢纽 /login 获取登录凭证（本服务不弹登录框） */
  login: () => Promise<void>;
  /** 登出（调 auth /logout + 清本地会话） */
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// SSR 时 AuthProvider 未挂载（见下方 mounted 门控），返回安全默认值。
const AUTH_FALLBACK: AuthContextValue = {
  isInitialized: false,
  isConnected: false,
  user: null,
  login: async () => {},
  logout: async () => {},
};

function AuthInner({ children }: { children: ReactNode }) {
  // 会话在渲染前已由 consumeSsoOnBoot() 写入；登出时本地清除
  const [session, setSession] = useState(() =>
    typeof window !== "undefined" ? readStoredSession() : null,
  );

  // 其他标签页登录/登出、或 iframe 静默续期写入新会话 → 同步本页 UI 状态
  //（请求层 currentToken() 本来就每次现读 localStorage，这里只为 isConnected/user 展示）
  useEffect(() => {
    const sync = () => setSession(readStoredSession());
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === "web3auth:session" || e.key === "web3auth:user") sync();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("sso:session-synced", sync);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("sso:session-synced", sync);
    };
  }, []);

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
    clearStoredSession();
    setSession(null);
  }, []);

  const isConnected = Boolean(session?.token && session.address);
  const userInfo = session?.userInfo as
    | { verifierId?: string; email?: string; name?: string }
    | undefined;

  const value = useMemo<AuthContextValue>(
    () => ({
      isInitialized: true,
      isConnected,
      user: isConnected
        ? {
            id: userInfo?.verifierId || userInfo?.email || "",
            email: userInfo?.email,
            name: userInfo?.name,
          }
        : null,
      login: () => {
        redirectToLogin();
        return Promise.resolve();
      },
      logout,
    }),
    [isConnected, logout, userInfo],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // SSR/预渲染阶段不挂载（会话读取依赖 localStorage）
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    installFetchInterceptor();
  }, []);

  if (!mounted) return <>{children}</>;

  return <AuthInner>{children}</AuthInner>;
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext) ?? AUTH_FALLBACK;
}

// 401 续期失败 / 登出后 → SsoGate 跳登录页（简单事件，与 board 一致）
export function onAuthRequired(fn: () => void): () => void {
  const handler = () => fn();
  window.addEventListener("auth:required", handler);
  return () => window.removeEventListener("auth:required", handler);
}
