// src/gemini.ts

import fs from "node:fs";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const GEMINI_MCP_URL = process.env.GEMINI_MCP_URL;
const GEMINI_MCP_TOKEN = process.env.GEMINI_MCP_TOKEN;
const GEMINI_MCP_UPLOAD_URL = process.env.GEMINI_MCP_UPLOAD_URL;

if (!GEMINI_MCP_URL) {
  throw new Error("GEMINI_MCP_URL is required");
}

if (!GEMINI_MCP_TOKEN) {
  throw new Error("GEMINI_MCP_TOKEN is required");
}

console.log("GEMINI_MCP_URL:", GEMINI_MCP_URL);
console.log("GEMINI_MCP_TOKEN exists:", Boolean(GEMINI_MCP_TOKEN));

let client: Client | null = null;
let connectingPromise: Promise<Client> | null = null;

/**
 * Devuelve un cliente MCP conectado a gemini-mcp.
 *
 * El propio SDK se encarga de:
 * - initialize
 * - notifications/initialized
 * - Mcp-Session-Id
 * - tools/call
 */
async function getClient(): Promise<Client> {
  if (client) {
    return client;
  }

  /*
   * Evita abrir dos sesiones simultáneamente si LibreChat
   * ejecuta dos llamadas casi al mismo tiempo.
   */
  if (connectingPromise) {
    return connectingPromise;
  }

  connectingPromise = (async () => {
    console.log("Connecting to Gemini MCP:", GEMINI_MCP_URL);

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

    console.log("Connected to Gemini MCP");

    client = newClient;

    return newClient;
  })();

  try {
    return await connectingPromise;
  } finally {
    connectingPromise = null;
  }
}

/**
 * Ejecuta una tool del gemini-mcp.
 */
export async function callGeminiTool(
  name: string,
  args: Record<string, unknown>,
) {
  const mcp = await getClient();

  console.log(`Calling Gemini MCP tool: ${name}`);

  try {
    return await mcp.callTool({
      name,
      arguments: args,
    });
  } catch (error) {
    console.error(`Gemini MCP tool "${name}" failed:`, error);

    /*
     * Si la sesión se ha quedado inválida,
     * descartamos el cliente para que la siguiente
     * llamada cree una sesión nueva.
     */
    client = null;

    throw error;
  }
}

/**
 * Sube un fichero local al sistema de uploads
 * utilizado por gemini-mcp.
 *
 * Flujo:
 *
 * 1. llama a upload_media
 * 2. obtiene las instrucciones/token temporal
 * 3. POST /upload
 * 4. obtiene object_key
 */
export async function uploadToGeminiMcp(filePath: string) {
  if (!GEMINI_MCP_UPLOAD_URL) {
    throw new Error("GEMINI_MCP_UPLOAD_URL is required");
  }

  console.log("Requesting upload instructions for:", path.basename(filePath));

  const instructions = await callGeminiTool("upload_media", {});

  const content = instructions.content;

  const text = Array.isArray(content)
    ? (content.find((item: any) => item.type === "text")?.text ?? "")
    : "";

  console.log("upload_media response:", text);

  /*
   * Importante:
   *
   * Este regex depende del formato exacto que
   * devuelve tu versión de gemini-mcp.
   *
   * Cuando probemos upload_media por primera vez,
   * veremos el texto real y podemos ajustarlo
   * si fuera necesario.
   */
  const tokenMatch = text.match(/token["'\s:=]+([A-Za-z0-9._-]+)/i);

  if (!tokenMatch) {
    throw new Error(
      `Could not extract upload token from upload_media response: ${text}`,
    );
  }

  const uploadToken = tokenMatch[1];

  const data = await fs.promises.readFile(filePath);

  console.log("Uploading file to Gemini MCP:", path.basename(filePath));

  const response = await fetch(GEMINI_MCP_UPLOAD_URL, {
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
    throw new Error(
      `Gemini MCP upload failed ${response.status}: ${responseText}`,
    );
  }

  let result: any;

  try {
    result = JSON.parse(responseText);
  } catch {
    throw new Error(`Gemini MCP upload returned invalid JSON: ${responseText}`);
  }

  if (!result.object_key) {
    throw new Error(
      `Gemini MCP upload did not return object_key: ${responseText}`,
    );
  }

  console.log("Gemini MCP upload completed:", result.object_key);

  return result.object_key;
}
