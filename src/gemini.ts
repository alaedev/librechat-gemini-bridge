// src/gemini.ts

const GEMINI_MCP_URL = process.env.GEMINI_MCP_URL!;
const GEMINI_MCP_TOKEN = process.env.GEMINI_MCP_TOKEN!;

console.log("ENV GEMINI_MCP_URL =", process.env.GEMINI_MCP_URL);

let rpcId = 1;

async function rpc(method: string, params: any = {}) {
  const response = await fetch(GEMINI_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GEMINI_MCP_TOKEN}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId++,
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Gemini MCP error ${response.status}: ${await response.text()}`,
    );
  }

  const json = await response.json();

  if (json.error) {
    throw new Error(json.error.message);
  }

  return json.result;
}

export async function callGeminiTool(
  name: string,
  args: Record<string, unknown>,
) {
  return rpc("tools/call", {
    name,
    arguments: args,
  });
}

// src/gemini.ts
// continuación

import fs from "node:fs";
import path from "node:path";

export async function uploadToGeminiMcp(filePath: string) {
  const instructions = await callGeminiTool("upload_media", {});

  /*
   * IMPORTANTE:
   *
   * Aquí tenemos que extraer de la respuesta real:
   *
   * - upload URL
   * - one-time token
   *
   * La forma concreta depende de cómo lo esté devolviendo
   * actualmente tu versión de holocode-ai/gemini-mcp.
   */

  const text =
    instructions.content?.find((item: any) => item.type === "text")?.text ?? "";

  const tokenMatch = text.match(/token["\s:=]+([^\s"]+)/i);

  if (!tokenMatch) {
    throw new Error(`No pude obtener upload token: ${text}`);
  }

  const uploadToken = tokenMatch[1];

  const uploadUrl = process.env.GEMINI_MCP_UPLOAD_URL!;

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

  if (!response.ok) {
    throw new Error(`Upload failed: ${await response.text()}`);
  }

  const result = await response.json();

  return result.object_key;
}
