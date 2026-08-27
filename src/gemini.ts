// src/gemini.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const GEMINI_MCP_URL = process.env.GEMINI_MCP_URL;
const GEMINI_MCP_TOKEN = process.env.GEMINI_MCP_TOKEN;

if (!GEMINI_MCP_URL) {
  throw new Error("GEMINI_MCP_URL is required");
}

if (!GEMINI_MCP_TOKEN) {
  throw new Error("GEMINI_MCP_TOKEN is required");
}

let client: Client | null = null;

async function getClient(): Promise<Client> {
  if (client) {
    return client;
  }

  console.log("Connecting to:", GEMINI_MCP_URL);
  console.log("Token exists:", Boolean(GEMINI_MCP_TOKEN));

  const transport = new StreamableHTTPClientTransport(new URL(GEMINI_MCP_URL), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${GEMINI_MCP_TOKEN}`,
      },
    },
  });

  const newClient = new Client(
    {
      name: "librechat-gemini-bridge",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  await newClient.connect(transport);

  console.log("Connected to Gemini MCP");

  client = newClient;

  return client;
}

export async function callGeminiTool(
  name: string,
  args: Record<string, unknown>,
) {
  const mcp = await getClient();

  return mcp.callTool({
    name,
    arguments: args,
  });
}
import fs from "node:fs";
import path from "node:path";

export async function uploadToGeminiMcp(filePath: string) {
  const instructions = await callGeminiTool("upload_media", {});

  const content = instructions.content;

  const text = Array.isArray(content)
    ? (content.find((item: any) => item.type === "text")?.text ?? "")
    : "";

  console.log("upload_media response:", text);

  const tokenMatch = text.match(/token["'\s:=]+([A-Za-z0-9._-]+)/i);

  if (!tokenMatch) {
    throw new Error(`No se pudo extraer el token de upload_media: ${text}`);
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
    throw new Error(`Respuesta no JSON del upload: ${responseText}`);
  }

  if (!result.object_key) {
    throw new Error(`El upload no devolvió object_key: ${responseText}`);
  }

  return result.object_key;
}
