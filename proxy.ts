import { NextResponse, type NextRequest } from "next/server";
import {
  isApiRequestAllowed,
  isApiRequestHostAllowed,
} from "@/lib/request-security";
import { isAuthEnabled, verifyBearerToken } from "@/lib/auth-verify";

export async function proxy(request: NextRequest) {
  const isApiRequest = request.nextUrl.pathname === "/api"
    || request.nextUrl.pathname.startsWith("/api/");
  const isTrustedRequest = isApiRequest
    ? isApiRequestAllowed(request)
    : isApiRequestHostAllowed(request);

  if (!isTrustedRequest) {
    if (!isApiRequest) {
      return new NextResponse("Untrusted request", { status: 403 });
    }
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  // 统一认证（apps/auth :8008）：Bearer JWT 本地 JWKS 验签。
  // AUTH_URL 为空时直通（兼容未部署 auth 的环境，如 e2e）。
  if (isAuthEnabled()) {
    const user = await verifyBearerToken(request.headers.get("authorization"));
    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, {
        status: 401,
        headers: { "Cache-Control": "no-store" },
      });
    }
  }

  return NextResponse.next();
}

export const config = { matcher: ["/", "/api/:path*"] };
