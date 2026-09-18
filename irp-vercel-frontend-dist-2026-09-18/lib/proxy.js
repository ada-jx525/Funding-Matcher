const { authSettings } = require("./auth");

const UPSTREAM_TIMEOUT_MS = 55_000;
const MAX_REQUEST_BYTES = 32_768;
const MAX_JSON_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_CSV_RESPONSE_BYTES = 16 * 1024 * 1024;

class UpstreamResponseTooLarge extends Error {}
class UpstreamResponseInvalid extends Error {}

function send(response, status, body) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
  return response.status(status).json(body);
}

function upstreamBaseUrl(env = process.env) {
  if (env.VERCEL_ENV === "production") {
    const accessMode = env.APPLICATION_ACCESS_MODE || env.PILOT_ACCESS_MODE;
    if (!["deployment-protected", "public-authenticated"].includes(accessMode)) {
      return { error: "The production access policy has not been configured." };
    }
    if (accessMode === "public-authenticated" && !authSettings(env).configured) {
      return { error: "Public authentication is not fully configured." };
    }
  }
  const value = env.HYBRID_API_BASE_URL;
  if (!value) return { error: "The live matching service has not been configured." };

  let url;
  try {
    url = new URL(value);
  } catch {
    return { error: "The matching service URL is invalid.", status: 500 };
  }
  const localHttp = url.protocol === "http:"
    && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash) {
    return {
      error: "The matching service URL must not contain credentials, query parameters or fragments.",
      status: 500
    };
  }
  if (url.protocol !== "https:" && !localHttp) {
    return { error: "The matching service must use HTTPS.", status: 500 };
  }
  if (!localHttp && !env.HYBRID_API_TOKEN) {
    return { error: "The matching service authentication has not been configured." };
  }
  return { url };
}

async function readLimited(response, maximum) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    throw new UpstreamResponseTooLarge();
  }
  if (!response.body?.getReader) return null;

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maximum) throw new UpstreamResponseTooLarge();
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  } finally {
    if (total > maximum) await reader.cancel().catch(() => {});
  }
}

async function jsonBody(response) {
  const bytes = await readLimited(response, MAX_JSON_RESPONSE_BYTES);
  if (bytes === null) {
    try {
      return await response.json(); // Unit-test and legacy fetch mocks.
    } catch {
      throw new UpstreamResponseInvalid();
    }
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new UpstreamResponseInvalid();
  }
}

async function proxy(
  request,
  response,
  path,
  { methods, timeoutMs = UPSTREAM_TIMEOUT_MS, principal = null }
) {
  if (!methods.includes(request.method)) {
    response.setHeader("Allow", methods.join(", "));
    return send(response, 405, { error: "Method not allowed." });
  }

  const upstream = upstreamBaseUrl();
  if (!upstream.url) return send(response, upstream.status || 503, { error: upstream.error });
  const upstreamBase = upstream.url;

  const encodedBody = request.method === "GET"
    ? undefined
    : JSON.stringify(request.body || {});
  if (encodedBody && Buffer.byteLength(encodedBody, "utf8") > MAX_REQUEST_BYTES) {
    return send(response, 413, { error: "Request body must not exceed 32 KB." });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstreamResponse = await fetch(`${upstreamBase.href.replace(/\/$/, "")}${path}`, {
      method: request.method,
      headers: {
        Accept: "application/json",
        ...(request.method !== "GET" ? { "Content-Type": "application/json" } : {}),
        ...(process.env.HYBRID_API_TOKEN
          ? { Authorization: `Bearer ${process.env.HYBRID_API_TOKEN}` }
          : {}),
        ...(principal ? {
          "X-Authenticated-User-Id": principal.userId,
          "X-Authenticated-User-Roles": principal.roles.join(",")
        } : {})
      },
      body: encodedBody,
      signal: controller.signal
    });
    if (upstreamResponse.status === 204) {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      return response.status(204).send("");
    }
    const body = await jsonBody(upstreamResponse);
    return send(response, upstreamResponse.status, body);
  } catch (error) {
    if (error instanceof UpstreamResponseTooLarge) {
      return send(response, 502, { error: "The matching service returned too much data." });
    }
    if (error instanceof UpstreamResponseInvalid) {
      return send(response, 502, { error: "The matching service returned an unreadable response." });
    }
    const message = error.name === "AbortError"
      ? "The matching service timed out."
      : "The matching service is currently unavailable.";
    return send(response, 502, { error: message });
  } finally {
    clearTimeout(timer);
  }
}

async function proxyDownload(request, response, path, principal) {
  const upstream = upstreamBaseUrl();
  if (!upstream.url || !process.env.HYBRID_API_TOKEN) {
    return send(response, upstream.status || 503, {
      error: upstream.error || "The authenticated matching service is not configured."
    });
  }
  const upstreamBase = upstream.url;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstreamResponse = await fetch(`${upstreamBase.href.replace(/\/$/, "")}${path}`, {
      method: "GET",
      headers: {
        Accept: "text/csv",
        Authorization: `Bearer ${process.env.HYBRID_API_TOKEN}`,
        "X-Authenticated-User-Id": principal.userId,
        "X-Authenticated-User-Roles": principal.roles.join(",")
      },
      signal: controller.signal
    });
    if (!upstreamResponse.ok) {
      const body = await jsonBody(upstreamResponse);
      return send(response, upstreamResponse.status, {
        error: body.error || "The profile export could not be prepared."
      });
    }
    const contentType = upstreamResponse.headers.get("content-type") || "";
    if (!contentType.toLowerCase().startsWith("text/csv")) {
      return send(response, 502, { error: "The profile export returned an unexpected format." });
    }
    const body = await readLimited(upstreamResponse, MAX_CSV_RESPONSE_BYTES);
    if (body === null) {
      return send(response, 502, { error: "The profile export returned an unreadable response." });
    }
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/csv; charset=utf-8");
    response.setHeader(
      "Content-Disposition",
      'attachment; filename="opportunity-atlas-profiles.csv"'
    );
    response.setHeader("X-Content-Type-Options", "nosniff");
    return response.status(200).send(body);
  } catch (error) {
    if (error instanceof UpstreamResponseTooLarge) {
      return send(response, 502, { error: "The profile export is too large to download safely." });
    }
    if (error instanceof UpstreamResponseInvalid) {
      return send(response, 502, { error: "The matching service returned an unreadable response." });
    }
    const message = error.name === "AbortError"
      ? "The matching service timed out."
      : "The matching service is currently unavailable.";
    return send(response, 502, { error: message });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { proxy, proxyDownload, send, upstreamBaseUrl };
