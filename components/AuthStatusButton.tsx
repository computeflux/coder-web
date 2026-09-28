"use client";

// 顶栏登录状态按钮：未登录 → 登录（弹 web3auth LoginModal）；已登录 → 用户 + 登出。
// 401 续期失败（auth:required 事件）时自动弹登录。

import { useCallback, useEffect, useState } from "react";
import { onAuthRequired, useAuth } from "@/components/AuthProvider";
import { useI18n } from "@/hooks/useI18n";

const SIZE = 36;

export function AuthStatusButton() {
  const { isConnected, user, login, logout } = useAuth();
  const { t: translate } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);

  const openLogin = useCallback(() => {
    void login();
  }, [login]);

  useEffect(() => onAuthRequired(openLogin), [openLogin]);

  const label = isConnected
    ? (user?.email || user?.name || user?.id || "user")
    : translate("auth.login");

  return (
    <div style={{ position: "relative", flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => {
          if (!isConnected) {
            openLogin();
            return;
          }
          setMenuOpen((current) => !current);
        }}
        title={isConnected ? translate("auth.account") : translate("auth.login")}
        aria-label={isConnected ? translate("auth.account") : translate("auth.login")}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          width: SIZE, height: SIZE, padding: "0 8px",
          background: "none", border: "none", borderRight: "1px solid var(--border)",
          color: "var(--text-muted)", cursor: "pointer",
          fontSize: 12, overflow: "hidden", whiteSpace: "nowrap",
          textOverflow: "ellipsis", maxWidth: 120, transition: "color 0.12s",
        }}
        onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text)"; }}
        onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text-muted)"; }}
      >
        {isConnected ? (
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        )}
      </button>
      {isConnected && menuOpen && (
        <div
          style={{
            position: "absolute", top: SIZE + 4, right: 0, zIndex: 1000,
            minWidth: 140, padding: 4,
            background: "var(--bg-elevated, var(--bg))",
            border: "1px solid var(--border)", borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
          }}
          onMouseLeave={() => setMenuOpen(false)}
        >
          <div style={{ padding: "6px 10px", fontSize: 12, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}>
            {label}
          </div>
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              void logout();
            }}
            style={{
              display: "block", width: "100%", padding: "6px 10px",
              background: "none", border: "none", borderRadius: 6,
              color: "var(--text)", cursor: "pointer", fontSize: 13, textAlign: "left",
            }}
            onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(event) => { event.currentTarget.style.background = "none"; }}
          >
            {translate("auth.logout")}
          </button>
        </div>
      )}
    </div>
  );
}
