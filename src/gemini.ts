// src/gemini.ts

import fs from "node:fs";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const GEMINI_MCP_URL = process.env.GEMINI_MCP_URL;
const GEMINI_MCP_TOKEN = process.env.GEMINI_MCP_TOKEN;

if (!GEMINI_MCP_URL) {
  throw new Error("GEMINI_MCP_URL is required");
}

console.log("GEMINI_MCP_URL:", GEMINI_MCP_URL);
console.log("GEMINI_MCP_TOKEN exists:", Boolean(GEMINI_MCP_TOKEN));

let client: Client | null = null;

async function getClient(): Promise<Client> {
  if (client) {
    return client;
  }

  const transport = new StreamableHTTPClientTransport(new URL(GEMINI_MCP_URL), {
    authProvider: GEMINI_MCP_TOKEN
      ? {
          token: async () => GEMINI_MCP_TOKEN,
        }
      : undefined,
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

  return newClient;
}

export async function callGeminiTool(
  name: string,
  args: Record<string, unknown>,
) {
  const mcp = await getClient();

  console.log(`Calling Gemini MCP tool: ${name}`);

  return await mcp.callTool({
    name,
    arguments: args,
  });
}

export async function uploadToGeminiMcp(filePath: string) {
  const instructions = await callGeminiTool("upload_media", {});

  const content = instructions.content;

  const text = Array.isArray(content)
    ? (content.find((item: any) => item.type === "text")?.text ?? "")
    : "";

  console.log("upload_media response:", text);

  const tokenMatch = text.match(/token["\s:=]+([^\s"]+)/i);

  if (!tokenMatch) {
    throw new Error(`No pude obtener upload token de upload_media: ${text}`);
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

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Gemini MCP upload failed ${response.status}: ${errorText}`,
    );
  }

  const result = (await response.json()) as {
    object_key?: string;
  };

  if (!result.object_key) {
    throw new Error(
      `Upload response did not contain object_key: ${JSON.stringify(result)}`,
    );
  }

  return result.object_key;
}
