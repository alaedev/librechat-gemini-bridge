import fs from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const GEMINI_MCP_URL = process.env.GEMINI_MCP_URL;

const GEMINI_MCP_UPLOAD_URL = process.env.GEMINI_MCP_UPLOAD_URL;

const GEMINI_MCP_TOKEN = process.env.GEMINI_MCP_TOKEN;

if (!GEMINI_MCP_URL) {
  throw new Error("GEMINI_MCP_URL is required");
}

if (!GEMINI_MCP_UPLOAD_URL) {
  throw new Error("GEMINI_MCP_UPLOAD_URL is required");
}

if (!GEMINI_MCP_TOKEN) {
  throw new Error("GEMINI_MCP_TOKEN is required");
}

let client: Client | null = null;

let connectingPromise: Promise<Client> | null = null;

async function getClient(): Promise<Client> {
  if (client) {
    return client;
  }

  if (connectingPromise) {
    return connectingPromise;
  }

  connectingPromise = (async () => {
    console.log("[Gemini MCP] Connecting:", GEMINI_MCP_URL);

    const transport = new StreamableHTTPClientTransport(
      new URL(GEMINI_MCP_URL),
      {
        requestInit: {
          headers: {
            Authorization: `Bearer ${GEMINI_MCP_TOKEN}`,
          },
        },
      },
    );

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

    console.log("[Gemini MCP] Connected");

    client = newClient;

    return newClient;
  })();

  try {
    return await connectingPromise;
  } finally {
    connectingPromise = null;
  }
}

export async function callGeminiTool(
  name: string,
  args: Record<string, unknown>,
) {
  const mcp = await getClient();

  console.log("[Gemini MCP] Calling:", name);

  try {
    return await mcp.callTool({
      name,
      arguments: args,
    });
  } catch (error) {
    console.error(`[Gemini MCP] ${name} failed:`, error);

    /*
     * Fuerza una sesión nueva
     * en la siguiente llamada.
     */
    client = null;

    throw error;
  }
}

function getTextFromToolResult(result: any): string {
  if (!Array.isArray(result?.content)) {
    return "";
  }

  return result.content
    .filter((item: any) => item?.type === "text")
    .map((item: any) => item.text ?? "")
    .join("\n");
}

function extractUploadToken(text: string): string {
  /*
   * Forma más probable:
   *
   * upload_media
   *   --token "xxxxx"
   */

  const cliMatch = text.match(/--token\s+["']?([^"'\s]+)["']?/i);

  if (cliMatch?.[1]) {
    return cliMatch[1];
  }

  /*
   * Fallbacks por si cambia el texto.
   */

  const tokenMatch = text.match(
    /(?:upload[_ -]?token|token)["'\s:=]+([A-Za-z0-9._-]+)/i,
  );

  if (tokenMatch?.[1]) {
    return tokenMatch[1];
  }

  throw new Error(
    `Could not extract upload token from upload_media response: ${text}`,
  );
}

export async function uploadToGeminiMcp(filePath: string) {
  console.log("[Gemini Upload] Requesting upload token");

  /*
   * El MCP original genera
   * un token one-time.
   */
  const instructions = await callGeminiTool("upload_media", {});

  const text = getTextFromToolResult(instructions);

  const uploadToken = extractUploadToken(text);

  const data = await fs.readFile(filePath);

  const filename = path.basename(filePath);

  /*
   * IMPORTANTE:
   * el CLI oficial utiliza multipart/form-data
   * con field name "file".
   */
  const form = new FormData();

  form.append("file", new Blob([data]), filename);

  console.log("[Gemini Upload] Uploading:", filename);

  const response = await fetch(GEMINI_MCP_UPLOAD_URL, {
    method: "POST",

    headers: {
      Authorization: `Bearer ${uploadToken}`,
    },

    body: form,
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

  console.log("[Gemini Upload] object_key:", result.object_key);

  return result.object_key as string;
}
