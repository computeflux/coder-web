"use client";

// SSO 门：统一登录设计（登录只在枢纽 board-ops :5181 /login 页弹框，
// 所有服务跳转过去获取登录凭证；实现见 lib/sso.ts）。
//
// consumeSsoOnBoot() 在模块作用域同步执行（客户端 bundle 求值时、渲染前）：
// URL 带 ?sso=（枢纽登录后的回跳）时先把会话写入 localStorage，
// AuthProvider 挂载后即可读到登录态。
import { useEffect, useRef, useState } from "react";
import {
  bumpSsoLoop,
  clearSsoLoop,
  consumeSsoOnBoot,
  isHubLoginPage,
  readStoredSession,
  redirectToLogin,
  type SsoSession,
} from "@/lib/sso";

consumeSsoOnBoot();

export function SsoGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<SsoSession | null>(null);
  const redirected = useRef(false);

  // 客户端挂载后读一次会话（渲染前 consumeSsoOnBoot 已把 ?sso= 写入 localStorage）
  useEffect(() => {
    setSession(readStoredSession());
    setReady(true);
  }, []);

  // 未登录（任意服务，含枢纽自身）→ 跳枢纽 /login；
  // 已在枢纽 /login 页 → 不跳（那页自己弹框）；
  // 跨加载循环计数器 60s 内 >3 次 → 停止跳转（防死循环）
  useEffect(() => {
    if (!ready || redirected.current) return;
    if (session) {
      clearSsoLoop();
      return;
    }
    if (isHubLoginPage()) return;
    if (bumpSsoLoop()) return;
    redirected.current = true;
    redirectToLogin();
  }, [ready, session]);

  // 401（无 token / 静默续期失败，fetch 拦截派发，已节流）→ 去登录页获取凭证
  useEffect(() => {
    const handler = () => {
      if (isHubLoginPage()) return;
      redirectToLogin();
    };
    window.addEventListener("auth:required", handler);
    return () => window.removeEventListener("auth:required", handler);
  }, []);

  return <>{children}</>;
}
