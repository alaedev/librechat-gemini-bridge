// src/index.ts

import express from "express";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { z } from "zod";

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { downloadLibreChatFile } from "./s3.js";

import { callGeminiTool, testGeminiAuth, uploadToGeminiMcp } from "./gemini.js";

function createServer() {
  const server = new McpServer({
    name: "librechat-gemini-bridge",
    version: "1.0.0",
  });

  server.registerTool(
    "generate_image",
    {
      title: "Generate image",
      description: "Test Gemini MCP",
      inputSchema: {
        prompt: z.string(),
      },
    },
    async () => {
      const result = await testGeminiAuth();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    },
  );

  server.registerTool(
    "edit_image",
    {
      title: "Edit uploaded image",
      description: "Edit an image uploaded to LibreChat using Gemini.",
      inputSchema: {
        prompt: z.string(),

        /*
         * Aquí LibreChat deberá suministrar
         * el object key de su propio bucket.
         */
        librechat_object_key: z.string(),
      },
    },

    async ({ prompt, librechat_object_key }) => {
      const id = crypto.randomUUID();

      const extension = path.extname(librechat_object_key) || ".jpg";

      const localPath = `/tmp/${id}${extension}`;

      try {
        // 1. S3 LibreChat -> /tmp
        await downloadLibreChatFile(librechat_object_key, localPath);

        // 2. /tmp -> Gemini MCP storage
        const geminiObjectKey = await uploadToGeminiMcp(localPath);

        // 3. editar
        const result = await callGeminiTool("gemini_image_edit", {
          prompt,

          /*
           * Según la implementación concreta
           * puede llamarse image_path/object_key.
           */
          image_path: geminiObjectKey,
        });

        return result;
      } finally {
        await fs.unlink(localPath).catch(() => {});
      }
    },
  );

  server.registerTool(
    "generate_video",
    {
      title: "Generate video",
      description: "Generate a video from text using Veo.",
      inputSchema: {
        prompt: z.string(),
        aspect_ratio: z.enum(["16:9", "9:16"]).optional(),

        resolution: z.enum(["720p", "1080p"]).optional(),

        duration: z.enum(["4", "6", "8"]).optional(),
      },
    },

    async ({ prompt, aspect_ratio, resolution, duration }) => {
      return callGeminiTool("veo_text_to_video", {
        prompt,
        aspect_ratio,
        resolution,
        duration,
      });
    },
  );

  server.registerTool(
    "image_to_video",
    {
      title: "Create video from uploaded image",
      description: "Animate an image uploaded to LibreChat using Veo.",
      inputSchema: {
        prompt: z.string(),
        librechat_object_key: z.string(),

        aspect_ratio: z.enum(["16:9", "9:16"]).optional(),

        resolution: z.enum(["720p", "1080p"]).optional(),
      },
    },

    async ({ prompt, librechat_object_key, aspect_ratio, resolution }) => {
      const id = crypto.randomUUID();

      const extension = path.extname(librechat_object_key) || ".jpg";

      const localPath = `/tmp/${id}${extension}`;

      try {
        await downloadLibreChatFile(librechat_object_key, localPath);

        const geminiObjectKey = await uploadToGeminiMcp(localPath);

        return await callGeminiTool("veo_image_to_video", {
          prompt,
          image_path: geminiObjectKey,
          aspect_ratio,
          resolution,
        });
      } finally {
        await fs.unlink(localPath).catch(() => {});
      }
    },
  );

  return server;
}

const app = express();

app.use(
  express.json({
    limit: "10mb",
  }),
);

app.post("/mcp", async (req, res) => {
  const server = createServer();

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    transport.close();
  });

  await server.connect(transport);

  await transport.handleRequest(req, res, req.body);
});

app.get("/health", (_, res) => {
  res.json({
    status: "ok",
  });
});

const port = Number(process.env.PORT) || 3000;

app.listen(port, () => {
  console.log(`LibreChat Gemini bridge running on ${port}`);
});
