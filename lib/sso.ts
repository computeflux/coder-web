/**
 * SSO 多服务登录（ComputeFlux 统一设计，pi-web 本地副本 — 不依赖 @wetee/web3auth）：
 * 登录只在枢纽（core-ui :5181）/ops/login 页弹登录框，其他服务
 * 一律跳转过去获取登录凭证。
 *
 *   1) 未登录（任意服务，含枢纽自身）/ 401 → 跳枢纽 /ops/login（?sso_next=原地址）
 *   2) /ops/login 页弹登录框；登录成功后：
 *        带 ?sso_next= → 读本地会话（key）→ 带 ?sso=base64(会话) 跳回原地址
 *        无 ?sso_next= → 回枢纽首页
 *   3) 原服务启动时从 URL 取 key 写入本地 localStorage
 *
 * 注意：key（含 refresh token）会短暂出现在 URL 中（replaceState 立即移除，不进 history）；
 * nginx access log 会记录该请求行。内部系统可接受；若上公网需改回 code 兑换方案。
 *
 * 所有函数 SSR 安全（服务端 no-op / 安全默认值）。
 */

const HUB_PORT = "5181"; // core-ui 单容器 = 登录枢纽（/ops 入口）

// 枢纽地址：本部署的 core-ui 是**纯 HTTP**（容器 5181:80，没有 TLS）。
// ⚠️ 不能用 window.location.protocol：pi-web 走 HTTPS(:8443) 时会拼出 https://host:5181，
// 浏览器按 TLS 去连明文端口 → “SSL received a record that exceeded the maximum
// permissible length”（2026-10-28 实测）。
// HTTPS → HTTP 的**顶层跳转**是允许的（不被混合内容拦截），登录回跳照常可用。
// 如将来枢纽部署在 TLS 反代后，用 NEXT_PUBLIC_SSO_HUB_URL=https://hub.example.com 覆盖。
const HUB_URL_OVERRIDE = (process.env.NEXT_PUBLIC_SSO_HUB_URL || "").trim().replace(/\/+$/, "");

function hasWindow(): boolean {
    return typeof window !== "undefined";
}

export function hubUrl(): string {
    if (!hasWindow()) return "";
    if (HUB_URL_OVERRIDE) return HUB_URL_OVERRIDE;
    return `http://${window.location.hostname}:${HUB_PORT}`;
}

export function isHubOrigin(): boolean {
    if (!hasWindow()) return false;
    try {
        return new URL(hubUrl()).origin === window.location.origin;
    } catch {
        return false;
    }
}

/** 唯一的登录页（枢纽 core-ui :5181 /ops/login）：所有服务都来这里获取登录凭证 */
export function loginPath(next?: string): string {
    return next ? `/ops/login?sso_next=${encodeURIComponent(next)}` : "/ops/login";
}

export function loginUrl(next?: string): string {
    return `${hubUrl()}${loginPath(next)}`;
}

export function isHubLoginPage(): boolean {
    return isHubOrigin() && window.location.pathname === "/ops/login";
}

/** 统一"去获取登录凭证"入口：未登录 / 401 时，任何服务（含枢纽自身）都跳这里 */
export function redirectToLogin(): void {
    if (!hasWindow() || isHubLoginPage()) return;
    // 自动化浏览器（navigator.webdriver，如构建期 puppeteer 预渲染）：
    // 不跳转，避免页面导航销毁渲染上下文导致构建失败
    if (navigator.webdriver) return;
    const next = window.location.origin + window.location.pathname + window.location.search;
    window.location.replace(isHubOrigin() ? loginPath(next) : loginUrl(next));
}

// web3auth 持久化会话格式（localStorage "web3auth:session"，由枢纽登录流程写入）
export interface SsoSession {
    token: string;
    address: string;
    refreshToken?: string;
    userInfo?: unknown;
}

export function readStoredSession(): SsoSession | null {
    if (!hasWindow()) return null;
    try {
        const raw = localStorage.getItem("web3auth:session");
        if (!raw) return null;
        const s = JSON.parse(raw) as SsoSession;
        if (!s?.token || !s?.address) return null;
        return s;
    } catch {
        return null;
    }
}

function writeSession(s: SsoSession): void {
    localStorage.setItem("web3auth:session", JSON.stringify(s));
}

/** 清本地会话（web3auth:session + web3auth:user） */
export function clearStoredSession(): void {
    if (!hasWindow()) return;
    localStorage.removeItem("web3auth:session");
    localStorage.removeItem("web3auth:user");
}

// 跨加载循环计数器（localStorage 存活跨页面）：
// 每次"跳登录页" +1；60 秒内 >3 次 → 停止跳转（防纯重定向死循环）
const SSO_LOOP_KEY = "web3auth:sso_loop";
const SSO_LOOP_WINDOW_MS = 60_000;
const SSO_LOOP_MAX = 3;

/** 返回 true = 已超限，调用方应停止跳转 */
export function bumpSsoLoop(): boolean {
    if (!hasWindow()) return false;
    try {
        const now = Date.now();
        const raw = localStorage.getItem(SSO_LOOP_KEY);
        let count = 1;
        let ts = now;
        if (raw) {
            const p = JSON.parse(raw) as { count?: number; ts?: number };
            if (p?.ts && now - p.ts < SSO_LOOP_WINDOW_MS) {
                count = (p.count ?? 0) + 1;
                ts = p.ts;
            }
        }
        if (count > SSO_LOOP_MAX) return true;
        localStorage.setItem(SSO_LOOP_KEY, JSON.stringify({ count, ts }));
        return false;
    } catch {
        return false; // 计数失败不拦截
    }
}

export function clearSsoLoop(): void {
    if (!hasWindow()) return;
    try {
        localStorage.removeItem(SSO_LOOP_KEY);
    } catch {
        /* ignore */
    }
}

// base64 的 URL-safe 变体：query string 里 `+` 会被 URLSearchParams 解码成空格，
// 标准 base64 拼进 ?sso= 必然损坏 → 用 -/_ 替代 +/（解码时还原）
function b64Decode(s: string): string {
    return decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));
}

// 读取 URL 参数并立即移除（replaceState，不留 history 记录）
export function takeUrlParam(name: string): string | null {
    if (!hasWindow()) return null;
    const url = new URL(window.location.href);
    const v = url.searchParams.get(name);
    if (v === null) return null;
    url.searchParams.delete(name);
    window.history.replaceState({}, "", url.toString());
    return v;
}

/**
 * 各服务入口（main.tsx / 客户端模块作用域）在渲染前调用：
 * URL 带 ?sso=<base64 会话>（枢纽登录后的回跳）时，解码写入本地 localStorage。
 */
export function consumeSsoOnBoot(): void {
    if (!hasWindow()) return;
    const raw = takeUrlParam("sso");
    if (!raw) return;
    try {
        const s = JSON.parse(b64Decode(raw)) as SsoSession;
        if (s?.token && s.address) writeSession(s);
    } catch {
        /* 解码失败 → 回退正常登录流程 */
    }
}
