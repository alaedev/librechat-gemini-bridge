import fs from "node:fs";
import path from "node:path";

const GEMINI_MCP_URL = process.env.GEMINI_MCP_URL;
const GEMINI_MCP_TOKEN = process.env.GEMINI_MCP_TOKEN;

if (!GEMINI_MCP_URL) {
  throw new Error("GEMINI_MCP_URL is required");
}

if (!GEMINI_MCP_TOKEN) {
  throw new Error("GEMINI_MCP_TOKEN is required");
}

let rpcId = 1;
let sessionId: string | null = null;
let initialized = false;

function getHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${GEMINI_MCP_TOKEN}`,
  };

  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }

  return headers;
}

export async function testGeminiAuth() {
  const response = await fetch(GEMINI_MCP_URL, {
    method: "POST",

    redirect: "manual",

    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${GEMINI_MCP_TOKEN}`,
    },

    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "auth-test",
      method: "tools/list",
      params: {},
    }),
  });

  const text = await response.text();

  console.log("STATUS:", response.status);
  console.log("URL:", response.url);
  console.log("REDIRECTED:", response.redirected);
  console.log("LOCATION:", response.headers.get("location"));
  console.log("BODY:", text);

  return {
    status: response.status,
    text,
  };
}

/**
 * Gemini MCP devuelve las respuestas normalmente como SSE:
 *
 * event: message
 * data: {"jsonrpc":"2.0", ...}
 *
 * Esta función soporta tanto SSE como JSON normal.
 */
function parseMcpResponse(text: string): any {
  const trimmed = text.trim();

  if (!trimmed) {
    return null;
  }

  // JSON normal
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }

  // SSE
  const dataLines = trimmed
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());

  if (!dataLines.length) {
    throw new Error(`Invalid MCP response: ${text}`);
  }

  // Nos interesa normalmente el último mensaje JSON válido.
  for (let i = dataLines.length - 1; i >= 0; i--) {
    const data = dataLines[i];

    if (!data || data === "[DONE]") {
      continue;
    }

    try {
      return JSON.parse(data);
    } catch {
      // seguimos buscando otra línea data:
    }
  }

  throw new Error(`Could not parse MCP SSE response: ${text}`);
}

async function postMcp(body: Record<string, unknown>, expectResponse = true) {
  const response = await fetch(GEMINI_MCP_URL!, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(body),
  });

  /*
   * El servidor puede entregarnos el session id
   * durante initialize.
   */
  const returnedSessionId =
    response.headers.get("mcp-session-id") ??
    response.headers.get("Mcp-Session-Id");

  if (returnedSessionId) {
    sessionId = returnedSessionId;

    console.log("Gemini MCP session established:", sessionId);
  }

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Gemini MCP error ${response.status}: ${text}`);
  }

  if (!expectResponse || !text.trim()) {
    return null;
  }

  const json = parseMcpResponse(text);

  if (json?.error) {
    throw new Error(`Gemini MCP RPC error: ${json.error.message}`);
  }

  return json;
}

async function initializeGeminiMcp() {
  if (initialized && sessionId) {
    return;
  }

  console.log("Initializing Gemini MCP...");

  const id = rpcId++;

  const result = await postMcp({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",

      capabilities: {},

      clientInfo: {
        name: "librechat-gemini-bridge",
        version: "1.0.0",
      },
    },
  });

  console.log("Gemini MCP initialized:", result?.result?.serverInfo ?? "OK");

  /*
   * MCP exige avisar al servidor de que
   * la inicialización se ha completado.
   */
  await postMcp(
    {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    },
    false,
  );

  initialized = true;

  console.log("Gemini MCP ready");
}

export async function callGeminiTool(
  name: string,
  args: Record<string, unknown>,
) {
  await initializeGeminiMcp();

  console.log(`Calling Gemini MCP tool: ${name}`);

  const id = rpcId++;

  try {
    const json = await postMcp({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name,
        arguments: args,
      },
    });

    return json.result;
  } catch (error: any) {
    /*
     * Si Railway/Gemini MCP ha perdido la sesión,
     * intentamos inicializar una nueva una vez.
     */
    const message = String(error?.message ?? error);

    if (message.includes("session") || message.includes("Session")) {
      console.warn("Gemini MCP session lost. Reinitializing...");

      sessionId = null;
      initialized = false;

      await initializeGeminiMcp();

      const retryId = rpcId++;

      const json = await postMcp({
        jsonrpc: "2.0",
        id: retryId,
        method: "tools/call",
        params: {
          name,
          arguments: args,
        },
      });

      return json.result;
    }

    throw error;
  }
}

/**
 * Upload de archivos para edición / image-to-video.
 *
 * Primero pedimos las instrucciones mediante upload_media
 * y después hacemos POST al endpoint /upload.
 */
export async function uploadToGeminiMcp(filePath: string) {
  const instructions = await callGeminiTool("upload_media", {});

  const content = instructions?.content;

  const text = Array.isArray(content)
    ? (content.find((item: any) => item.type === "text")?.text ?? "")
    : "";

  console.log("upload_media response:", text);

  /*
   * Lo ajustaremos si la respuesta real de
   * tu versión usa otro formato.
   */
  const tokenMatch = text.match(/token["'\s:=]+([A-Za-z0-9._-]+)/i);

  if (!tokenMatch) {
    throw new Error(`Could not extract upload token: ${text}`);
  }

  const uploadToken = tokenMatch[1];

  const uploadUrl = process.env.GEMINI_MCP_UPLOAD_URL;

  if (!uploadUrl) {
    throw new Error("GEMINI_MCP_UPLOAD_URL is required");
  }

  const data = await fs.promises.readFile(filePath);

  const response = await fetch(uploadUrl, {
    method: "POST",

    headers: {
      Authorization: `Bearer ${uploadToken}`,
      "Content-Type": "application/octet-stream",
      "X-Filename": path.basename(filePath),
    },

    body: data,
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`Gemini upload failed ${response.status}: ${responseText}`);
  }

  let result: any;

  try {
    result = JSON.parse(responseText);
  } catch {
    throw new Error(`Gemini upload returned invalid JSON: ${responseText}`);
  }

  if (!result.object_key) {
    throw new Error(`Gemini upload did not return object_key: ${responseText}`);
  }

  return result.object_key;
}
