import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import express from "express";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { z } from "zod";

import {
  downloadUserImage,
  listRecentUserImages,
  resolveUserImage,
} from "./s3.js";

import { callGeminiTool, uploadToGeminiMcp } from "./gemini.js";

type LibreChatContext = {
  userId: string;
};

const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;

if (!BRIDGE_TOKEN) {
  throw new Error("BRIDGE_TOKEN is required");
}

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function extensionFromFilename(filename: string) {
  const ext = path.extname(filename);

  return ext || ".png";
}

function createServer(context: LibreChatContext) {
  const server = new McpServer({
    name: "librechat-gemini-bridge",
    version: "1.0.0",
  });

  /*
   * =====================================
   * LIST RECENT IMAGES
   * =====================================
   *
   * Esta tool es importante.
   *
   * Permite al agente conocer los UUID
   * reales de las imágenes del usuario.
   */
  server.registerTool(
    "list_recent_images",
    {
      title: "List recent uploaded images",

      description:
        "List images recently uploaded by the current LibreChat user. Use this before edit_image or image_to_video when the user refers to an attached/uploaded image. Each image has a stable image_id. Never invent an image_id.",

      inputSchema: {
        limit: z.number().int().min(1).max(30).optional(),
      },
    },

    async ({ limit = 10 }) => {
      const images = await listRecentUserImages(context.userId, limit);

      return textResult({
        images: images.map((image, index) => ({
          index,
          image_id: image.imageId,

          filename: image.filename,

          uploaded_at: image.uploadedAt?.toISOString() ?? null,

          size: image.size,
        })),
      });
    },
  );

  /*
   * =====================================
   * GENERATE IMAGE
   * =====================================
   */
  server.registerTool(
    "generate_image",
    {
      title: "Generate image",

      description: "Generate a new image using Gemini.",

      inputSchema: {
        prompt: z.string(),

        aspect_ratio: z.string().optional(),
      },
    },

    async ({ prompt, aspect_ratio }) => {
      return (await callGeminiTool("gemini_image_generation", {
        prompt,
        ...(aspect_ratio
          ? {
              aspect_ratio,
            }
          : {}),
      })) as any;
    },
  );

  /*
   * =====================================
   * EDIT IMAGE
   * =====================================
   */
  server.registerTool(
    "edit_image",
    {
      title: "Edit uploaded image",

      description:
        "Edit an image uploaded by the current LibreChat user. First use list_recent_images and pass the exact image_id returned by that tool. Never invent an image_id, URL, S3 key or user ID.",

      inputSchema: {
        prompt: z.string(),

        image_id: z.string(),
      },
    },

    async ({ prompt, image_id }) => {
      const image = await resolveUserImage(context.userId, image_id);

      const tempPath = `/tmp/${crypto.randomUUID()}${extensionFromFilename(
        image.filename,
      )}`;

      console.log("[edit_image] image:", image.imageId);

      try {
        await downloadUserImage(context.userId, image_id, tempPath);

        const objectKey = await uploadToGeminiMcp(tempPath);

        return (await callGeminiTool("gemini_image_edit", {
          prompt,

          /*
           * En HTTP el MCP admite
           * el object_key obtenido
           * mediante upload_media.
           */
          image_path: objectKey,
        })) as any;
      } finally {
        await fs.unlink(tempPath).catch(() => {});
      }
    },
  );

  /*
   * =====================================
   * TEXT TO VIDEO
   * =====================================
   */
  server.registerTool(
    "generate_video",
    {
      title: "Generate video",

      description: "Generate a video from a text prompt using Veo.",

      inputSchema: {
        prompt: z.string(),

        negative_prompt: z.string().optional(),

        duration: z.enum(["4", "6", "8"]).optional(),

        aspect_ratio: z.enum(["16:9", "9:16"]).optional(),

        resolution: z.enum(["720p", "1080p"]).optional(),
      },
    },

    async ({ prompt, negative_prompt, duration, aspect_ratio, resolution }) => {
      return (await callGeminiTool("veo_text_to_video", {
        prompt,

        ...(negative_prompt
          ? {
              negative_prompt,
            }
          : {}),

        ...(duration
          ? {
              duration,
            }
          : {}),

        ...(aspect_ratio
          ? {
              aspect_ratio,
            }
          : {}),

        ...(resolution
          ? {
              resolution,
            }
          : {}),
      })) as any;
    },
  );

  /*
   * =====================================
   * IMAGE TO VIDEO
   * =====================================
   */
  server.registerTool(
    "image_to_video",
    {
      title: "Create video from uploaded image",

      description:
        "Animate an image uploaded by the current LibreChat user using Veo. ALWAYS call list_recent_images first and use the exact image_id returned by that tool. Never invent an image URL, S3 key, UUID, or user ID.",

      inputSchema: {
        prompt: z.string(),

        image_id: z.string(),

        negative_prompt: z.string().optional(),

        duration: z.enum(["4", "6", "8"]).optional(),

        aspect_ratio: z.enum(["16:9", "9:16"]).optional(),

        resolution: z.enum(["720p", "1080p"]).optional(),
      },
    },

    async ({
      prompt,
      image_id,
      negative_prompt,
      duration,
      aspect_ratio,
      resolution,
    }) => {
      console.log("[image_to_video] user:", context.userId);

      console.log("[image_to_video] image:", image_id);

      const image = await resolveUserImage(context.userId, image_id);

      const tempPath = `/tmp/${crypto.randomUUID()}${extensionFromFilename(
        image.filename,
      )}`;

      try {
        /*
         * 1. S3 LibreChat → /tmp
         */
        await downloadUserImage(context.userId, image_id, tempPath);

        console.log("[image_to_video] downloaded");

        /*
         * 2. /tmp → Gemini MCP storage
         */
        const objectKey = await uploadToGeminiMcp(tempPath);

        console.log("[image_to_video] Gemini object:", objectKey);

        /*
         * 3. Gemini object_key → Veo
         */
        return (await callGeminiTool("veo_image_to_video", {
          prompt,

          image_path: objectKey,

          ...(negative_prompt
            ? {
                negative_prompt,
              }
            : {}),

          ...(duration
            ? {
                duration,
              }
            : {}),

          ...(aspect_ratio
            ? {
                aspect_ratio,
              }
            : {}),

          ...(resolution
            ? {
                resolution,
              }
            : {}),
        })) as any;
      } finally {
        await fs.unlink(tempPath).catch(() => {});
      }
    },
  );

  return server;
}

/*
 * ==========================================
 * EXPRESS
 * ==========================================
 */

const app = express();

app.use(
  express.json({
    limit: "10mb",
  }),
);

app.get("/health", (_, res) => {
  res.json({
    status: "ok",
  });
});

app.post("/mcp", async (req, res) => {
  try {
    /*
     * Protege el bridge.
     *
     * No queremos que alguien llame
     * directamente y falsifique
     * X-LibreChat-User-Id.
     */
    const authorization = req.header("Authorization");

    if (authorization !== `Bearer ${BRIDGE_TOKEN}`) {
      console.warn("[MCP] Unauthorized request");

      return res.status(401).json({
        error: "Unauthorized",
      });
    }

    /*
     * Este valor NO lo genera el LLM.
     *
     * LibreChat lo introduce usando:
     *
     * {{LIBRECHAT_USER_ID}}
     */
    const userId = req.header("X-LibreChat-User-Id");

    if (!userId) {
      return res.status(400).json({
        error: "X-LibreChat-User-Id header is required",
      });
    }

    console.log("[MCP] LibreChat user:", userId);

    const server = createServer({
      userId,
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,

      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close();
    });

    await server.connect(transport);

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("[MCP] ERROR:", error);

    if (!res.headersSent) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
});

const port = Number(process.env.PORT) || 3000;

app.listen(port, () => {
  console.log(`LibreChat Gemini Bridge running on ${port}`);
});
