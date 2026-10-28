"use client";

// SSO 门：统一登录设计（登录只在枢纽 :5181 /ops/login 页弹框）。
// 本地无会话 / token 过期时先走 /ops/sso iframe 静默续期（跨 origin 读不到枢纽 localStorage），
// 拿不到才跳转登录页。

import { useEffect, useRef, useState } from "react";
import {
  bumpSsoLoop,
  clearSsoLoop,
  consumeSsoOnBoot,
  isHubLoginPage,
  isSessionFresh,
  readStoredSession,
  redirectToLogin,
  syncSessionViaIframe,
  type SsoSession,
} from "@/lib/sso";

consumeSsoOnBoot();

export function SsoGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<SsoSession | null>(null);
  const redirected = useRef(false);

  // 挂载：本地无会话 / token 已过期 → 先向枢纽 iframe 静默要一次
  //（跨 origin 读不到枢纽 localStorage；refresh 轮换只在枢纽 origin 发生）。
  // 拿不到再回退到跳转登录。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let s = readStoredSession();
      if (!isSessionFresh(s)) {
        const synced = await syncSessionViaIframe();
        if (cancelled) return;
        s = synced ?? s;
      }
      if (cancelled) return;
      setSession(s);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 其他标签页 / iframe 同步写入会话 → 更新本页内存态
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === "web3auth:session" || e.key === "web3auth:user") {
        setSession(readStoredSession());
      }
    };
    const onSynced = () => setSession(readStoredSession());
    window.addEventListener("storage", onStorage);
    window.addEventListener("sso:session-synced", onSynced);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("sso:session-synced", onSynced);
    };
  }, []);

  // 仍未登录 → 跳枢纽 /login（循环计数器防死循环）
  useEffect(() => {
    if (!ready || redirected.current) return;
    if (isSessionFresh(session)) {
      clearSsoLoop();
      return;
    }
    if (isHubLoginPage()) return;
    if (bumpSsoLoop()) return;
    redirected.current = true;
    redirectToLogin();
  }, [ready, session]);

  // 401：先尝试 iframe 换新凭证；拿到则原地继续（请求层每次现读 localStorage），失败才跳登录
  useEffect(() => {
    const handler = () => {
      if (isHubLoginPage()) return;
      void (async () => {
        const synced = await syncSessionViaIframe();
        if (synced) {
          setSession(synced);
          return;
        }
        if (isHubLoginPage()) return;
        if (bumpSsoLoop()) return;
        redirectToLogin();
      })();
    };
    window.addEventListener("auth:required", handler);
    return () => window.removeEventListener("auth:required", handler);
  }, []);

  return <>{children}</>;
}
