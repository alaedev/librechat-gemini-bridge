import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type _Object,
} from "@aws-sdk/client-s3";

import fs from "node:fs";
import { pipeline } from "node:stream/promises";

const region = process.env.AWS_REGION;
const bucket = process.env.LIBRECHAT_S3_BUCKET;

if (!region) {
  throw new Error("AWS_REGION is required");
}

if (!bucket) {
  throw new Error("LIBRECHAT_S3_BUCKET is required");
}

const s3 = new S3Client({
  region,
});

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

export type LibreChatImage = {
  imageId: string;
  filename: string;
  key: string;
  uploadedAt: Date | null;
  size: number | null;
};

function isImage(key: string) {
  const lower = key.toLowerCase();

  return IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function parseObject(object: _Object): LibreChatImage | null {
  if (!object.Key) {
    return null;
  }

  if (!isImage(object.Key)) {
    return null;
  }

  const basename = object.Key.split("/").pop();

  if (!basename) {
    return null;
  }

  /*
   * LibreChat:
   *
   * UUID__original-filename.png
   */

  const separatorIndex = basename.indexOf("__");

  if (separatorIndex === -1) {
    return null;
  }

  const imageId = basename.substring(0, separatorIndex);

  const filename = basename.substring(separatorIndex + 2);

  if (!imageId || !filename) {
    return null;
  }

  return {
    imageId,
    filename,
    key: object.Key,
    uploadedAt: object.LastModified ?? null,
    size: object.Size ?? null,
  };
}

/**
 * Lista las imágenes más recientes de un usuario.
 *
 * S3 no permite ordenar directamente por LastModified,
 * así que paginamos y ordenamos nosotros.
 */
export async function listRecentUserImages(
  userId: string,
  limit = 20,
): Promise<LibreChatImage[]> {
  const prefix = `images/${userId}/`;

  let continuationToken: string | undefined;

  const objects: _Object[] = [];

  /*
   * Protección para no escanear infinitamente
   * una cuenta enorme.
   */
  const maxObjects = Number(process.env.MAX_S3_SCAN_OBJECTS ?? "5000");

  do {
    const result = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }),
    );

    if (result.Contents) {
      objects.push(...result.Contents);
    }

    continuationToken = result.IsTruncated
      ? result.NextContinuationToken
      : undefined;

    if (objects.length >= maxObjects) {
      break;
    }
  } while (continuationToken);

  const images = objects
    .map(parseObject)
    .filter((image): image is LibreChatImage => image !== null)
    .sort((a, b) => {
      const aTime = a.uploadedAt?.getTime() ?? 0;

      const bTime = b.uploadedAt?.getTime() ?? 0;

      return bTime - aTime;
    });

  return images.slice(0, limit);
}

/**
 * Resuelve un UUID real dentro del espacio
 * S3 del usuario.
 *
 * Nunca permite acceder al directorio
 * de otro usuario.
 */
export async function resolveUserImage(
  userId: string,
  imageId: string,
): Promise<LibreChatImage> {
  /*
   * Evitamos que alguien intente inyectar
   * paths arbitrarios.
   */
  if (!/^[a-zA-Z0-9-]+$/.test(imageId)) {
    throw new Error("Invalid image_id");
  }

  const prefix = `images/${userId}/${imageId}__`;

  console.log("[S3] Resolving:", prefix);

  const result = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      MaxKeys: 2,
    }),
  );

  const matches = (result.Contents ?? [])
    .map(parseObject)
    .filter((image): image is LibreChatImage => image !== null);

  if (matches.length === 0) {
    throw new Error(`Image not found: ${imageId}`);
  }

  if (matches.length > 1) {
    throw new Error(`Multiple images found for id ${imageId}`);
  }

  return matches[0];
}

export async function downloadUserImage(
  userId: string,
  imageId: string,
  destination: string,
) {
  const image = await resolveUserImage(userId, imageId);

  console.log("[S3] Downloading:", image.key);

  const result = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: image.key,
    }),
  );

  if (!result.Body) {
    throw new Error(`S3 object has no body: ${image.key}`);
  }

  await pipeline(
    result.Body as NodeJS.ReadableStream,
    fs.createWriteStream(destination),
  );

  return image;
}
